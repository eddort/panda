# Same-message BLS: isolated experiment

2026-09-30, Gloas dependency context, blst 0.3.17, Linux ARM64, Docker quota 2 CPU. This research
code is not linked into either client. **The <=2 ms component gate remains RED; 8192 slots plus a
transaction in <=60 seconds has not been demonstrated.**

| Version                     | Correctness   | Cold mean / p95    | Warm mean / p95    |
| --------------------------- | ------------- | ------------------ | ------------------ |
| Baseline general batch      | 11 tests PASS | 15.592 / 21.663 ms | 15.065 / 15.321 ms |
| Same-message randomized MSM | 14 tests PASS | 3.329 / 3.433 ms   | 4.229 / 7.660 ms   |

Baseline ran before candidate implementation; both performance processes emitted JSON and exited 2.
The candidate is 3.6–4.7 times faster in this paired component probe, with 32 batches per case. Warm
success cache contains earlier roots; it cannot skip measured signatures. RNG, subgroup checks,
packing, serialization and cache insertion are included. Fixture keys and signatures are prepared
outside verification timing. A separately timed subgroup diagnostic is excluded and cannot be
subtracted from the parallel batch as though it were serial work.

`baseline-source/` and `candidate-source/` preserve both exact Cargo packages. The candidate uses
safe blst MSM wrappers with exactly eight bytes per nonzero 64-bit coefficient. It preserves
individual subgroup checks, mixed-root fallback and safe fallback for a zero weighted public key.
Tests include every corrupted position, swapped assignments, compensating invalid signatures, wrong
root/DST, subgroup/infinity inputs, duplicates and malformed coefficient stride.

## Reproduce

From the repository root, after checking that no other resource measurement is running:

```sh
./scripts/deno run -A reports/warp-tdd/same-message/run.ts baseline
./scripts/deno run -A reports/warp-tdd/same-message/run.ts candidate
```

The reproduction runner uses the saved sources and the recorded builder image, sequentially, with 2
CPU. It writes into ignored `.cache/warp-native/reproduce-same-message-<mode>/` and refuses to
overwrite an existing result. It uses existing Rust Cargo/target caches and removes only its own
exactly labelled probe container. `run-original.ts` preserves the script actually used for the
recorded run at its original `.cache/warp-native/` location; its imports are relative to that
original location. The reproduction adapter itself has been type-checked, not benchmarked again.

Raw JSON, correctness logs, compiler stderr and environment/source hashes are retained alongside
this file. No VC scheduling, HTTP, state transition, EL execution, history, duty coverage, slashing
protection or first transaction is measured by this harness.
