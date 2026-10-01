//! Isolated baseline probe; this package is not linked into either client.
use blst::{blst_scalar, min_pk::{PublicKey, SecretKey, Signature}, BLST_ERROR};
use std::{collections::{BTreeSet, VecDeque}, time::Instant};

pub const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
pub const CAPACITY: usize = 512;

#[derive(Clone)]
pub struct Input {
    pub signature: Signature,
    // Constructed only after the same public-key validation used by Lighthouse's key cache.
    public_key: PublicKey,
    pub root: [u8; 32],
}

impl Input {
    pub fn new(signature: Signature, public_key: PublicKey, root: [u8; 32]) -> Result<Self, BLST_ERROR> {
        public_key.validate()?;
        Ok(Self { signature, public_key, root })
    }

    pub fn ordinary_verify(&self) -> bool {
        self.signature.verify(true, &self.root, DST, &[], &self.public_key, true)
            == BLST_ERROR::BLST_SUCCESS
    }
}

type CacheKey = ([u8; 32], [u8; 48], [u8; 96]);

#[derive(Default)]
pub struct SuccessCache {
    keys: BTreeSet<CacheKey>,
    order: VecDeque<CacheKey>,
}

impl SuccessCache {
    fn insert(&mut self, key: CacheKey) {
        if self.keys.insert(key) {
            self.order.push_back(key);
            if self.order.len() > CAPACITY {
                self.keys.remove(&self.order.pop_front().unwrap());
            }
        }
    }

    pub fn len(&self) -> usize { self.keys.len() }
}

#[derive(Default, Clone)]
pub struct Timings {
    pub randomizers_ns: u128,
    pub general_batch_with_subgroup_ns: u128,
    pub serialization_ns: u128,
    pub cache_insertion_ns: u128,
    pub total_ns: u128,
    // Separate diagnostic, excluded from total: the baseline already subgroup-checks in blst.
    pub subgroup_only_diagnostic_ns: u128,
}

fn randomizers(count: usize) -> Vec<blst_scalar> {
    (0..count).map(|_| {
        let mut value = 0u64;
        while value == 0 { value = rand::random(); }
        let words = [value, 0, 0, 0];
        let mut scalar = blst_scalar::default();
        // Identical to the current client helper: initialized four-word input and scalar output.
        unsafe { blst::blst_scalar_from_uint64(&mut scalar, words.as_ptr()); }
        scalar
    }).collect()
}

/// Current randomized general batch, including its per-signature subgroup checks.
/// There is deliberately no MSM/candidate implementation in this baseline package.
/// Mixed roots are supported by the unchanged general verifier.
pub fn baseline(inputs: &[Input], cache: &mut SuccessCache) -> (bool, Timings) {
    let started = Instant::now();
    let mut timings = Timings::default();
    if inputs.is_empty() || inputs.len() > CAPACITY { return (false, timings); }
    let messages: Vec<_> = inputs.iter().map(|i| i.root.as_slice()).collect();
    let public_keys: Vec<_> = inputs.iter().map(|i| &i.public_key).collect();
    let signatures: Vec<_> = inputs.iter().map(|i| &i.signature).collect();
    let timer = Instant::now();
    let coefficients = randomizers(inputs.len());
    timings.randomizers_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    let valid = Signature::verify_multiple_aggregate_signatures(
        &messages, DST, &public_keys, false, &signatures, true, &coefficients, 64,
    ) == BLST_ERROR::BLST_SUCCESS;
    timings.general_batch_with_subgroup_ns = timer.elapsed().as_nanos();
    if valid {
        // Match production's interleaved serialization/insertion order. Timer overhead is present
        // in both baseline and future candidate and is included in the end-to-end total.
        for input in inputs {
            let timer = Instant::now();
            let key = (input.root, input.public_key.to_bytes(), input.signature.to_bytes());
            timings.serialization_ns += timer.elapsed().as_nanos();
            let timer = Instant::now();
            cache.insert(key);
            timings.cache_insertion_ns += timer.elapsed().as_nanos();
        }
    }
    timings.total_ns = started.elapsed().as_nanos();
    (valid, timings)
}

