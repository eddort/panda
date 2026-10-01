#![deny(unsafe_code)]

use blst::{min_pk::{PublicKey, SecretKey, Signature}, BLST_ERROR};
use std::{sync::{mpsc, Arc}, time::Instant};
use threadpool::ThreadPool;

// Only this small wrapper may call the same two FFI primitives used by BLST's signer.
#[allow(unsafe_code)]
mod shared_hash;

pub const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
pub const MAX_KEYS: usize = 512;

// Caller-owned fixture material, modelling the existing keystore. No global key cache,
// secret serialization or secret aggregation exists here.
pub struct Key {
    secret: SecretKey,
    public: PublicKey,
}

pub fn fixture(count: usize) -> Result<Arc<Vec<Key>>, &'static str> {
    if count == 0 || count > MAX_KEYS { return Err("key count must be 1..=512"); }
    Ok(Arc::new((0..count).map(|index| {
        let mut ikm = [0x42; 32];
        ikm[..8].copy_from_slice(&(index as u64 + 1).to_le_bytes());
        let secret = SecretKey::key_gen(&ikm, &[]).expect("valid fixture key material");
        let public = secret.sk_to_pk();
        Key { secret, public }
    }).collect()))
}

#[derive(Clone)]
pub struct Context {
    pub root: [u8; 32],
    pub dst: Arc<[u8]>,
    pub augmentation: Arc<[u8]>,
}

impl Context {
    pub fn eth(root: [u8; 32]) -> Self {
        Self { root, dst: Arc::from(DST), augmentation: Arc::from([]) }
    }
}

pub fn root(series: u64, index: u64) -> [u8; 32] {
    let mut root = [0x73; 32];
    root[..8].copy_from_slice(&series.to_le_bytes());
    root[8..16].copy_from_slice(&index.to_le_bytes());
    root
}

pub enum Executor {
    Serial,
    // A persistent standard threadpool is a scheduling surrogate, NOT VC's Rayon/Tokio.
    Workers(ThreadPool),
}

impl Executor {
    pub fn workers(count: usize) -> Result<Self, &'static str> {
        if !(1..=2).contains(&count) { return Err("worker count must be 1 or 2"); }
        Ok(Self::Workers(ThreadPool::new(count)))
    }

    pub fn sign(&self, keys: &Arc<Vec<Key>>, context: &Context) -> Vec<Signature> {
        match self {
            Self::Serial => keys.iter().map(|key|
                key.secret.sign(&context.root, &context.dst, &context.augmentation)
            ).collect(),
            Self::Workers(pool) => {
                let (sender, receiver) = mpsc::channel();
                for index in 0..keys.len() {
                    let sender = sender.clone();
                    let keys = Arc::clone(keys);
                    let context = context.clone();
                    pool.execute(move || {
                        let signature = keys[index].secret.sign(
                            &context.root, &context.dst, &context.augmentation,
                        );
                        sender.send((index, signature)).expect("result receiver remains alive");
                    });
                }
                drop(sender);
                let mut output = vec![None; keys.len()];
                for (index, signature) in receiver {
                    assert!(output[index].replace(signature).is_none(), "duplicate signer result");
                }
                output.into_iter().map(|entry| entry.expect("missing signer result")).collect()
            }
        }
    }

    pub fn sign_shared_hash(&self, keys: &Arc<Vec<Key>>, context: &Context) -> Vec<Signature> {
        // ONE public hash per call, inside the measured batch; no persistent cache.
        let public_hash = shared_hash::PublicHash::new(context);
        match self {
            Self::Serial => keys.iter().map(|key| public_hash.sign(&key.secret)).collect(),
            Self::Workers(pool) => {
                let (sender, receiver) = mpsc::channel();
                for index in 0..keys.len() {
                    let sender = sender.clone();
                    let keys = Arc::clone(keys);
                    // This copies only a PUBLIC curve point. The actual key stays in the
                    // caller's current fixture and is borrowed only for this ordinary sign.
                    let point = public_hash;
                    pool.execute(move || {
                        let signature = point.sign(&keys[index].secret);
                        // Release the job's key reference BEFORE completion can be observed.
                        drop(keys);
                        sender.send((index, signature)).expect("result receiver remains alive");
                    });
                }
                drop(sender);
                let mut output = vec![None; keys.len()];
                for (index, signature) in receiver {
                    assert!(output[index].replace(signature).is_none(), "duplicate signer result");
                }
                output.into_iter().map(|entry| entry.expect("missing signer result")).collect()
            }
        }
    }
}

