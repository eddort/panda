//! Isolated ordinary direct-sync and ephemeral group-signing algorithms.
use blst::{blst_fr, blst_scalar, min_pk::{AggregatePublicKey, AggregateSignature, PublicKey, SecretKey, Signature}, BLST_ERROR};
use rand::{Rng, SeedableRng};
use std::{collections::{BTreeMap, BTreeSet}, sync::{mpsc, Arc}, time::Instant};
use threadpool::ThreadPool;
use zeroize::Zeroize;

pub const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Baseline, Candidate }

impl Mode {
    pub fn name(self) -> &'static str {
        match self { Self::Baseline => "baseline", Self::Candidate => "candidate" }
    }
}

/// Every newly created secret intermediate has one owner and is wiped on all exits.
/// Do not derive Debug/Clone or serialize this type. Original keys are only borrowed.
#[derive(Default)]
struct SecretScratch {
    accumulator: blst_fr,
    member: blst_fr,
    next: blst_fr,
    scalar: blst_scalar,
    #[cfg(test)]
    wiped: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

impl SecretScratch {
    fn wipe(&mut self) {
        self.accumulator.l.zeroize();
        self.member.l.zeroize();
        self.next.l.zeroize();
        self.scalar.b.zeroize();
    }

    fn sign(&mut self, positions: &[Arc<KeyRecord>], root: &[u8; 32], dst: &[u8])
        -> Result<Option<Signature>, &'static str> {
        self.wipe();
        if positions.is_empty() { return Err("empty secret-key group"); }
        for record in positions {
            let borrowed_scalar: &blst_scalar = (&record.secret).into();
            // All pointers reference live, correctly aligned, disjoint initialized fields.
            // Fr addition allows an intermediate zero; checked SecretKey addition would not.
            unsafe {
                blst::blst_fr_from_scalar(&mut self.member, borrowed_scalar);
                blst::blst_fr_add(&mut self.next, &self.accumulator, &self.member);
            }
            self.accumulator.l.copy_from_slice(&self.next.l);
        }
        unsafe { blst::blst_scalar_from_fr(&mut self.scalar, &self.accumulator); }
        let group_key: &SecretKey = match (&self.scalar).try_into() {
            Ok(key) => key,
            Err(_) => return Ok(None), // Final zero: the entire caller batch must fall back.
        };
        Ok(Some(group_key.sign(root, dst, &[])))
    }
}

