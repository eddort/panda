//! Ordinary direct-sync cryptography only. No group-secret-key candidate is implemented.
use blst::{blst_scalar, min_pk::{AggregatePublicKey, AggregateSignature, PublicKey, SecretKey, Signature}, BLST_ERROR};
use rand::{Rng, SeedableRng};
use std::{collections::{BTreeMap, BTreeSet}, sync::{mpsc, Arc}, time::Instant};
use threadpool::ThreadPool;

pub const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

pub struct KeyRecord {
    secret: SecretKey,
    public: PublicKey,
}

impl KeyRecord {
    fn new(secret: SecretKey) -> Self {
        let public = secret.sk_to_pk();
        public.validate().expect("valid locally generated public key");
        Self { secret, public }
    }
}

pub type Registry = BTreeMap<usize, Arc<KeyRecord>>;

pub fn fixture_registry(count: usize) -> Registry {
    (0..count).map(|index| {
        let mut ikm = [42u8; 32];
        ikm[..8].copy_from_slice(&(index as u64 + 1).to_le_bytes());
        (index, Arc::new(KeyRecord::new(SecretKey::key_gen(&ikm, &[]).unwrap())))
    }).collect()
}

pub fn fixture_groups() -> Vec<Vec<usize>> {
    let mut rng = rand::rngs::StdRng::from_seed([73; 32]);
    // Guarantee all 64 signers are needed, then sample with replacement. Different subnets
    // have different multiplicities, avoiding the artificial case of four identical groups.
    let positions: Vec<_> = (0..512).map(|position| {
        if position < 64 { position } else { rng.random_range(0..64) }
    }).collect();
    positions.chunks(128).map(<[usize]>::to_vec).collect()
}

pub struct Committee {
    groups: Vec<Vec<usize>>,
    expected_public_keys: BTreeMap<usize, PublicKey>,
    aggregate_public_keys: Vec<PublicKey>,
    full_aggregate_public_key: PublicKey,
    pub public_key_aggregation_ns: u128,
}

impl Committee {
    /// Cold committee preparation: validate membership and compute PUBLIC aggregate-key cache.
    pub fn prepare(registry: &Registry, groups: Vec<Vec<usize>>) -> Result<Self, &'static str> {
        if groups.is_empty() || groups.iter().any(Vec::is_empty)
            || groups.iter().map(Vec::len).sum::<usize>() > 512 {
            return Err("empty or oversized committee request");
        }
        let mut expected_public_keys = BTreeMap::new();
        let mut aggregate_public_keys = Vec::new();
        let mut public_key_aggregation_ns = 0;
        for group in &groups {
            let mut public_keys = Vec::new();
            for id in group {
                let key = registry.get(id).ok_or("missing committee key")?;
                expected_public_keys.insert(*id, key.public);
                public_keys.push(&key.public);
            }
            let timer = Instant::now();
            aggregate_public_keys.push(AggregatePublicKey::aggregate(&public_keys, false)
                .map_err(|_| "cannot aggregate committee public keys")?.to_public_key());
            public_key_aggregation_ns += timer.elapsed().as_nanos();
        }
        let timer = Instant::now();
        let full_aggregate_public_key = AggregatePublicKey::aggregate(
            &aggregate_public_keys.iter().collect::<Vec<_>>(), false)
            .map_err(|_| "cannot aggregate full committee public key")?.to_public_key();
        public_key_aggregation_ns += timer.elapsed().as_nanos();
        Ok(Self { groups, expected_public_keys, aggregate_public_keys, full_aggregate_public_key, public_key_aggregation_ns })
    }

    /// Resolve every required CURRENT key before any signing job. Cached public keys alone
    /// cannot authorize signing with a key that was removed or replaced after preparation.
    fn snapshot(&self, registry: &Registry) -> Result<Vec<(usize, Arc<KeyRecord>)>, &'static str> {
        self.expected_public_keys.iter().map(|(id, expected)| {
            let key = registry.get(id).ok_or("required key is no longer live")?;
            if key.public != *expected { return Err("live key does not match committee public key"); }
            Ok((*id, Arc::clone(key)))
        }).collect()
    }
}