#[derive(Clone, Copy)]
pub enum Algorithm { Baseline, SharedHash }

pub struct Sample {
    pub signing_ns: u128,
    pub serialization_ns: u128,
    pub total_ns: u128,
    pub verification_ns: u128,
}

pub fn probe(executor: &Executor, keys: &Arc<Vec<Key>>, context: &Context)
    -> Result<Sample, &'static str>
{
    probe_mode(executor, keys, context, Algorithm::Baseline)
}

pub fn probe_mode(executor: &Executor, keys: &Arc<Vec<Key>>, context: &Context, algorithm: Algorithm)
    -> Result<Sample, &'static str>
{
    let total_start = Instant::now();
    let signing_start = Instant::now();
    let signatures = match algorithm {
        Algorithm::Baseline => executor.sign(keys, context),
        Algorithm::SharedHash => executor.sign_shared_hash(keys, context),
    };
    let signing_ns = signing_start.elapsed().as_nanos();
    let serialization_start = Instant::now();
    let bytes: Vec<_> = signatures.iter().map(Signature::to_bytes).collect();
    std::hint::black_box(&bytes);
    let serialization_ns = serialization_start.elapsed().as_nanos();
    let total_ns = total_start.elapsed().as_nanos();

    // Verify EVERY timed signature with the unchanged public API, outside the signing timer.
    let verification_start = Instant::now();
    for (key, signature) in keys.iter().zip(&signatures) {
        if signature.verify(true, &context.root, &context.dst, &context.augmentation,
            &key.public, true) != BLST_ERROR::BLST_SUCCESS
        {
            return Err("ordinary BLS verification rejected a measured signature");
        }
    }
    Ok(Sample { signing_ns, serialization_ns, total_ns,
        verification_ns: verification_start.elapsed().as_nanos() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_signatures_are_valid_for_every_size() {
        for count in [1, 2, 64, 512] {
            let keys = fixture(count).unwrap();
            assert_eq!(keys.iter().map(|key| key.public.to_bytes())
                .collect::<std::collections::BTreeSet<_>>().len(), count);
            probe(&Executor::Serial, &keys, &Context::eth(root(1, count as u64))).unwrap();
        }
    }

    #[test]
    fn worker_results_match_ordinary_bytes_for_every_key_and_context() {
        let one = Executor::workers(1).unwrap();
        let two = Executor::workers(2).unwrap();
        for count in [1, 2, 64, 512] {
            let keys = fixture(count).unwrap();
            let original = Context::eth(root(2, count as u64));
            let mut changed_dst = original.clone();
            changed_dst.dst = Arc::from(b"different-ciphersuite-domain".as_slice());
            let mut changed_aug = original.clone();
            changed_aug.augmentation = Arc::from(b"public-augmentation".as_slice());
            for context in [original.clone(), Context::eth(root(3, count as u64)),
                changed_dst, changed_aug, original]
            {
                let expected: Vec<_> = Executor::Serial.sign(&keys, &context)
                    .iter().map(Signature::to_bytes).collect();
                for executor in [&one, &two] {
                    let actual: Vec<_> = executor.sign(&keys, &context)
                        .iter().map(Signature::to_bytes).collect();
                    assert_eq!(actual, expected);
                }
            }
        }
    }

    #[test]
    fn public_key_root_dst_and_augmentation_are_binding() {
        let keys = fixture(2).unwrap();
        let context = Context::eth(root(4, 0));
        let signatures = Executor::Serial.sign(&keys, &context);
        let signature = &signatures[0];
        for (message, dst, augmentation, key) in [
            (context.root, DST, &[][..], &keys[1].public),
            (root(4, 1), DST, &[][..], &keys[0].public),
            (context.root, b"another-domain".as_slice(), &[][..], &keys[0].public),
            (context.root, DST, b"augmentation".as_slice(), &keys[0].public),
        ] {
            assert_ne!(signature.verify(true, &message, dst, augmentation, key, true),
                BLST_ERROR::BLST_SUCCESS);
        }
    }

    #[test]
    fn fixture_and_worker_bounds_are_explicit() {
        assert!(fixture(0).is_err());
        assert!(fixture(513).is_err());
        assert!(Executor::workers(0).is_err());
        assert!(Executor::workers(3).is_err());
    }

    #[test]
    fn shared_hash_is_byte_identical_and_verifies_for_every_size_executor_and_context() {
        let serial = Executor::Serial;
        let one = Executor::workers(1).unwrap();
        let two = Executor::workers(2).unwrap();
        for count in [1, 2, 64, 512] {
            let keys = fixture(count).unwrap();
            let original = Context::eth(root(5, count as u64));
            let mut changed_dst = original.clone();
            changed_dst.dst = Arc::from(b"different-domain".as_slice());
            let mut changed_aug = original.clone();
            changed_aug.augmentation = Arc::from(b"different-augmentation".as_slice());
            for context in [original.clone(), Context::eth(root(6, count as u64)),
                changed_dst, changed_aug, original]
            {
                let expected: Vec<_> = serial.sign(&keys, &context)
                    .iter().map(Signature::to_bytes).collect();
                for executor in [&serial, &one, &two] {
                    let actual = executor.sign_shared_hash(&keys, &context);
                    assert_eq!(actual.iter().map(Signature::to_bytes).collect::<Vec<_>>(), expected);
                    for (signature, key) in actual.iter().zip(keys.iter()) {
                        assert_eq!(signature.verify(true, &context.root, &context.dst,
                            &context.augmentation, &key.public, true), BLST_ERROR::BLST_SUCCESS);
                    }
                }
            }
        }
    }

    #[test]
    fn concurrent_calls_do_not_mix_roots_dst_or_augmentation() {
        let executor = Executor::workers(2).unwrap();
        let keys = fixture(64).unwrap();
        let contexts: Vec<_> = (0..4).map(|index| {
            let mut context = Context::eth(root(7, index));
            context.dst = Arc::from(format!("domain-{index}").into_bytes());
            context.augmentation = Arc::from(format!("augmentation-{index}").into_bytes());
            context
        }).collect();
        std::thread::scope(|scope| {
            let jobs: Vec<_> = contexts.iter().map(|context| {
                let executor = &executor;
                let keys = &keys;
                scope.spawn(move || executor.sign_shared_hash(keys, context))
            }).collect();
            for (job, context) in jobs.into_iter().zip(&contexts) {
                let expected: Vec<_> = Executor::Serial.sign(&keys, context)
                    .iter().map(Signature::to_bytes).collect();
                assert_eq!(job.join().unwrap().iter().map(Signature::to_bytes)
                    .collect::<Vec<_>>(), expected);
            }
        });
    }

    #[test]
    fn no_key_material_is_retained_after_a_candidate_call() {
        let executor = Executor::workers(2).unwrap();
        let context = Context::eth(root(8, 0));
        let keys = fixture(64).unwrap();
        let weak = Arc::downgrade(&keys);
        let first = executor.sign_shared_hash(&keys, &context);
        assert_eq!(Arc::strong_count(&keys), 1);
        drop(keys);
        assert!(weak.upgrade().is_none());

        let secret = SecretKey::key_gen(&[0x55; 32], &[]).unwrap();
        let public = secret.sk_to_pk();
        let replacement = Arc::new(vec![Key { secret, public }]);
        let next = executor.sign_shared_hash(&replacement, &context);
        assert_ne!(next[0].to_bytes(), first[0].to_bytes());
        assert_eq!(next[0].to_bytes(), Executor::Serial.sign(&replacement, &context)[0].to_bytes());
    }
}