impl Drop for SecretScratch {
    fn drop(&mut self) {
        self.wipe();
        #[cfg(test)]
        if let Some(observer) = &self.wiped {
            assert!(self.accumulator.l.iter().chain(&self.member.l).chain(&self.next.l).all(|word| *word == 0));
            assert!(self.scalar.b.iter().all(|byte| *byte == 0));
            observer.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

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
    pub route: &'static str,
    pub fallback_probe_ns: u128,
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
    timings.route = "individual_direct_sync";
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

pub fn run(mode: Mode, registry: &Registry, committee: &Committee, root: [u8; 32],
    pool: &ThreadPool) -> Result<Output, &'static str> {
    match mode {
        Mode::Baseline => baseline(registry, committee, root, pool),
        Mode::Candidate => candidate(registry, committee, root, pool),
    }
}

fn verify_group_batch(signatures: &[Signature], public_keys: &[&PublicKey], root: &[u8; 32],
    coefficients: &[blst_scalar]) -> bool {
    let messages = vec![root.as_slice(); signatures.len()];
    let signatures: Vec<_> = signatures.iter().collect();
    Signature::verify_multiple_aggregate_signatures(&messages, DST, public_keys,
        false, &signatures, true, coefficients, 64) == BLST_ERROR::BLST_SUCCESS
}

/// Fresh live snapshot -> Fr sum per exact subnet -> four genuine signatures -> the EXISTING
/// randomized general verifier. Only public committee aggregate keys persist between calls.
pub fn candidate(registry: &Registry, committee: &Committee, root: [u8; 32],
    pool: &ThreadPool) -> Result<Output, &'static str> {
    let started = Instant::now();
    let mut timings = Timings::default();
    timings.route = "ephemeral_groups";
    let timer = Instant::now();
    let snapshot: BTreeMap<_, _> = committee.snapshot(registry)?.into_iter().collect();
    // Preserve exact position multiplicity. Cloning Arc handles never copies a secret scalar.
    let groups: Vec<Vec<_>> = committee.groups.iter().map(|group|
        group.iter().map(|id| Arc::clone(&snapshot[id])).collect()).collect();
    timings.live_snapshot_ns = timer.elapsed().as_nanos();
    timings.signing_jobs = groups.len();
    let timer = Instant::now();
    let (tx, rx) = mpsc::channel();
    for (index, positions) in groups.into_iter().enumerate() {
        let tx = tx.clone();
        pool.execute(move || {
            let mut scratch = SecretScratch::default();
            let result = scratch.sign(&positions, &root, DST);
            drop(scratch); // Wipe before publishing even a public signature/result.
            drop(positions); // The completed job retains no borrowed-key handles.
            let _ = tx.send((index, result));
        });
    }
    drop(tx);
    let results: BTreeMap<_, _> = rx.into_iter().collect();
    if results.len() != committee.groups.len() { return Err("a group signing job failed"); }
    timings.individual_signing_ns = timer.elapsed().as_nanos(); // Same timer boundary; sums included.
    let mut aggregates = Vec::new();
    let mut has_zero_subnet = false;
    for result in results.into_values() {
        match result? {
            Some(signature) => aggregates.push(signature),
            None => has_zero_subnet = true,
        }
    }
    if has_zero_subnet {
        // Do not submit infinity to the stricter four-subnet admission path. A nonzero full
        // aggregate can still be valid, so fall back the WHOLE batch to individual/direct-sync.
        drop(aggregates);
        let probe_ns = started.elapsed().as_nanos();
        let mut output = baseline(registry, committee, root, pool)?;
        output.timings.route = "individual_zero_subnet_fallback";
        output.timings.fallback_probe_ns = probe_ns;
        output.timings.total_ns += probe_ns;
        output.timings.signing_jobs += timings.signing_jobs;
        return Ok(output);
    }
    let timer = Instant::now();
    for signature in &aggregates { std::hint::black_box(signature.to_bytes()); }
    timings.signature_serialization_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    let cached_keys: Vec<_> = (0..committee.groups.len())
        .map(|index| &committee.aggregate_public_keys[index]).collect();
    timings.public_key_cache_lookup_ns = timer.elapsed().as_nanos();
    let signature_refs: Vec<_> = aggregates.iter().collect();
    let timer = Instant::now();
    let coefficients = randomizers(aggregates.len());
    timings.randomizers_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    let valid = verify_group_batch(&aggregates, &cached_keys, &root, &coefficients);
    timings.general_message_verification_ns = timer.elapsed().as_nanos();
    if !valid { return Err("ordinary group signature batch failed verification"); }
    // Unlike baseline, required group verification AND public-key lookup are included here.
    timings.total_ns = started.elapsed().as_nanos();

    // Same independent, excluded oracles as baseline; they do not authorize the candidate path.
    let timer = Instant::now();
    let subnet_oracle_validity = aggregates.iter().zip(&cached_keys).map(|(signature, public_key)|
        signature.fast_aggregate_verify_pre_aggregated(true, &root, DST, public_key)
            == BLST_ERROR::BLST_SUCCESS).collect();
    timings.oracle_aggregate_verification_ns = timer.elapsed().as_nanos();
    let timer = Instant::now();
    let full_aggregate = AggregateSignature::aggregate(&signature_refs, true)
        .map_err(|_| "cannot combine candidate full sync aggregate")?.to_signature();
    let full_valid = full_aggregate.fast_aggregate_verify_pre_aggregated(true, &root, DST,
        &committee.full_aggregate_public_key) == BLST_ERROR::BLST_SUCCESS;
    timings.full_aggregate_oracle_ns = timer.elapsed().as_nanos();
    if !full_valid { return Err("ordinary candidate full sync aggregate verification failed"); }
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

    fn both(registry: &Registry, committee: &Committee, root: [u8; 32], pool: &ThreadPool)
        -> Vec<(Mode, Output)> {
        let results: Vec<_> = [Mode::Baseline, Mode::Candidate].into_iter()
            .map(|mode| (mode, run(mode, registry, committee, root, pool).unwrap())).collect();
        assert_eq!(results[0].1.full_aggregate.to_bytes(), results[1].1.full_aggregate.to_bytes());
        assert_eq!(results[0].1.aggregates.len(), results[1].1.aggregates.len());
        for (ordinary, candidate) in results[0].1.aggregates.iter().zip(&results[1].1.aggregates) {
            assert_eq!(ordinary.to_bytes(), candidate.to_bytes());
        }
        results
    }

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
            let reference = ordinary_reference(&registry, &positions, [1; 32], DST).unwrap();
            assert!(verify_reference(&registry, &positions, reference, [1; 32], DST));
            for (mode, actual) in both(&registry, &committee, [1; 32], &pool) {
                assert_eq!(actual.aggregates[0].to_bytes(), reference.to_bytes());
                assert_eq!(actual.timings.signing_jobs, if mode == Mode::Baseline { count.min(64) } else { 1 });
            }
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
        for (mode, output) in both(&registry, &committee, [2; 32], &ThreadPool::new(2)) {
            assert_eq!(output.timings.signing_jobs, if mode == Mode::Baseline { 64 } else { 4 });
            for (group, aggregate) in groups.iter().zip(&output.aggregates) {
                assert_eq!(aggregate.to_bytes(), ordinary_reference(&registry, group, [2; 32], DST).unwrap().to_bytes());
            }
            assert!(output.aggregates.windows(2).all(|pair| pair[0] != pair[1]));
        }
    }