#[derive(Default)]
pub struct Timings {
    pub live_snapshot_ns: u128,
    pub individual_signing_ns: u128,
    pub signature_serialization_ns: u128,
    pub randomizers_ns: u128,
    pub general_message_verification_ns: u128,
    pub position_aggregation_ns: u128,
    pub public_key_cache_lookup_ns: u128,
    pub oracle_aggregate_verification_ns: u128,
    pub full_aggregate_oracle_ns: u128,
    pub total_ns: u128,
    pub signing_jobs: usize,
}

pub struct Output {
    pub aggregates: Vec<Signature>,
    pub full_aggregate: Signature,
    pub subnet_oracle_validity: Vec<bool>,
    pub timings: Timings,
}

fn randomizers(count: usize) -> Vec<blst_scalar> {
    (0..count).map(|_| {
        let mut coefficient = 0u64;
        while coefficient == 0 { coefficient = rand::random(); }
        let words = [coefficient, 0, 0, 0];
        let mut scalar = blst_scalar::default();
        // Same FFI call and independent nonzero u64 coefficients as the maintained helper.
        unsafe { blst::blst_scalar_from_uint64(&mut scalar, words.as_ptr()); }
        scalar
    }).collect()
}

/// Real individual signatures -> general randomized batch -> position-preserving aggregates
/// -> excluded ordinary BLS oracle checks with precomputed public keys. The fixed pool is shared across
/// requests, with one signing job per unique key, like the existing VC task granularity.
pub fn baseline(registry: &Registry, committee: &Committee, root: [u8; 32],
    pool: &ThreadPool) -> Result<Output, &'static str> {
    let started = Instant::now();
    let mut timings = Timings::default();
    let timer = Instant::now();
    let snapshot = committee.snapshot(registry)?;
    timings.live_snapshot_ns = timer.elapsed().as_nanos();
    timings.signing_jobs = snapshot.len();
    let timer = Instant::now();
    let (tx, rx) = mpsc::channel();
    for (id, key) in &snapshot {
        let id = *id;
        let key = Arc::clone(key);
        let tx = tx.clone();
        pool.execute(move || { let _ = tx.send((id, key.secret.sign(&root, DST, &[]))); });
    }
    drop(tx);
    let signatures: BTreeMap<_, _> = rx.into_iter().collect();
    if signatures.len() != snapshot.len() { return Err("a signing job failed"); }
    timings.individual_signing_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    for signature in signatures.values() {
        std::hint::black_box(signature.to_bytes());
    }
    timings.signature_serialization_ns = timer.elapsed().as_nanos();

    let messages = vec![root.as_slice(); snapshot.len()];
    let public_keys: Vec<_> = snapshot.iter().map(|(_, key)| &key.public).collect();
    let signature_refs: Vec<_> = snapshot.iter().map(|(id, _)| &signatures[id]).collect();
    let timer = Instant::now();
    let coefficients = randomizers(snapshot.len());
    timings.randomizers_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    let valid = Signature::verify_multiple_aggregate_signatures(&messages, DST, &public_keys,
        false, &signature_refs, true, &coefficients, 64) == BLST_ERROR::BLST_SUCCESS;
    timings.general_message_verification_ns = timer.elapsed().as_nanos();
    if !valid { return Err("ordinary message batch failed verification"); }

    let timer = Instant::now();
    let mut aggregates = Vec::new();
    for group in &committee.groups {
        let positions: Vec<_> = group.iter().map(|id| &signatures[id]).collect();
        // Individual signatures were already subgroup-checked by the real general batch.
        aggregates.push(AggregateSignature::aggregate(&positions, false)
            .map_err(|_| "position aggregation failed")?.to_signature());
    }
    timings.position_aggregation_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    for signature in &aggregates {
        std::hint::black_box(signature.to_bytes());
    }
    timings.signature_serialization_ns += timer.elapsed().as_nanos();
    // These are the baseline's required stages. The FOUR additional aggregate checks below
    // are a conservative output oracle, not a claim about current BN's production path.
    timings.total_ns = started.elapsed().as_nanos();
    let timer = Instant::now();
    // This immutable committee object is the exact-membership/multiplicity cache key. It is
    // never reused for a different groups vector, even if another vector has the same length.
    let cached_keys: Vec<_> = (0..committee.groups.len())
        .map(|index| &committee.aggregate_public_keys[index]).collect();
    timings.public_key_cache_lookup_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    let subnet_oracle_validity = aggregates.iter().zip(cached_keys).map(|(signature, public_key)|
        signature.fast_aggregate_verify_pre_aggregated(true, &root, DST, public_key)
            == BLST_ERROR::BLST_SUCCESS).collect();
    timings.oracle_aggregate_verification_ns = timer.elapsed().as_nanos();
    // A zero subtotal can fail a contribution-level check while the complete block aggregate
    // is valid. The individual/direct-sync baseline must preserve this behavior.
    let timer = Instant::now();
    let full_aggregate = AggregateSignature::aggregate(&aggregates.iter().collect::<Vec<_>>(), true)
        .map_err(|_| "cannot combine full sync aggregate")?.to_signature();
    let full_valid = full_aggregate.fast_aggregate_verify_pre_aggregated(true, &root, DST,
        &committee.full_aggregate_public_key) == BLST_ERROR::BLST_SUCCESS;
    timings.full_aggregate_oracle_ns = timer.elapsed().as_nanos();
    if !full_valid { return Err("ordinary full sync aggregate verification failed"); }
    Ok(Output { aggregates, full_aggregate, subnet_oracle_validity, timings })
}

