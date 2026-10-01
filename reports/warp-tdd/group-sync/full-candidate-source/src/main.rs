use panda_group_sync_proof::{run, fixture_groups, fixture_registry, Committee, Mode, Timings};
use std::time::Instant;
use threadpool::ThreadPool;

fn ms(ns: u128) -> f64 { ns as f64 / 1_000_000.0 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shape { Subnets, Full }

impl Shape {
    fn name(self) -> &'static str {
        match self { Self::Subnets => "subnets", Self::Full => "full" }
    }

    fn groups(self) -> Vec<Vec<usize>> {
        let groups = fixture_groups();
        match self { Self::Subnets => groups, Self::Full => vec![groups.into_iter().flatten().collect()] }
    }
}

fn options(args: &[String]) -> Result<(Mode, Shape), &'static str> {
    let mut mode = Mode::Baseline;
    let mut shape = Shape::Subnets;
    for pair in args.chunks(2) {
        match pair {
            [flag, value] if flag == "--mode" => mode = match value.as_str() {
                "baseline" => Mode::Baseline, "candidate" => Mode::Candidate,
                _ => return Err("expected --mode baseline or --mode candidate"),
            },
            [flag, value] if flag == "--shape" => shape = match value.as_str() {
                "subnets" => Shape::Subnets, "full" => Shape::Full,
                _ => return Err("expected --shape subnets or --shape full"),
            },
            _ => return Err("expected --mode baseline|candidate and --shape subnets|full"),
        }
    }
    Ok((mode, shape))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let (mode, shape) = options(&args)?;
    let registry = fixture_registry(64);
    let pool = ThreadPool::new(2);
    // Keygen and loading are excluded, matching an already-running VC. Public committee
    // preparation is cold and measured separately; no aggregate secret key is created.
    let timer = Instant::now();
    let groups = shape.groups();
    let output_groups = groups.len();
    let positions_per_output_group = groups[0].len();
    let committee = Committee::prepare(&registry, groups)?;
    let committee_prepare_ms = ms(timer.elapsed().as_nanos());
    let cold_public_key_aggregation_ms = ms(committee.public_key_aggregation_ns);
    // One disclosed warm-up initializes signing/BLS worker pools with another root.
    let warmup = run(mode, &registry, &committee, [0; 32], &pool)?;
    let warmup_ms = ms(warmup.timings.total_ns);
    let mut samples = Vec::new();
    for index in 1u64..=8 {
        let mut root = [0; 32]; root[..8].copy_from_slice(&index.to_le_bytes());
        let output = run(mode, &registry, &committee, root, &pool)?;
        let expected_jobs = if mode == Mode::Baseline { 64 } else { output_groups };
        if output.aggregates.len() != output_groups || output.timings.signing_jobs != expected_jobs {
            return Err("unexpected fixture coverage".into());
        }
        samples.push(output.timings);
    }
    let mean = |f: fn(&Timings) -> u128| ms(samples.iter().map(f).sum::<u128>()) / samples.len() as f64;
    let mean_total_ms = mean(|s| s.total_ns);
    let mean_signature_serialization_ms = mean(|s| s.signature_serialization_ns);
    let mean_signing_ms = mean(|s| s.individual_signing_ns);
    let mean_required_verification_ms = mean(|s| s.randomizers_ns + s.general_message_verification_ns);
    let signing_subgate_pass = mean_signing_ms <= 1.0;
    let verification_subgate_pass = mean_required_verification_ms <= 2.0;
    let cold_committee_plus_mean_pipeline_ms = committee_prepare_ms + mean_total_ms;
    let mut totals: Vec<_> = samples.iter().map(|s| s.total_ns).collect();
    totals.sort_unstable();
    let p95_total_ms = ms(totals[(totals.len() * 95).div_ceil(100) - 1]);
    let mean_full_aggregate_oracle_ms = mean(|s| s.full_aggregate_oracle_ns);
    let gate = mean_total_ms <= 3.0;
    let public_key_lookup_excluded = mode == Mode::Baseline;
    let records = samples.iter().map(|s| format!("{{\"route\":\"{}\",\"fallback_probe_ms\":{:.6},\"live_snapshot_ms\":{:.6},\"signing_including_secret_sums_ms\":{:.6},\"signature_serialization_ms\":{:.6},\"randomizers_ms\":{:.6},\"general_message_verification_ms\":{:.6},\"position_aggregation_ms\":{:.6},\"public_key_cache_lookup_ms\":{:.6},\"oracle_aggregate_verification_ms\":{:.6},\"total_ms\":{:.6},\"signing_jobs\":{}}}",
        s.route, ms(s.fallback_probe_ns), ms(s.live_snapshot_ns), ms(s.individual_signing_ns), ms(s.signature_serialization_ns), ms(s.randomizers_ns),
        ms(s.general_message_verification_ns), ms(s.position_aggregation_ns), ms(s.public_key_cache_lookup_ns), ms(s.oracle_aggregate_verification_ns),
        ms(s.total_ns), s.signing_jobs)).collect::<Vec<_>>().join(",");
    println!("{{\"schema\":3,\"mode\":\"{}\",\"shape\":\"{}\",\"output_groups\":{output_groups},\"positions_per_output_group\":{positions_per_output_group},\"blst\":\"0.3.17\",\"rand\":\"0.9.2\",\"signing_pool\":\"threadpool-1.8.1\",\"signing_workers\":2,\"arch\":\"{}\",\"os\":\"{}\",\"batches\":8,\"unique_keys\":64,\"committee_positions\":512,\"subnets\":4,\"positions_per_subnet\":128,\"public_aggregate_key_cache\":true,\"secret_cache\":false,\"oracle_verification_excluded_from_total\":true,\"public_key_lookup_excluded_from_total\":{public_key_lookup_excluded},\"committee_prepare_ms\":{committee_prepare_ms:.6},\"cold_public_key_aggregation_ms\":{cold_public_key_aggregation_ms:.6},\"cold_committee_plus_mean_pipeline_ms\":{cold_committee_plus_mean_pipeline_ms:.6},\"disclosed_warmup_pipeline_ms\":{warmup_ms:.6},\"mean_live_snapshot_ms\":{:.6},\"mean_signing_including_secret_sums_ms\":{:.6},\"mean_randomizers_ms\":{:.6},\"mean_general_message_verification_ms\":{:.6},\"mean_position_aggregation_ms\":{:.6},\"mean_public_key_cache_lookup_ms\":{:.6},\"mean_oracle_aggregate_verification_ms\":{:.6},\"mean_full_aggregate_oracle_ms\":{mean_full_aggregate_oracle_ms:.6},\"mean_signature_serialization_ms\":{mean_signature_serialization_ms:.6},\"mean_required_verification_ms\":{mean_required_verification_ms:.6},\"signing_subgate_1ms_pass\":{signing_subgate_pass},\"verification_subgate_2ms_pass\":{verification_subgate_pass},\"mean_total_ms\":{mean_total_ms:.6},\"p95_total_ms\":{p95_total_ms:.6},\"budget_ms\":3.0,\"component_gate_pass\":{gate},\"full_warp_gate_proven\":false,\"samples\":[{records}]}}",
        mode.name(), shape.name(), std::env::consts::ARCH, std::env::consts::OS, mean(|s| s.live_snapshot_ns),
        mean(|s| s.individual_signing_ns), mean(|s| s.randomizers_ns), mean(|s| s.general_message_verification_ns),
        mean(|s| s.position_aggregation_ns), mean(|s| s.public_key_cache_lookup_ns), mean(|s| s.oracle_aggregate_verification_ns));
    if !gate { std::process::exit(2); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_shape_preserves_every_original_position_and_its_order() {
        let original = fixture_groups();
        assert_eq!(original.len(), 4);
        assert!(original.iter().all(|group| group.len() == 128));
        let expected: Vec<_> = original.into_iter().flatten().collect();
        let full = Shape::Full.groups();
        assert_eq!(full.len(), 1);
        assert_eq!(full[0].len(), 512);
        assert_eq!(full[0], expected);
        assert_eq!(Shape::Subnets.groups(), fixture_groups());
    }

    #[test]
    fn both_modes_accept_full_shape_after_recorded_baseline() {
        let args = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>();
        assert_eq!(options(&[]).unwrap(), (Mode::Baseline, Shape::Subnets));
        assert_eq!(options(&args(&["--mode", "baseline", "--shape", "full"])).unwrap(),
            (Mode::Baseline, Shape::Full));
        assert_eq!(options(&args(&["--mode", "candidate", "--shape", "full"])).unwrap(),
            (Mode::Candidate, Shape::Full));
        assert!(options(&args(&["--shape"])).is_err());
        assert!(options(&args(&["--shape", "unknown"])).is_err());
    }
}