    #[test]
    fn subsets_same_count_different_keys_and_repeated_positions_are_distinct() {
        let registry = fixture_registry(4);
        let root = [3; 32];
        let groups = vec![vec![0, 1], vec![0, 2], vec![0, 0, 1]];
        let committee = Committee::prepare(&registry, groups.clone()).unwrap();
        for (_, output) in both(&registry, &committee, root, &ThreadPool::new(2)) {
            assert_ne!(output.aggregates[0], output.aggregates[1]);
            assert_ne!(output.aggregates[0], output.aggregates[2]);
            for (group, signature) in groups.iter().zip(output.aggregates) {
                assert_eq!(signature.to_bytes(), ordinary_reference(&registry, group, root, DST).unwrap().to_bytes());
                assert!(verify_reference(&registry, group, signature, root, DST));
            }
        }
    }

    #[test]
    fn ordinary_crypto_rejects_wrong_bits_key_root_domain_and_signature() {
        let registry = fixture_registry(4);
        let committee = Committee::prepare(&registry, vec![vec![0, 0, 1]]).unwrap();
        for (_, output) in both(&registry, &committee, [4; 32], &ThreadPool::new(2)) {
            let signature = output.aggregates[0];
            assert!(!verify_reference(&registry, &[0, 1], signature, [4; 32], DST));
            assert!(!verify_reference(&registry, &[0, 0, 2], signature, [4; 32], DST));
            assert!(!verify_reference(&registry, &[0, 0, 1], signature, [5; 32], DST));
            assert!(!verify_reference(&registry, &[0, 0, 1], signature, [4; 32], b"another-dst"));
        }
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
        let committee = Committee::prepare(&registry, vec![vec![0, 1]]).unwrap();
        for root in [root_a, root_b] {
            for (_, output) in both(&registry, &committee, root, &ThreadPool::new(2)) {
                assert!(verify_reference(&registry, &[0, 1], output.aggregates[0], root, DST));
            }
        }
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
        for (_, output) in both(&registry, &committee, root, &ThreadPool::new(2)) {
            assert_eq!(output.aggregates[0], intermediate);
        }
        let final_zero = ordinary_reference(&registry, &[0, 1], root, DST).unwrap();
        let mut infinity = [0; 96]; infinity[0] = 0xc0;
        assert_eq!(final_zero.to_bytes(), infinity);
        assert!(!verify_reference(&registry, &[0, 1], final_zero, root, DST));
        let zero_committee = Committee::prepare(&registry, vec![vec![0, 1]]).unwrap();
        for mode in [Mode::Baseline, Mode::Candidate] {
            assert!(run(mode, &registry, &zero_committee, root, &ThreadPool::new(2)).is_err());
        }
        assert!(ordinary_reference(&registry, &[], root, DST).is_err());
        assert!(Committee::prepare(&registry, vec![vec![]]).is_err());
    }

    #[test]
    fn current_lookup_rejects_missing_key_before_scheduling_any_signatures() {
        let mut registry = fixture_registry(4);
        let committee = Committee::prepare(&registry, vec![vec![0, 1, 2]]).unwrap();
        registry.remove(&1);
        let pool = ThreadPool::new(2);
        for mode in [Mode::Baseline, Mode::Candidate] {
            assert!(run(mode, &registry, &committee, [9; 32], &pool).is_err());
        }
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
        let reference = ordinary_reference(&registry, &positions, root, DST).unwrap();
        for (mode, output) in both(&registry, &committee, root, &ThreadPool::new(2)) {
            assert_eq!(output.subnet_oracle_validity, [false, true, true, true]);
            assert_eq!(output.full_aggregate.to_bytes(), reference.to_bytes());
            assert!(!verify_group_batch(&output.aggregates,
                &committee.aggregate_public_keys.iter().collect::<Vec<_>>(), &root, &randomizers(4)));
            if mode == Mode::Candidate {
                assert_eq!(output.timings.route, "individual_zero_subnet_fallback");
                assert!(output.timings.fallback_probe_ns > 0);
            }
        }
        assert!(verify_reference(&registry, &positions, reference, root, DST));
        // Future group transport must fall back to this WHOLE individual/direct-sync batch;
        // individually aggregating the zero subnet still fails its stricter admission check.
    }

    #[test]
    fn same_registry_id_with_a_different_key_cannot_reuse_committee_cache() {
        let mut registry = fixture_registry(4);
        let committee = Committee::prepare(&registry, vec![vec![0, 1]]).unwrap();
        registry.insert(1, Arc::clone(&registry[&3]));
        for mode in [Mode::Baseline, Mode::Candidate] {
            assert!(run(mode, &registry, &committee, [10; 32], &ThreadPool::new(2)).is_err());
        }
    }

