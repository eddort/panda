//! Reuse successful verification of byte-identical single-key BLS inputs in a controlled devnet.
use super::DST;
use blst::{
    min_pk::{PublicKey, Signature},
    BLST_ERROR,
};
use std::{
    collections::{BTreeSet, VecDeque},
    sync::Mutex,
};
const CAPACITY: usize = 512;
type Input = ([u8; 32], [u8; 48], [u8; 96]);

#[derive(Default)]
struct Successes {
    keys: BTreeSet<Input>,
    order: VecDeque<Input>,
}

#[derive(Default)]
pub struct Verifier {
    successes: Mutex<Successes>,
    #[cfg(test)]
    checks: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    batches: std::sync::atomic::AtomicUsize,
}

impl Verifier {
    pub fn verify_batch(&self, inputs: &[(Signature, PublicKey, [u8; 32])]) -> bool {
        if inputs.is_empty() || inputs.len() > CAPACITY {
            return false;
        }
        let messages: Vec<_> = inputs.iter().map(|input| input.2.as_slice()).collect();
        let public_keys: Vec<_> = inputs.iter().map(|input| &input.1).collect();
        let signatures: Vec<_> = inputs.iter().map(|input| &input.0).collect();
        // Match Lighthouse's existing randomized BLS batch verifier: independent, non-zero
        // 64-bit coefficients prevent invalid individual signatures cancelling each other.
        let randomizers: Vec<_> = inputs
            .iter()
            .map(|_| {
                let mut coefficient = 0u64;
                while coefficient == 0 {
                    coefficient = rand::random();
                }
                let words = [coefficient, 0, 0, 0];
                let mut scalar = blst::blst_scalar::default();
                // Both pointers address initialized values of the exact sizes required by blst.
                unsafe {
                    blst::blst_scalar_from_uint64(&mut scalar, words.as_ptr());
                }
                scalar
            })
            .collect();
        #[cfg(test)]
        self.batches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let valid = Signature::verify_multiple_aggregate_signatures(
            &messages,
            DST,
            &public_keys,
            false,
            &signatures,
            true,
            &randomizers,
            64,
        ) == BLST_ERROR::BLST_SUCCESS;
        if valid {
            for (signature, public_key, message) in inputs {
                self.remember((*message, public_key.to_bytes(), signature.to_bytes()));
            }
        }
        valid
    }

    fn remember(&self, input: Input) {
        let mut cache = self.successes.lock().expect("verified signature cache");
        if cache.keys.insert(input) {
            cache.order.push_back(input);
            if cache.order.len() > CAPACITY {
                let oldest = cache
                    .order
                    .pop_front()
                    .expect("nonempty verification cache");
                cache.keys.remove(&oldest);
            }
        }
    }

    pub fn verify(&self, signature: &Signature, pubkey: &PublicKey, message: [u8; 32]) -> bool {
        // Full canonical inputs, including the domain-bound signing root. No digest-only key.
        let input = (message, pubkey.to_bytes(), signature.to_bytes());
        if self
            .successes
            .lock()
            .expect("verified signature cache")
            .keys
            .contains(&input)
        {
            return true;
        }
        // Do not hold the cache mutex during cryptography: independent checks can run in parallel.
        #[cfg(test)]
        self.checks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let valid =
            signature.verify(true, &message, DST, &[], pubkey, false) == BLST_ERROR::BLST_SUCCESS;
        if valid {
            self.remember(input);
        }
        valid
    }
}

fn verifier() -> &'static Verifier {
    static VERIFIER: std::sync::OnceLock<Verifier> = std::sync::OnceLock::new();
    VERIFIER.get_or_init(Verifier::default)
}

pub fn verify(signature: &Signature, pubkey: &PublicKey, message: [u8; 32]) -> bool {
    verifier().verify(signature, pubkey, message)
}

