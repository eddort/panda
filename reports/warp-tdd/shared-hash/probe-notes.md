# Shared public hash signing probe

This isolated ignored crate retains the ordinary `blst::min_pk::SecretKey::sign` baseline
and now adds a per-batch shared-public-H candidate. The primary task executed the baseline:
4 tests passed; performance exited 2 against the 1 ms budget. Source was copied unchanged
to `baseline-source/` before adding the candidate. Original `baseline*.txt/json` remain
untouched. Build or dependency failure is not RED.

The candidate computes H(root, DST, augmentation) ONCE inside each batch call, then signs
with each current key using BLST's unchanged `blst_sign_pk2_in_g1` primitive. Only the PUBLIC
point is copied into the same per-key worker jobs. It has no global hash cache, single-flight,
eviction, group secret, key cache, client hook or Docker operation. No client is changed.

## Observable acceptance criteria fixed before the candidate

- For every key in sizes 1, 2, 64 and 512, candidate bytes must equal ordinary `SK.sign`
  bytes for every tested root, DST and augmentation. Every timed signature is also
  verified using the unchanged BLS verification API; validation is outside signing timing.
- Exercise cold/distinct roots and repeated/primed roots. A different key, full root,
  DST or augmentation must not accidentally reuse another signing result or hash point.
- Preserve one genuine signature per requested key, ordering and multiplicity. No group
  secret, secret serialization, secret copies for caching, deterministic fake signature
  or unchecked cache success is permitted. Caller-owned keystore fixtures are not an
  optimization cache; the worker pool must retain no key after its jobs complete.
- The candidate's local immutable PUBLIC point belongs to exactly one context/call. Mixed
  contexts use separate calls, including simultaneous calls sharing the worker pool.
  Preserve the same secret multiplication primitive; public MSM must not handle secrets.
- Candidate tests cover every key in every size/executor/context, repeat/change roots,
  change DST/augmentation, simultaneous contexts and release/replacement of caller keys.
  Existing four baseline tests remain unchanged. Eviction/single-flight are inapplicable:
  there is no persistent hash cache. Candidate results are not claimed until executed.
- Preliminary component budget: mean AND nearest-rank p95 <= 1 ms for 64 signatures,
  including output serialization and, in worker cases, scheduling/results collection.
  Report each execution mode separately; a faster two-worker result cannot substitute
  for a one-worker deployment. This is not proof of 8192 slots + first tx <= 60 seconds.

## Upstream concurrency finding

Pinned Gloas source: `../oracle-gloas`, commit
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`.

- `validator_client/lighthouse_validator_store/src/lib.rs:1250` builds all sync signing
  futures and awaits `join_all`; it does not serialize all signers at the service layer.
- `validator_client/signing_method/src/lib.rs:198` submits EACH local-keystore signature
  to `spawn_blocking_with_rayon_async(RayonPoolType::HighPriority, ...)`.
- `common/task_executor/src/rayon_pool_provider.rs:34` chooses
  `max(1, floor(num_cpus::get() * 80 / 100))` high-priority Rayon threads.
  IF the VC detects 2 CPUs, its signer pool contains ONE worker, not two. Runtime
  `num_cpus::get()` has not been measured here; Docker quota is not itself that observation.
- `common/task_executor/src/lib.rs:241` uses one Rayon job and one Tokio oneshot per
  signature. The probe's persistent threadpool plus mpsc is a scheduling surrogate,
  not identical Rayon/Tokio overhead or the complete VC signing path.

The baseline reports serial, persistent one-worker and persistent two-worker modes. The
two-worker case is a controlled comparison, not a claim about the currently running VC.
`threadpool = 1.8.1` already exists transitively in the copied pinned lockfile; adding it
as a direct dependency introduces no new dependency package. BLST stays pinned to 0.3.17.

## Run and preserve evidence

The original baseline was run and preserved. The primary task next runs these commands
serially, not concurrently with other measurements:

```sh
cargo test --release --locked --offline > candidate-correctness.txt 2>&1
cargo run --release --locked --offline -- --mode candidate --batches 8 > candidate.json 2> candidate-stderr.txt
```

Preserve source snapshots, toolchain/architecture, CPU allocation and competing workloads
with the results. Do not overwrite the first baseline; use distinct filenames for repeats.
Use the same compiler, architecture, worker counts and allocation for the later candidate.
The probe emits valid JSON then exits 2 if any 64-key case exceeds its component budget;
argument/harness failures are exit 1. `--mode baseline` still selects ordinary signing;
use distinct output filenames for any new baseline measurements.

## Minimal unsafe boundary

`src/shared_hash.rs` contains exactly two documented unsafe blocks: one `blst_hash_to_g2`
per call and the exact `blst_sign_pk2_in_g1` used by `min_pk::SecretKey::sign`. Output buffers
are initialized and correctly typed. Input slices are live with exact lengths; the secret
is borrowed through BLST's `From<&SecretKey> for &blst_scalar`, never serialized or copied
by this code. A public affine result uses BLST's safe `Signature::from` conversion.
The crate denies unsafe elsewhere, and the CLI forbids it. Every measured signature
undergoes ordinary verification outside timing; separate tests check byte identity.

Primary sources, pinned to BLST 0.3.17:
- [SecretKey::sign and min_pk primitive selection](https://raw.githubusercontent.com/supranational/blst/v0.3.17/bindings/rust/src/lib.rs)
- [FFI argument types](https://raw.githubusercontent.com/supranational/blst/v0.3.17/bindings/rust/src/bindings.rs)
- [Signing primitive implementation](https://raw.githubusercontent.com/supranational/blst/v0.3.17/src/e2.c)

## Measurement boundaries and limits

The default is eight measured batches for each size/mode/root pattern; `--batches 1..128`
allows an explicit repeat count. Raw samples, first/min/max/mean/nearest-rank p95, signing,
serialization and separately labelled verification time are recorded. Eight samples are
a short probe, not a reliable tail-latency study. Size 64 runs first in each executor.

Key generation and public-key derivation, executor setup and warm-root priming are outside
the signing total; executor setup and priming elapsed times are separately reported. Each
job borrows existing fixture material through `Arc`, with no secret clone or serialization.
Timing includes queue submission/result collection and signature serialization. Every
measured result is checked with ordinary verification afterwards. Those checks are excluded
and insert a gap between batches; this is not a saturated VC throughput measurement.

Distinct-root batches model roots changing between real slots. Repeated-root batches prime
one batch outside timing, then repeat the same root as a cache diagnostic; real sequential
blocks cannot be assumed to repeat roots. Neither mode has a persistent hash cache, so these
labels describe inputs rather than an existing cache hit/miss. The candidate still computes
one H inside EVERY batch, including repeated-root batches. First samples retain lazy scheduling overhead;
they do not claim to reset CPU caches. No HTTP, state transition, slashing DB, signing-root
construction, keystore lookup, finality, storage, EL or first transaction is measured.