    #[test]
    fn shuffled_positions_and_domains_match_independent_ordinary_signatures() {
        let registry = fixture_registry(4);
        let positions = [0, 1, 0, 3, 2, 1];
        let mut shuffled = positions.to_vec(); shuffled.reverse();
        let committee = Committee::prepare(&registry, vec![positions.to_vec(), shuffled]).unwrap();
        for (_, output) in both(&registry, &committee, [12; 32], &ThreadPool::new(2)) {
            assert_eq!(output.aggregates[0].to_bytes(), output.aggregates[1].to_bytes());
        }
        let keys: Vec<_> = positions.iter().map(|id| Arc::clone(&registry[id])).collect();
        let mut scratch = SecretScratch::default();
        let signature = scratch.sign(&keys, &[12; 32], b"different-dst").unwrap().unwrap();
        assert_eq!(signature.to_bytes(), ordinary_reference(&registry, &positions, [12; 32], b"different-dst").unwrap().to_bytes());
        assert!(!verify_reference(&registry, &positions, signature, [12; 32], DST));
    }

    #[test]
    fn scratch_guards_wipe_success_error_zero_and_unwind_without_modifying_keys() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let registry = cancelling_registry();
        let original = registry[&0].secret.sign(&[13; 32], DST, &[]);
        for outcome in 0..4 {
            let observer = Arc::new(AtomicUsize::new(0));
            let seen = Arc::clone(&observer);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut scratch = SecretScratch { wiped: Some(seen), ..SecretScratch::default() };
                let keys = vec![Arc::clone(&registry[&0]), Arc::clone(&registry[&1])];
                if outcome == 1 {
                    assert!(scratch.sign(&keys[..1], &[13; 32], DST).unwrap().is_some());
                    assert!(scratch.sign(&[], &[13; 32], DST).is_err());
                }
                else if outcome == 2 { assert!(scratch.sign(&keys, &[13; 32], DST).unwrap().is_none()); }
                else {
                    assert!(scratch.sign(&keys[..1], &[13; 32], DST).unwrap().is_some());
                    if outcome == 3 { panic!("test-only unwind after secret accumulation"); }
                }
            }));
            assert_eq!(result.is_err(), outcome == 3);
            assert_eq!(observer.load(Ordering::SeqCst), 1);
        }
        assert_eq!(registry[&0].secret.sign(&[13; 32], DST, &[]), original);
    }

    #[test]
    fn required_four_signature_batch_rejects_swaps_compensation_and_non_subgroup() {
        use rand::RngCore;
        let registry = fixture_registry(8);
        let committee = Committee::prepare(&registry, vec![vec![0, 1], vec![2, 3], vec![4, 5], vec![6, 7]]).unwrap();
        let root = [14; 32];
        let output = candidate(&registry, &committee, root, &ThreadPool::new(2)).unwrap();
        let public_keys: Vec<_> = committee.aggregate_public_keys.iter().collect();
        assert!(verify_group_batch(&output.aggregates, &public_keys, &root, &randomizers(4)));
        let mut swapped = output.aggregates.clone(); swapped.swap(0, 1);
        assert!(!verify_group_batch(&swapped, &public_keys, &root, &randomizers(4)));
        let delta = registry[&0].secret.sign(&root, DST, &[]);
        let mut negative = delta.to_bytes(); negative[0] ^= 0x20;
        let negative = Signature::from_bytes(&negative).unwrap();
        let mut compensated = output.aggregates.clone();
        compensated[0] = AggregateSignature::aggregate(&[&compensated[0], &delta], true).unwrap().to_signature();
        compensated[1] = AggregateSignature::aggregate(&[&compensated[1], &negative], true).unwrap().to_signature();
        assert_eq!(AggregateSignature::aggregate(&compensated.iter().collect::<Vec<_>>(), true).unwrap().to_signature(), output.full_aggregate);
        assert!(!verify_group_batch(&compensated, &public_keys, &root, &randomizers(4)));
        let mut rng = rand::rngs::StdRng::from_seed([99; 32]);
        let invalid = (0..128).find_map(|_| {
            let mut bytes = [0u8; 96]; rng.fill_bytes(&mut bytes);
            bytes[0] = (bytes[0] & 0x1f) | 0x80; bytes[48] &= 0x1f;
            Signature::from_bytes(&bytes).ok().filter(|signature| signature.validate(false).is_err())
        }).unwrap();
        let mut corrupted = output.aggregates;
        corrupted[0] = invalid;
        assert!(!verify_group_batch(&corrupted, &public_keys, &root, &randomizers(4)));
    }
}
