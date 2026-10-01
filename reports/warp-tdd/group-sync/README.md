# Ephemeral sync aggregate: isolated RED → GREEN

2026-09-30. Research only; no client code was changed or full warp measured. Fixed Linux ARM64
environment, pinned Rust image and 2 CPU limit in [environment.json](environment.json). This
compares algorithms with the environment held constant.

| Output shape         | Baseline mean / p95 | Candidate mean / p95 | Cold committee preparation, candidate | Component gate |
| -------------------- | ------------------: | -------------------: | ------------------------------------: | -------------- |
| Four × 128 positions |  26.020 / 26.244 ms |     2.331 / 2.458 ms |                              0.307 ms | RED → GREEN    |
| One × 512 positions  |  27.816 / 31.219 ms |     1.563 / 1.612 ms |                              0.266 ms | RED → GREEN    |

The predeclared component gate is **mean ≤3 ms**. Eight timed batches use distinct signing roots;
these samples do not establish long-run tail latency. Baseline was executed and saved before each
candidate. Exit 2 means the performance gate failed after passing correctness; candidate exits
are 0. The full-shape baseline was executed before enabling that candidate CLI path. The group
helper itself was unchanged between the four-group and full-group comparisons.

Baseline resolves 64 current keys, produces their ordinary individual signatures, performs the
existing general randomized verification and aggregates the signatures at all 512 positions.
Candidate resolves the same current keys, builds temporary scalar sums with the exact positional
multiplicities, signs those sums and performs the same general randomized verification on four or
one resulting signatures. No secret sum survives the call. No signature verification is replaced
with a local-trust flag.

Cold committee/public-key preparation is reported separately. Live key lookup, scalar sums, signing,
serialization and required verification including RNG are timed. Independent ordinary aggregate and
full-aggregate verifications are correctness oracles outside both timers; they are not extra
production work charged only to the baseline. Baseline also excludes its negligible public-key cache
lookup, while candidate includes it. The probe models crypto and local key resolution, not Beacon
HTTP, operation-pool insertion, state transition, EL or disk persistence.

## Correctness and evidence

- Four-group baseline: [9 passing tests](baseline-correctness.txt), [timing](baseline.json).
- Four-group candidate: [12 passing tests](candidate-correctness.txt), [timing](candidate.json).
- Full-shape baseline: [12 library + 2 CLI tests](full-baseline-correctness.txt),
  [timing](full-baseline.json).
- Full-shape candidate: [12 library + 2 CLI tests](full-candidate-correctness.txt),
  [timing](full-candidate.json).

Checks include byte equality with ordinary signatures for 1/2/64/512 **positions** (at most 64
distinct keys), multiplicity and order, different roots/domains/keys, current missing/replaced keys,
intermediate-zero sums, final-zero fallback, invalid bits and signatures, subgroup checks,
swapped/compensating signatures, and scratch zeroization on success/error/zero/unwind. A zero subnet
with a valid nonzero full aggregate requires falling back for the **whole batch**. Native proof that
the old path produces the same block/state on this fallback remains pending.

The first candidate build failed on Rust E0509 in test-fixture construction. That is preserved in
[candidate-build-failure.txt](candidate-build-failure.txt) and
[the corresponding source](candidate-build-failure-lib.rs); it is not performance RED. The fix
initialized the Drop-bearing fixture before assigning its observer; the algorithm was unchanged.

Complete tested sources are archived in `baseline-source/`, `candidate-source/`,
`full-baseline-source/` and `full-candidate-source/`, with SHA-256 in `environment.json`. The
original baseline manifest was reconstructed by removing only the subsequently added direct zeroize
dependency and its local-package lock entry; the implementing agent confirmed that exact delta. The
zeroize package was already transitive. Original source and measured outputs are intact.

## Reproduction

From the repository root, with the recorded Rust builder and warmed offline Cargo cache:

```sh
./scripts/deno run -A reports/warp-tdd/group-sync/run.ts baseline four
./scripts/deno run -A reports/warp-tdd/group-sync/run.ts candidate four
./scripts/deno run -A reports/warp-tdd/group-sync/run.ts baseline full
./scripts/deno run -A reports/warp-tdd/group-sync/run.ts candidate full
```

The adapter copies the selected archive to a new ignored reproduction directory and refuses to
overwrite it. It uses the existing bake-cache lock and removes only its exact-label container. The
adapter was type-checked; it was not rerun to replace these measurements. The original executed
scripts are [run-original.ts](run-original.ts) and [run-full-original.ts](run-full-original.ts),
archived with their original `.cache/warp-native/` relative imports.

## What is not proven

**8192 slots plus the next transaction ≤60 seconds is not proven.** Neither API/pool integration,
restart/skip failure safety, economics, finality nor Pectra native compatibility was exercised by
this standalone probe. The full aggregate needs a deliberate pool/persistence contract and a
production guard against missing participation. See
[the integration research](../../../docs/warp-group-sync-research.md) and
[the required acceptance matrix](../../../docs/warp-tdd-acceptance.md).
