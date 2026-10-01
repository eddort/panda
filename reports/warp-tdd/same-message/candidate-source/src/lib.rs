//! Isolated baseline/candidate probe; this package is not linked into either client.
use blst::{blst_scalar, min_pk::{AggregatePublicKey, AggregateSignature, PublicKey, SecretKey, Signature}, BLST_ERROR};
use std::{collections::{BTreeSet, VecDeque}, time::Instant};

pub const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
pub const CAPACITY: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Baseline, Candidate }

impl Mode {
    pub fn name(self) -> &'static str {
        match self { Self::Baseline => "baseline", Self::Candidate => "candidate" }
    }
}

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
    pub verification_with_subgroup_ns: u128,
    pub verification_path: &'static str,
    pub serialization_ns: u128,
    pub cache_insertion_ns: u128,
    pub total_ns: u128,
    // Separate diagnostic, excluded from total: both verifiers subgroup-check in blst.
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

/// blst's nbits=64 MSM uses an eight-byte stride, NOT the 32-byte blst_scalar layout.
fn packed_randomizers(coefficients: &[blst_scalar]) -> Vec<u8> {
    coefficients.iter().flat_map(|scalar| scalar.b[..8].iter().copied()).collect()
}

/// Some(result) is an MSM result; None requests the ordinary general-batch fallback.
/// Inputs carry validated public keys. No cache is populated here and no input is deduplicated.
fn same_root_msm(inputs: &[Input], packed: &[u8]) -> Option<bool> {
    if inputs.is_empty() || inputs.len() > CAPACITY || packed.len() != inputs.len() * 8 {
        return Some(false);
    }
    if packed.chunks_exact(8).any(|coefficient| coefficient == [0; 8]) {
        return Some(false);
    }
    if inputs.iter().any(|input| input.root != inputs[0].root) { return None; }

    let signatures: Vec<_> = inputs.iter().map(|input| input.signature).collect();
    let public_keys: Vec<_> = inputs.iter().map(|input| input.public_key).collect();
    // The safe wrapper individually validates ALL signature points before its weighted sum.
    // Checking only the resulting aggregate's subgroup would not be sufficient.
    let signature = match AggregateSignature::aggregate_with_randomness(&signatures, packed, 64, true) {
        Ok(aggregate) => aggregate.to_signature(),
        Err(_) => return Some(false),
    };
    let public_key = match AggregatePublicKey::aggregate_with_randomness(&public_keys, packed, 64, false) {
        Ok(aggregate) => aggregate.to_public_key(),
        Err(_) => return Some(false),
    };
    // Valid individual keys can very rarely produce a zero weighted sum. Ordinary batch
    // verification handles that case without rejecting genuine inputs or accepting infinity.
    if public_key.validate().is_err() { return None; }
    // Each individual signature was group-checked above; linear combination stays in the group.
    Some(signature.verify(false, &inputs[0].root, DST, &[], &public_key, false)
        == BLST_ERROR::BLST_SUCCESS)
}