pub fn verify_batch(inputs: &[(Signature, PublicKey, [u8; 32])]) -> bool {
    verifier().verify_batch(inputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blst::min_pk::SecretKey;
    use std::sync::atomic::Ordering;

    #[test]
    fn identical_subnet_messages_are_verified_once() {
        let verifier = Verifier::default();
        let secret = SecretKey::key_gen(&[42; 32], &[]).unwrap();
        let public = secret.sk_to_pk();
        let message = [7; 32];
        let signature = secret.sign(&message, DST, &[]);
        for _ in 0..4 {
            assert!(verifier.verify(&signature, &public, message));
        }
        assert_eq!(verifier.checks.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cached_success_cannot_accept_another_key_root_domain_or_signature() {
        let verifier = Verifier::default();
        let secret = SecretKey::key_gen(&[42; 32], &[]).unwrap();
        let other = SecretKey::key_gen(&[43; 32], &[]).unwrap();
        let message = [7; 32];
        let signature = secret.sign(&message, DST, &[]);
        assert!(verifier.verify(&signature, &secret.sk_to_pk(), message));
        assert!(!verifier.verify(&signature, &other.sk_to_pk(), message));
        assert!(!verifier.verify(&signature, &secret.sk_to_pk(), [8; 32]));
        assert!(!verifier.verify(&other.sign(&message, DST, &[]), &secret.sk_to_pk(), message));
        assert!(!verifier.verify(
            &secret.sign(&message, b"another-domain", &[]),
            &secret.sk_to_pk(),
            message
        ));
        // Invalid results must not populate a success entry on repeated submissions.
        for _ in 0..2 {
            assert!(!verifier.verify(&signature, &secret.sk_to_pk(), [8; 32]));
        }
        assert!(verifier.verify(&signature, &secret.sk_to_pk(), message));
    }

    #[test]
    fn old_successes_are_evicted_and_reverified() {
        let verifier = Verifier::default();
        let secret = SecretKey::key_gen(&[42; 32], &[]).unwrap();
        let public = secret.sk_to_pk();
        for index in 0..=CAPACITY {
            let mut root = [0; 32];
            root[..8].copy_from_slice(&(index as u64).to_le_bytes());
            assert!(verifier.verify(&secret.sign(&root, DST, &[]), &public, root));
        }
        let zero = [0; 32];
        let signature = secret.sign(&zero, DST, &[]);
        assert!(verifier.verify(&signature, &public, zero));
        assert!(verifier.verify(&signature, &public, zero));
        assert_eq!(verifier.checks.load(Ordering::Relaxed), CAPACITY + 2);
    }

    #[test]
    fn concurrent_lookups_do_not_cross_contaminate_messages() {
        let verifier = std::sync::Arc::new(Verifier::default());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let verifier = verifier.clone();
                std::thread::spawn(move || {
                    let secret = SecretKey::key_gen(&[42; 32], &[]).unwrap();
                    let public = secret.sk_to_pk();
                    let signature = secret.sign(&[7; 32], DST, &[]);
                    for _ in 0..10 {
                        assert!(verifier.verify(&signature, &public, [7; 32]));
                        assert!(!verifier.verify(&signature, &public, [8; 32]));
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    }
    fn inputs(count: u8) -> Vec<(Signature, PublicKey, [u8; 32])> {
        (1..=count)
            .map(|seed| {
                let secret = SecretKey::key_gen(&[seed; 32], &[]).unwrap();
                let message = [7; 32];
                (secret.sign(&message, DST, &[]), secret.sk_to_pk(), message)
            })
            .collect()
    }

    #[test]
    fn valid_batch_verifies_once_and_warms_only_identical_inputs() {
        let verifier = Verifier::default();
        let inputs = inputs(64);
        assert!(verifier.verify_batch(&inputs));
        for (signature, pubkey, root) in &inputs {
            assert!(verifier.verify(signature, pubkey, *root));
        }
        assert_eq!(verifier.batches.load(Ordering::Relaxed), 1);
        assert_eq!(verifier.checks.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn invalid_individual_signatures_cannot_cancel_inside_a_batch() {
        let verifier = Verifier::default();
        let mut inputs = inputs(2);
        let first = inputs[0].0;
        inputs[0].0 = inputs[1].0;
        inputs[1].0 = first;
        // The sum is unchanged, but each assigned public key is wrong. A deterministic
        // aggregate-only verification would accept; randomized batch verification must reject.
        assert!(!verifier.verify_batch(&inputs));
        for (signature, pubkey, root) in &inputs {
            assert!(!verifier.verify(signature, pubkey, *root));
        }
    }

    #[test]
    fn a_failed_batch_cannot_warm_even_its_valid_prefix() {
        let verifier = Verifier::default();
        let mut inputs = inputs(8);
        inputs[7].2 = [8; 32];
        assert!(!verifier.verify_batch(&inputs));
        let before = verifier.checks.load(Ordering::Relaxed);
        assert!(verifier.verify(&inputs[0].0, &inputs[0].1, inputs[0].2));
        assert_eq!(verifier.checks.load(Ordering::Relaxed), before + 1);
        assert!(!verifier.verify_batch(&[]));
    }
}
