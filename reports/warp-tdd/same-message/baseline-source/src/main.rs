use panda_same_message_proof::{fixture, probe, SuccessCache, Timings};

fn ms(ns: u128) -> f64 { ns as f64 / 1_000_000.0 }

fn report(label: &str, samples: &[Timings]) -> (String, f64) {
    let mean = |f: fn(&Timings) -> u128| ms(samples.iter().map(f).sum::<u128>()) / samples.len() as f64;
    let mut totals: Vec<_> = samples.iter().map(|s| s.total_ns).collect();
    totals.sort_unstable();
    let p95 = totals[((totals.len() * 95).div_ceil(100)).saturating_sub(1)];
    let mean_total = mean(|s| s.total_ns);
    let records = samples.iter().map(|s| format!(
        "{{\"randomizers_ms\":{:.6},\"general_batch_with_subgroup_ms\":{:.6},\"serialization_ms\":{:.6},\"cache_insertion_ms\":{:.6},\"total_ms\":{:.6},\"subgroup_only_diagnostic_ms\":{:.6}}}",
        ms(s.randomizers_ns), ms(s.general_batch_with_subgroup_ns), ms(s.serialization_ns),
        ms(s.cache_insertion_ns), ms(s.total_ns), ms(s.subgroup_only_diagnostic_ns),
    )).collect::<Vec<_>>().join(",");
    (format!("{{\"label\":\"{label}\",\"batch_count\":{},\"mean_total_ms\":{mean_total:.6},\"first_batch_ms\":{:.6},\"p95_total_ms\":{:.6},\"mean_randomizers_ms\":{:.6},\"mean_general_batch_with_subgroup_ms\":{:.6},\"mean_serialization_ms\":{:.6},\"mean_cache_insertion_ms\":{:.6},\"mean_subgroup_only_diagnostic_ms\":{:.6},\"samples\":[{records}]}}",
        samples.len(), ms(samples[0].total_ns), ms(p95), mean(|s| s.randomizers_ns),
        mean(|s| s.general_batch_with_subgroup_ns), mean(|s| s.serialization_ns),
        mean(|s| s.cache_insertion_ns), mean(|s| s.subgroup_only_diagnostic_ns)), mean_total)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if !args.is_empty() && args != ["--mode", "baseline"] {
        return Err("only --mode baseline is implemented; candidate requires a later TDD step".into());
    }
    const BATCHES: usize = 32;
    const KEYS: usize = 64;
    const BUDGET_MS: f64 = 2.0;
    // Key generation, signing and validated key-cache creation are outside a verification probe.
    // Each request uses a distinct signing root, as in a real sequential warp.
    let fixtures: Vec<_> = (0..BATCHES * 2).map(|i| fixture(KEYS, i as u64 + 1000)).collect();
    let mut cold = Vec::new();
    for input in &fixtures[..BATCHES] {
        cold.push(probe(input, &mut SuccessCache::default())?);
    }
    let mut warm_cache = SuccessCache::default();
    // Prime only cache data, outside the warm timing; no verification result is invented.
    for input in &fixtures[..8] { probe(input, &mut warm_cache)?; }
    let mut warm = Vec::new();
    for input in &fixtures[BATCHES..] { warm.push(probe(input, &mut warm_cache)?); }
    let (cold_json, cold_mean) = report("cold_success_cache_distinct_roots", &cold);
    let (warm_json, warm_mean) = report("warm_success_cache_distinct_roots", &warm);
    let gate_pass = cold_mean <= BUDGET_MS && warm_mean <= BUDGET_MS;
    println!("{{\"schema\":1,\"mode\":\"baseline\",\"blst\":\"0.3.17\",\"rand\":\"0.9.2\",\"arch\":\"{}\",\"os\":\"{}\",\"available_parallelism\":{},\"keys_per_batch\":{KEYS},\"batch_count_per_case\":{BATCHES},\"pk_validation_outside_timer\":true,\"cache_mutex_included\":false,\"subgroup_check_in_general_batch\":true,\"diagnostic_subgroup_excluded_from_total\":true,\"correctness_tests_run_separately\":true,\"budget_ms_per_batch\":{BUDGET_MS},\"component_gate_pass\":{gate_pass},\"full_warp_gate_proven\":false,\"cases\":[{cold_json},{warm_json}]}}",
        std::env::consts::ARCH, std::env::consts::OS, std::thread::available_parallelism()?.get());
    if !gate_pass { std::process::exit(2); }
    Ok(())
}
