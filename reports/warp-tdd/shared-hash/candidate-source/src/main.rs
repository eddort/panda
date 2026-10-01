#![forbid(unsafe_code)]

use panda_shared_hash_proof::{fixture, probe_mode, root, Algorithm, Context, Executor, Sample};
use std::time::Instant;

fn ms(ns: u128) -> f64 { ns as f64 / 1_000_000.0 }

fn report(executor: &str, count: usize, roots: &str, setup_ns: u128,
    warmup_ns: u128, samples: &[Sample]) -> (String, bool)
{
    let mean = |extract: fn(&Sample) -> u128|
        ms(samples.iter().map(extract).sum::<u128>()) / samples.len() as f64;
    let mut totals: Vec<_> = samples.iter().map(|sample| sample.total_ns).collect();
    totals.sort_unstable();
    let p95 = totals[((totals.len() * 95).div_ceil(100)).saturating_sub(1)];
    // This gate applies only to the requested 64-signature component, not to a network.
    let pass = mean(|sample| sample.total_ns) <= 1.0 && ms(p95) <= 1.0;
    let gate = if count == 64 { pass.to_string() } else { "null".into() };
    let records = samples.iter().map(|sample| format!(
        "{{\"signing_ms\":{:.6},\"serialization_ms\":{:.6},\"total_ms\":{:.6},\"verification_outside_timer_ms\":{:.6}}}",
        ms(sample.signing_ns), ms(sample.serialization_ns), ms(sample.total_ns),
        ms(sample.verification_ns))).collect::<Vec<_>>().join(",");
    (format!(
        "{{\"executor\":\"{executor}\",\"keys\":{count},\"roots\":\"{roots}\",\"batches\":{},\"executor_setup_outside_timer_ms\":{:.6},\"warmup_outside_timer_ms\":{:.6},\"first_batch_ms\":{:.6},\"mean_total_ms\":{:.6},\"min_total_ms\":{:.6},\"max_total_ms\":{:.6},\"p95_total_ms\":{:.6},\"mean_signing_ms\":{:.6},\"mean_serialization_ms\":{:.6},\"component_gate_pass\":{gate},\"samples\":[{records}]}}",
        samples.len(), ms(setup_ns), ms(warmup_ns), ms(samples[0].total_ns),
        mean(|sample| sample.total_ns), ms(totals[0]), ms(*totals.last().unwrap()), ms(p95),
        mean(|sample| sample.signing_ns), mean(|sample| sample.serialization_ns)),
        count != 64 || pass)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut batches = 8;
    let mut mode = "baseline";
    let mut algorithm = Algorithm::Baseline;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--mode" => {
                mode = args.get(i + 1).ok_or("--mode needs baseline or candidate")?;
                algorithm = match mode {
                    "baseline" => Algorithm::Baseline,
                    "candidate" => Algorithm::SharedHash,
                    _ => return Err("--mode must be baseline or candidate".into()),
                };
                i += 2;
            }
            "--batches" => {
                batches = args.get(i + 1).ok_or("--batches needs a number")?.parse::<usize>()?;
                i += 2;
            }
            _ => return Err("usage: --mode baseline|candidate [--batches 1..128]".into()),
        }
    }
    if !(1..=128).contains(&batches) { return Err("--batches must be 1..128".into()); }

    let mut reports = Vec::new();
    let mut all_gates_pass = true;
    let mut series = 10;
    for workers in 0..=2 {
        let setup_start = Instant::now();
        let (label, executor) = match workers {
            0 => ("serial", Executor::Serial),
            1 => ("persistent_one_worker", Executor::workers(1)?),
            _ => ("persistent_two_workers", Executor::workers(2)?),
        };
        let setup_ns = setup_start.elapsed().as_nanos();
        for count in [64, 1, 2, 512] {
            // Fixture creation/public-key derivation model an existing initialized keystore.
            // The executor has no key cache and every job uses these current caller-owned keys.
            let keys = fixture(count)?;
            for repeated in [false, true] {
                series += 1;
                let label_roots = if repeated { "repeated_root_primed" } else { "distinct_roots" };
                let warmup_ns = if repeated {
                    let start = Instant::now();
                    probe_mode(&executor, &keys, &Context::eth(root(series, 0)), algorithm)?;
                    start.elapsed().as_nanos()
                } else { 0 };
                let mut samples = Vec::new();
                for batch in 0..batches {
                    let index = if repeated { 0 } else { batch as u64 };
                    samples.push(probe_mode(&executor, &keys, &Context::eth(root(series, index)), algorithm)?);
                }
                let (json, pass) = report(label, count, label_roots, setup_ns, warmup_ns, &samples);
                all_gates_pass &= pass;
                reports.push(json);
            }
        }
    }
    let hash_once_per_batch = mode == "candidate";
    println!(
        "{{\"schema\":1,\"mode\":\"{mode}\",\"blst\":\"0.3.17\",\"threadpool\":\"1.8.1\",\"arch\":\"{}\",\"os\":\"{}\",\"available_parallelism\":{},\"baseline_has_hash_cache\":false,\"candidate_hash_once_per_batch_inside_timer\":{hash_once_per_batch},\"persistent_hash_cache\":false,\"secret_aggregation\":false,\"fixture_key_generation_outside_timer\":true,\"all_measured_signatures_verified_outside_timer\":true,\"byte_identity_checked_in_separate_tests\":true,\"signing_serialization_and_job_scheduling_in_timer\":true,\"worker_pool_is_rayon_surrogate\":true,\"component_budget_ms_for_64\":1.0,\"component_gate_uses_mean_and_p95\":true,\"all_64_key_cases_within_budget\":{all_gates_pass},\"full_warp_target_seconds\":60,\"full_warp_gate_proven\":false,\"cases\":[{}]}}",
        std::env::consts::ARCH, std::env::consts::OS, std::thread::available_parallelism()?.get(),
        reports.join(","));
    if !all_gates_pass { std::process::exit(2); }
    Ok(())
}
