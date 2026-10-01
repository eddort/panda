//! Test-only replay against the pinned, otherwise unmodified upstream consensus code.
use ssz::{Decode, Encode};
use state_processing::{
    per_block_processing, state_advance::complete_state_advance, BlockSignatureStrategy,
    AllCaches, ConsensusContext, VerifyBlockRoot, VerifySignatures,
};
use std::{fs, path::PathBuf, time::Instant};
use types::{BeaconState, Config, EthSpec, MainnetEthSpec, SignedBeaconBlock, SignedExecutionPayloadEnvelope};

type E = MainnetEthSpec;

fn run() -> Result<(), String> {
    let directory = PathBuf::from(std::env::args().nth(1).ok_or("fixture directory required")?);
    let spec = Config::from_file(&directory.join("config.yaml"))?
        .apply_to_chain_spec::<E>(&E::default_spec()).ok_or("preset mismatch")?;
    let read = |name: &str| fs::read(directory.join(name)).map_err(|e| format!("{name}: {e}"));
    let mut state = BeaconState::<E>::from_ssz_bytes(&read("pre.ssz")?, &spec)
        .map_err(|e| format!("pre state: {e:?}"))?;
    let expected_bytes = read("post.ssz")?;
    let expected = BeaconState::<E>::from_ssz_bytes(&expected_bytes, &spec)
        .map_err(|e| format!("post state: {e:?}"))?;
    let first = state.slot().as_u64() + 1;
    let last = expected.slot().as_u64();
    if first > last { return Err("empty or reversed range".into()); }
    state.build_all_caches(&spec).map_err(|e| format!("caches: {e:?}"))?;
    let mut root = state.update_tree_hash_cache().map_err(|e| format!("pre root: {e:?}"))?;
    let start = Instant::now();
    for slot in first..=last {
        let block = SignedBeaconBlock::<E>::from_ssz_bytes(&read(&format!("block-{slot}.ssz"))?, &spec)
            .map_err(|e| format!("block {slot} decoding: {e:?}"))?;
        if block.slot().as_u64() != slot { return Err(format!("non-contiguous block {slot}")); }
        complete_state_advance(&mut state, Some(root), block.slot(), None, &spec)
            .map_err(|e| format!("slot {slot}: {e:?}"))?;
        per_block_processing(&mut state, &block, BlockSignatureStrategy::VerifyBulk,
            VerifyBlockRoot::True, &mut ConsensusContext::new(block.slot()), &spec)
            .map_err(|e| format!("block {slot} verification: {e:?}"))?;
        root = state.update_tree_hash_cache().map_err(|e| format!("root {slot}: {e:?}"))?;
        if root != block.state_root() { return Err(format!("state root mismatch at {slot}")); }
        let envelope = SignedExecutionPayloadEnvelope::<E>::from_ssz_bytes(&read(&format!("envelope-{slot}.ssz"))?)
            .map_err(|e| format!("envelope {slot} decoding: {e:?}"))?;
        state_processing::envelope_processing::verify_execution_payload_envelope(
            &state, &envelope, VerifySignatures::True, root, &spec)
            .map_err(|e| format!("envelope {slot} verification: {e:?}"))?;
    }
    if state.as_ssz_bytes() != expected_bytes { return Err("full post-state SSZ mismatch".into()); }
    println!("{{\"passed\":true,\"slots\":{},\"elapsedMs\":{},\"stateRoot\":\"{root:?}\"}}",
        last - first + 1, start.elapsed().as_secs_f64() * 1000.0);
    Ok(())
}

fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