/// Reference signs each selected position separately. It deliberately does not use the
/// baseline's unique-key messages, aggregate public-key cache, or any proposed group math.
pub fn ordinary_reference(registry: &Registry, positions: &[usize], root: [u8; 32], dst: &[u8])
    -> Result<Signature, &'static str> {
    if positions.is_empty() { return Err("empty reference needs protocol-level handling"); }
    let signatures: Result<Vec<_>, _> = positions.iter().map(|id| registry.get(id)
        .map(|key| key.secret.sign(&root, dst, &[])).ok_or("missing reference key")).collect();
    let signatures = signatures?;
    AggregateSignature::aggregate(&signatures.iter().collect::<Vec<_>>(), true)
        .map(|aggregate| aggregate.to_signature()).map_err(|_| "reference aggregation failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verify_reference(registry: &Registry, positions: &[usize], signature: Signature,
        root: [u8; 32], dst: &[u8]) -> bool {
        let keys: Vec<_> = positions.iter().map(|id| &registry[id].public).collect();
        signature.fast_aggregate_verify(true, &root, dst, &keys) == BLST_ERROR::BLST_SUCCESS
    }

    #[test]
    fn baseline_matches_position_reference_for_1_2_64_512_positions() {
        let registry = fixture_registry(64);
        let pool = ThreadPool::new(2);
        for count in [1, 2, 64, 512] {
            let positions: Vec<_> = (0..count).map(|index| index % 64).collect();
            let committee = Committee::prepare(&registry, vec![positions.clone()]).unwrap();
            let actual = baseline(&registry, &committee, [1; 32], &pool).unwrap();
            let reference = ordinary_reference(&registry, &positions, [1; 32], DST).unwrap();
            assert_eq!(actual.aggregates[0].to_bytes(), reference.to_bytes());
            assert!(verify_reference(&registry, &positions, reference, [1; 32], DST));
            assert_eq!(actual.timings.signing_jobs, count.min(64));
        }
    }

    #[test]
    fn full_fixture_uses_64_signers_and_four_distinct_128_position_subnets() {
        let groups = fixture_groups();
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|group| group.len() == 128));
        assert_eq!(groups.iter().flatten().copied().collect::<BTreeSet<_>>().len(), 64);
        let registry = fixture_registry(64);
        let committee = Committee::prepare(&registry, groups.clone()).unwrap();
        let output = baseline(&registry, &committee, [2; 32], &ThreadPool::new(2)).unwrap();
        assert_eq!(output.timings.signing_jobs, 64);
        for (group, aggregate) in groups.iter().zip(&output.aggregates) {
            assert_eq!(aggregate.to_bytes(), ordinary_reference(&registry, group, [2; 32], DST).unwrap().to_bytes());
        }
        assert!(output.aggregates.windows(2).all(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn subsets_same_count_different_keys_and_repeated_positions_are_distinct() {
        let registry = fixture_registry(4);
        let root = [3; 32];
        let groups = vec![vec![0, 1], vec![0, 2], vec![0, 0, 1]];
        let committee = Committee::prepare(&registry, groups.clone()).unwrap();
        let output = baseline(&registry, &committee, root, &ThreadPool::new(2)).unwrap();
        assert_ne!(output.aggregates[0], output.aggregates[1]);
        assert_ne!(output.aggregates[0], output.aggregates[2]);
        for (group, signature) in groups.iter().zip(output.aggregates) {
            assert_eq!(signature.to_bytes(), ordinary_reference(&registry, group, root, DST).unwrap().to_bytes());
            assert!(verify_reference(&registry, group, signature, root, DST));
        }
    }

    #[test]
    fn ordinary_crypto_rejects_wrong_bits_key_root_domain_and_signature() {
        let registry = fixture_registry(4);
        let signature = ordinary_reference(&registry, &[0, 0, 1], [4; 32], DST).unwrap();
        assert!(!verify_reference(&registry, &[0, 1], signature, [4; 32], DST));
        assert!(!verify_reference(&registry, &[0, 0, 2], signature, [4; 32], DST));
        assert!(!verify_reference(&registry, &[0, 0, 1], signature, [5; 32], DST));
        assert!(!verify_reference(&registry, &[0, 0, 1], signature, [4; 32], b"another-dst"));
        let wrong = ordinary_reference(&registry, &[3], [4; 32], DST).unwrap();
        assert!(!verify_reference(&registry, &[0, 0, 1], wrong, [4; 32], DST));
    }

    #[test]
    fn mixed_roots_require_general_verification_and_mixed_domains_cannot_be_merged() {
        let registry = fixture_registry(2);
        let a = registry[&0].secret.sign(&[6; 32], DST, &[]);
        let b = registry[&1].secret.sign(&[7; 32], DST, &[]);
        let aggregate = AggregateSignature::aggregate(&[&a, &b], true).unwrap().to_signature();
        let keys = [&registry[&0].public, &registry[&1].public];
        let root_a = [6; 32]; let root_b = [7; 32];
        assert_eq!(aggregate.aggregate_verify(true, &[&root_a, &root_b], DST, &keys, false), BLST_ERROR::BLST_SUCCESS);
        assert_ne!(aggregate.fast_aggregate_verify(true, &root_a, DST, &keys), BLST_ERROR::BLST_SUCCESS);
        let other_domain = registry[&1].secret.sign(&root_a, b"other-dst", &[]);
        assert_eq!(other_domain.verify(true, &root_a, b"other-dst", &[], keys[1], true), BLST_ERROR::BLST_SUCCESS);
        let mixed = AggregateSignature::aggregate(&[&a, &other_domain], true).unwrap().to_signature();
        assert_ne!(mixed.fast_aggregate_verify(true, &root_a, DST, &keys), BLST_ERROR::BLST_SUCCESS);
    }

    fn cancelling_registry() -> Registry {
        let mut one = [0u8; 32]; one[31] = 1;
        let mut two = [0u8; 32]; two[31] = 2;
        // Public test constant r-1, the additive inverse of scalar 1 in BLS12-381 Fr.
        let minus_one = [0x73,0xed,0xa7,0x53,0x29,0x9d,0x7d,0x48,0x33,0x39,0xd8,0x08,0x09,0xa1,0xd8,0x05,
            0x53,0xbd,0xa4,0x02,0xff,0xfe,0x5b,0xfe,0xff,0xff,0xff,0xff,0x00,0x00,0x00,0x00];
        [one, minus_one, two].iter().enumerate().map(|(id, bytes)|
            (id, Arc::new(KeyRecord::new(SecretKey::from_bytes(bytes).unwrap())))).collect()
    }

    #[test]
    fn intermediate_zero_preserves_later_signer_and_final_zero_obeys_upstream() {
        let registry = cancelling_registry();
        let root = [8; 32];
        let intermediate = ordinary_reference(&registry, &[0, 1, 2], root, DST).unwrap();
        assert_eq!(intermediate.to_bytes(), registry[&2].secret.sign(&root, DST, &[]).to_bytes());
        assert!(verify_reference(&registry, &[0, 1, 2], intermediate, root, DST));
        let committee = Committee::prepare(&registry, vec![vec![0, 1, 2]]).unwrap();
        assert_eq!(baseline(&registry, &committee, root, &ThreadPool::new(2)).unwrap().aggregates[0], intermediate);
        let final_zero = ordinary_reference(&registry, &[0, 1], root, DST).unwrap();
        let mut infinity = [0; 96]; infinity[0] = 0xc0;
        assert_eq!(final_zero.to_bytes(), infinity);
        assert!(!verify_reference(&registry, &[0, 1], final_zero, root, DST));
        let zero_committee = Committee::prepare(&registry, vec![vec![0, 1]]).unwrap();
        assert!(baseline(&registry, &zero_committee, root, &ThreadPool::new(2)).is_err());
        assert!(ordinary_reference(&registry, &[], root, DST).is_err());
        assert!(Committee::prepare(&registry, vec![vec![]]).is_err());
    }

    #[test]
    fn current_lookup_rejects_missing_key_before_scheduling_any_signatures() {
        let mut registry = fixture_registry(4);
        let committee = Committee::prepare(&registry, vec![vec![0, 1, 2]]).unwrap();
        registry.remove(&1);
        let pool = ThreadPool::new(2);
        assert!(baseline(&registry, &committee, [9; 32], &pool).is_err());
        assert_eq!(pool.queued_count(), 0);
        assert_eq!(pool.active_count(), 0);
    }

    #[test]
    fn zero_subnet_with_valid_full_512_aggregate_requires_whole_batch_fallback() {
        let registry = cancelling_registry();
        let zero_subnet: Vec<_> = (0..128).map(|index| index % 2).collect();
        let groups = vec![zero_subnet, vec![2; 128], vec![2; 128], vec![2; 128]];
        let positions: Vec<_> = groups.iter().flatten().copied().collect();
        let committee = Committee::prepare(&registry, groups).unwrap();
        let root = [11; 32];
        let output = baseline(&registry, &committee, root, &ThreadPool::new(2)).unwrap();
        assert_eq!(output.subnet_oracle_validity, [false, true, true, true]);
        let reference = ordinary_reference(&registry, &positions, root, DST).unwrap();
        assert_eq!(output.full_aggregate.to_bytes(), reference.to_bytes());
        assert!(verify_reference(&registry, &positions, reference, root, DST));
        // Future group transport must fall back to this WHOLE individual/direct-sync batch;
        // individually aggregating the zero subnet still fails its stricter admission check.
    }

    #[test]
    fn same_registry_id_with_a_different_key_cannot_reuse_committee_cache() {
        let mut registry = fixture_registry(4);
        let committee = Committee::prepare(&registry, vec![vec![0, 1]]).unwrap();
        registry.insert(1, Arc::clone(&registry[&3]));
        assert!(baseline(&registry, &committee, [10; 32], &ThreadPool::new(2)).is_err());
    }
}