/// RNG, canonical serialization and bounded-cache insertion are shared by both modes.
pub fn verify(mode: Mode, inputs: &[Input], cache: &mut SuccessCache) -> (bool, Timings) {
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
    let general = || Signature::verify_multiple_aggregate_signatures(
        &messages, DST, &public_keys, false, &signatures, true, &coefficients, 64,
    ) == BLST_ERROR::BLST_SUCCESS;
    let valid = match mode {
        Mode::Baseline => {
            timings.verification_path = "general";
            general()
        }
        Mode::Candidate => {
            if inputs.iter().any(|input| input.root != inputs[0].root) {
                timings.verification_path = "general_mixed_roots";
                general()
            } else {
                match same_root_msm(inputs, &packed_randomizers(&coefficients)) {
                    Some(valid) => {
                        timings.verification_path = "same_root_msm";
                        valid
                    }
                    None => {
                        timings.verification_path = "general_zero_aggregate_fallback";
                        general()
                    }
                }
            }
        }
    };
    timings.verification_with_subgroup_ns = timer.elapsed().as_nanos();
    if valid {
        // Match production's interleaved serialization/insertion order. Timer overhead is present
        // in both baseline and candidate and is included in the end-to-end total.
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

pub fn probe(mode: Mode, inputs: &[Input], cache: &mut SuccessCache) -> Result<Timings, &'static str> {
    let (valid, mut timings) = verify(mode, inputs, cache);
    if !valid { return Err("a valid fixture failed verification"); }
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
    use rand::{RngCore, SeedableRng};

    fn check(inputs: &[Input], expected: bool) {
        assert_eq!(inputs.iter().all(Input::ordinary_verify), expected);
        for mode in [Mode::Baseline, Mode::Candidate] {
            let mut cache = SuccessCache::default();
            assert_eq!(verify(mode, inputs, &mut cache).0, expected, "{mode:?}");
            if !expected { assert_eq!(cache.len(), 0, "failed batches must not warm the cache"); }
        }
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
        let (_, timings) = verify(Mode::Candidate, &inputs, &mut SuccessCache::default());
        assert_eq!(timings.verification_path, "general_mixed_roots");
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
            for mode in [Mode::Baseline, Mode::Candidate] {
                let mut cache = SuccessCache::default();
                assert!(!verify(mode, &inputs, &mut cache).0, "{mode:?}: invalid input at index {index}");
                assert_eq!(cache.len(), 0);
            }
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
        let input = fixture(1, 11).pop().unwrap();
        for mode in [Mode::Baseline, Mode::Candidate] {
            let mut cache = SuccessCache::default();
            assert!(!verify(mode, &[], &mut cache).0);
            assert!(!verify(mode, &vec![input.clone(); CAPACITY + 1], &mut cache).0);
            assert_eq!(cache.len(), 0);
        }
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
        let fixtures: Vec<_> = (0..9).map(|root| fixture(64, root)).collect();
        for mode in [Mode::Baseline, Mode::Candidate] {
            let mut cache = SuccessCache::default();
            for inputs in &fixtures { assert!(verify(mode, inputs, &mut cache).0); }
            assert_eq!(cache.len(), CAPACITY);
            assert!(cache.keys.iter().all(|entry| entry.0[..8] != 0u64.to_le_bytes()));
        }
    }

    #[test]
    fn msm_packing_is_exactly_eight_little_endian_bytes_per_input() {
        let coefficients = randomizers(64);
        let packed = packed_randomizers(&coefficients);
        assert_eq!(packed.len(), 64 * 8);
        for (bytes, coefficient) in packed.chunks_exact(8).zip(&coefficients) {
            assert_eq!(bytes, &coefficient.b[..8]);
            assert_ne!(u64::from_le_bytes(bytes.try_into().unwrap()), 0);
        }
        assert_eq!(same_root_msm(&fixture(64, 12), &packed), Some(true));
    }

    #[test]
    fn malformed_32_byte_stride_and_zero_coefficients_are_rejected() {
        let inputs = fixture(64, 13);
        let coefficients = randomizers(64);
        let bad_stride: Vec<_> = coefficients.iter().flat_map(|scalar| scalar.b).collect();
        assert_eq!(bad_stride.len(), 64 * 32);
        assert_eq!(same_root_msm(&inputs, &bad_stride), Some(false));
        // Truncation does not repair stride: it assigns zero weights to 3/4 of the inputs.
        assert_eq!(same_root_msm(&inputs, &bad_stride[..64 * 8]), Some(false));
        let packed = packed_randomizers(&coefficients);
        for index in 0..64 {
            let mut zero = packed.clone();
            zero[index * 8..(index + 1) * 8].fill(0);
            assert_eq!(same_root_msm(&inputs, &zero), Some(false), "zero weight at {index}");
        }
    }

    #[test]
    fn a_zero_weighted_public_key_requests_safe_general_fallback() {
        let first = fixture(1, 14).pop().unwrap();
        let mut public_bytes = first.public_key.to_bytes();
        public_bytes[0] ^= 0x20;
        let mut signature_bytes = first.signature.to_bytes();
        signature_bytes[0] ^= 0x20;
        let second = Input::new(Signature::from_bytes(&signature_bytes).unwrap(),
            PublicKey::from_bytes(&public_bytes).unwrap(), first.root).unwrap();
        let inputs = [first, second];
        check(&inputs, true);
        let packed: Vec<_> = [1u64, 1].iter().flat_map(|value| value.to_le_bytes()).collect();
        assert_eq!(same_root_msm(&inputs, &packed), None);
    }
}