pub fn fixture(count: usize, root_id: u64) -> Vec<Input> {
    (0..count).map(|index| {
        let mut ikm = [42u8; 32];
        ikm[..8].copy_from_slice(&(index as u64 + 1).to_le_bytes());
        let secret = SecretKey::key_gen(&ikm, &[]).unwrap();
        let mut root = [0u8; 32];
        root[..8].copy_from_slice(&root_id.to_le_bytes());
        Input::new(secret.sign(&root, DST, &[]), secret.sk_to_pk(), root).unwrap()
    }).collect()
}

pub fn probe(inputs: &[Input], cache: &mut SuccessCache) -> Result<Timings, &'static str> {
    let (valid, mut timings) = baseline(inputs, cache);
    if !valid { return Err("a valid fixture failed baseline verification"); }
    let timer = Instant::now();
    for input in inputs {
        if input.signature.validate(false).is_err() { return Err("fixture subgroup check failed"); }
    }
    timings.subgroup_only_diagnostic_ns = timer.elapsed().as_nanos();
    Ok(timings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blst::min_pk::AggregateSignature;
    use rand::{RngCore, SeedableRng};

    fn check(inputs: &[Input], expected: bool) {
        assert_eq!(inputs.iter().all(Input::ordinary_verify), expected);
        let mut cache = SuccessCache::default();
        assert_eq!(baseline(inputs, &mut cache).0, expected);
        if !expected { assert_eq!(cache.len(), 0, "failed batches must not warm the cache"); }
    }

    fn sum(signatures: &[Signature]) -> Signature {
        AggregateSignature::aggregate(&signatures.iter().collect::<Vec<_>>(), true)
            .unwrap().to_signature()
    }

    #[test]
    fn genuine_signatures_1_2_64_512_match_individual_verification() {
        for count in [1, 2, 64, 512] { check(&fixture(count, 1), true); }
    }

    #[test]
    fn swapped_signer_signatures_fail_even_when_unweighted_sum_verifies() {
        let mut inputs = fixture(2, 2);
        let signature = inputs[0].signature;
        inputs[0].signature = inputs[1].signature;
        inputs[1].signature = signature;
        let aggregate = sum(&inputs.iter().map(|i| i.signature).collect::<Vec<_>>());
        assert_eq!(aggregate.fast_aggregate_verify(true, &inputs[0].root, DST,
            &inputs.iter().map(|i| &i.public_key).collect::<Vec<_>>()), BLST_ERROR::BLST_SUCCESS);
        check(&inputs, false);
    }

    #[test]
    fn two_compensating_wrong_signatures_fail_even_when_sum_is_unchanged() {
        let mut inputs = fixture(3, 3);
        let original_sum = sum(&[inputs[0].signature, inputs[1].signature]);
        let delta = inputs[2].signature;
        // Toggle the canonical compressed point's y-sign bit to obtain -delta. No secret math.
        let mut negative_bytes = delta.to_bytes();
        negative_bytes[0] ^= 0x20;
        let negative = Signature::from_bytes(&negative_bytes).unwrap();
        inputs[0].signature = sum(&[inputs[0].signature, delta]);
        inputs[1].signature = sum(&[inputs[1].signature, negative]);
        inputs.truncate(2);
        assert_eq!(sum(&[inputs[0].signature, inputs[1].signature]), original_sum);
        assert!(!inputs[0].ordinary_verify());
        assert!(!inputs[1].ordinary_verify());
        check(&inputs, false);
    }

    #[test]
    fn wrong_root_and_wrong_dst_fail() {
        let mut wrong_root = fixture(1, 4);
        wrong_root[0].root[31] ^= 1;
        check(&wrong_root, false);
        let secret = SecretKey::key_gen(&[11; 32], &[]).unwrap();
        let input = Input::new(secret.sign(&[9; 32], b"wrong-domain", &[]),
            secret.sk_to_pk(), [9; 32]).unwrap();
        check(&[input], false);
    }

    #[test]
    fn valid_mixed_roots_remain_supported_by_general_batch() {
        let mut inputs = fixture(2, 5);
        inputs.extend(fixture(2, 6));
        check(&inputs, true);
    }

    #[test]
    fn duplicate_public_key_cannot_hide_a_different_bad_signature() {
        let inputs = fixture(2, 7);
        check(&[inputs[0].clone(), inputs[0].clone()], true);
        let mut bad = inputs[0].clone();
        bad.signature = inputs[1].signature;
        check(&[inputs[0].clone(), bad], false);
    }

    #[test]
    fn corruption_at_every_batch_index_is_detected() {
        let good = fixture(64, 8);
        let bad = fixture(64, 9);
        for index in 0..64 {
            let mut inputs = good.clone();
            inputs[index].signature = bad[index].signature;
            assert!(!inputs[index].ordinary_verify());
            let mut cache = SuccessCache::default();
            assert!(!baseline(&inputs, &mut cache).0, "invalid input at index {index}");
            assert_eq!(cache.len(), 0);
        }
    }

    #[test]
    fn non_subgroup_signature_is_rejected_before_it_can_poison_cache() {
        let mut rng = rand::rngs::StdRng::from_seed([99; 32]);
        let torsion = (0..128).find_map(|_| {
            let mut bytes = [0u8; 96];
            rng.fill_bytes(&mut bytes);
            bytes[0] = (bytes[0] & 0x1f) | 0x80;
            bytes[48] &= 0x1f;
            Signature::from_bytes(&bytes).ok().filter(|sig| sig.validate(false).is_err())
        }).expect("deterministic on-curve non-subgroup fixture");
        let mut inputs = fixture(2, 10);
        inputs[1].signature = torsion;
        check(&inputs, false);
    }

    #[test]
    fn zero_empty_infinity_and_oversized_cases_fail() {
        let mut cache = SuccessCache::default();
        assert!(!baseline(&[], &mut cache).0);
        let input = fixture(1, 11).pop().unwrap();
        assert!(!baseline(&vec![input.clone(); CAPACITY + 1], &mut cache).0);
        assert!(Signature::from_bytes(&[0; 96]).is_err());
        let mut infinity_sig = [0; 96];
        infinity_sig[0] = 0xc0;
        let signature = Signature::from_bytes(&infinity_sig).unwrap();
        let mut invalid = input.clone();
        invalid.signature = signature;
        check(&[invalid], false);
        let mut infinity_pk = [0; 48];
        infinity_pk[0] = 0xc0;
        let public_key = PublicKey::from_bytes(&infinity_pk).unwrap();
        assert!(Input::new(signature, public_key, input.root).is_err());
        assert_ne!(signature.verify(true, &input.root, DST, &[], &public_key, true),
            BLST_ERROR::BLST_SUCCESS);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn fresh_randomizers_are_nonzero_u64_values() {
        let first = randomizers(64);
        let second = randomizers(64);
        for scalar in first.iter().chain(&second) {
            assert_ne!(&scalar.b[..8], &[0; 8]);
            assert_eq!(&scalar.b[8..], &[0; 24]);
        }
        assert!(first.iter().zip(&second).any(|(a, b)| a.b != b.b));
    }

    #[test]
    fn successful_cache_is_bounded_and_preserves_exact_inputs() {
        let mut cache = SuccessCache::default();
        for root in 0..9 { assert!(baseline(&fixture(64, root), &mut cache).0); }
        assert_eq!(cache.len(), CAPACITY);
        assert!(cache.keys.iter().all(|entry| entry.0[..8] != 0u64.to_le_bytes()));
    }
}
