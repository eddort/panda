> Archived working notes from immediately before the full-shape candidate run. Statements below that
> the candidate has not run are historical. The executed result and authoritative status are in
> [README.md](README.md): 12 library + 2 CLI tests passed, mean 1.562515 ms, exit 0.

# Full sync cryptography: baseline and ephemeral candidate

Isolated ignored research package. No client, Docker or production patch is changed. Dependencies
are pinned from the existing batch-proof lockfile; threadpool 1.8.1 and zeroize 1.8.2 were already
transitive blst dependencies. Execution environment and pool configuration are unchanged controls;
this comparison changes ONLY the signing/verification algorithm.

The primary agent executed the baseline: 9 tests PASS; mean 26.020323 ms, p95 26.243916 ms, cold
committee preparation 0.270916 ms, exit 2 (RED against the original <=3 ms mean-total gate).
Original source was copied to `baseline-source/lib.rs` and `baseline-source/main.rs` BEFORE changes.
Keep those files and the original baseline JSON/logs unchanged. The primary agent also executed the
four-group candidate: 12 tests PASS; mean 2.330891 ms, p95 2.457541 ms, cold committee preparation
0.306875 ms, exit 0 against the same <=3 ms mean-total gate. A preceding E0509 test-only build
failure was fixed and preserved separately; it was not performance RED. This is component evidence,
not a full-warp or native-integration result.

## Full-shape baseline and candidate phase

The completed four-group sources, Cargo files, README and original/candidate results were copied
BEFORE this CLI change into `four-group-evidence/`, with `sha256.json` for every archived file. The
new `--shape full` concatenates exactly the original four 128-position groups, preserving order and
every repeated key, into ONE 512-position output group. `src/lib.rs` and the cryptographic algorithm
are unchanged. The default `--shape subnets` retains the original four-group fixture. JSON schema 3
adds `shape`, `output_groups` and `positions_per_output_group`; the Ethereum committee still has
four subnets even when the research output is one full aggregate.

The primary agent executed the full-shape baseline first: 14 tests PASS (12 library +2 CLI), mean
27.816214 ms, p95 31.219375 ms, cold committee preparation 0.284292 ms, exit 2 against the same <=3
ms mean-total gate. Its baseline-only CLI/source snapshot is preserved in `full-baseline-source/`
with SHA-256 hashes. The following baseline commands produced that independently recorded RED:

```sh
cargo test --release --locked --offline > full-baseline-correctness.txt 2>&1
cargo run --release --locked --offline -- --mode baseline --shape full > full-baseline.json 2> full-baseline-stderr.txt
```

The implementing subagent has executed neither these measurements nor the candidate. The unchanged
baseline still signs/verifies all 64 individual keys, then forms one full signature with all 512
positions. The generic helper now has one excluded output oracle plus the excluded full-block
oracle; these diagnostics remain outside the total. Eight batches, warm-up, execution environment,
all timing boundaries and the mean-total <=3 ms gate remain unchanged. Two CLI/fixture tests assert
exact position preservation and acceptance of both modes. The second test was updated after baseline
execution; the updated tests and full-shape candidate are not yet executed.

`--mode candidate --shape full` is now enabled using the UNCHANGED existing generic helper: one
ephemeral sum/signature and one-entry randomized verification batch. No cryptographic helper,
execution environment or measurement boundary changed. Preserve the baseline files and use new
candidate output names:

```sh
cargo test --release --locked --offline > full-candidate-correctness.txt 2>&1
cargo run --release --locked --offline -- --mode candidate --shape full > full-candidate.json 2> full-candidate-stderr.txt
```

Native pool admission and BN restart support for a full aggregate remain unimplemented.

Baseline: resolve 64 CURRENT local keys, issue 64 ordinary signatures of one signing root, verify
all through the current randomized general BLS batch with individual subgroup checks, aggregate four
subnets of 128 positions (512 positions, including repeated keys). Four additional ordinary BLS
aggregate verifications are an EXCLUDED diagnostic oracle, not an assertion about the current BN
production path. Their individual outcomes are diagnostic: a zero subnet can fail despite a valid
full aggregate. A separate excluded FULL sync aggregate check decides ordinary output validity.
Public aggregate keys are prepared cold and reused. No secret cache.

The fixture guarantees all 64 keys are required and deterministically samples the remaining
positions with replacement. Subnet membership/multiplicities differ, so four identical aggregates
cannot accidentally make an unrealistically easy benchmark.

Candidate: take the same current-key snapshot, sum Fr scalars over every subnet position, sign once
per subnet, and verify the four genuine signatures using the EXISTING randomized general batch with
each signature's subgroup check and fresh independent nonzero 64-bit coefficients. There is no new
MSM verifier and no secret cache. A Drop guard zeroizes all Fr/scalar scratch before result
publication. Any final-zero subnet returns the WHOLE batch to baseline/direct-sync;
`route=individual_zero_subnet_fallback` and `fallback_probe_ms` make the fallback explicit.

## Run candidate while preserving RED evidence

```sh
cargo test --release --locked --offline > candidate-correctness.txt 2>&1
cargo run --release --locked --offline -- --mode candidate > candidate.json 2> candidate-stderr.txt
```

Correctness must pass before treating performance as evidence. The probe emits JSON and exits 2 only
on a measured component-budget failure; a build/test failure is not performance RED. Use new names
for repeats. `--mode baseline` remains available. No command above has been executed by the
implementing subagent.

## Measurement boundaries

Eight different-root steady batches follow one separately reported warm-up. Key generation and
loaded-keystore preparation are excluded. Cold committee/public aggregate-PK preparation has its own
timer and a nested pure-public-key-aggregation timer. The immutable committee object binds its
public-key cache to the exact positions/multiplicity; it cannot be reused with different membership.
Snapshot, signing jobs, fresh independent nonzero u64 randomizers, general verification, position
aggregation, warm public-key lookup and oracle verification have separate labels. Baseline total
includes the required path THROUGH aggregate formation and temporary allocations; the public-key
lookup and four output-oracle verifications occur AFTER total is captured and are excluded. The
component gate requires mean total <=3 ms (the provisional 1 ms signing +2 ms verification budget);
it does not establish 8192 slots <=60 seconds. Canonical byte serialization of 64 individual and
four aggregate signatures is included and reported separately; HTTP/JSON encoding and input
deserialization are not measured. JSON also reports p95, the diagnostic 1 ms signing/2 ms
verification subgates, and cold preparation plus mean pipeline time. The primary exit-code gate
remains the requested steady total <=3 ms, with cold preparation separately disclosed.

The existing pool configuration is fixed, not an optimization variable. Baseline issues individual
signatures; candidate issues genuine subnet aggregates. No HTTP, gossip, slashing DB, fork choice,
EL, block/state transition or historical storage in this component benchmark. No signatures or
secret bytes are printed. Use the same CPU/environment for later comparisons. An immutable registry
reference makes the harness snapshot consistent. Missing/replaced-key tests establish per-call
lookup behavior, not concurrent VC API disable/DELETE race safety.

Candidate total INCLUDES fresh live lookup, exact-position Fr sums, actual signing, four signature
serializations, warm PUBLIC key-cache lookup, fresh randomizers and the real four-signature batch
verification. Cold public-PK preparation remains separate. Four independent subnet checks and the
full-block oracle remain excluded in BOTH modes. Fallback total includes the attempted group work
plus baseline's required path, without its excluded oracles. JSON schema 2 names the signing timer
`signing_including_secret_sums_ms`; its scope includes all ephemeral scalar computation. The
original mean-total <=3 ms gate and diagnostic p95/1 ms/2 ms thresholds are unchanged.

## W18 controls and remaining integration gates

The tests establish ordinary expected outputs and real BLS controls for:

- 1/2/64/512 positions, arbitrary subsets, equal-size different-key groups and repeated keys;
- exact byte equality against independently signing EVERY position, preserving multiplicity;
- changed bits/keys/root/domain/signature and mixed roots/domains;
- intermediate zero (1 + (r-1) + 2) and final zero (1 + (r-1)); ordinary BLS rejects a nonempty
  zero-key aggregate, while the intermediate cancellation must preserve the final signer's result;
- empty input requires protocol-level handling: the special empty SyncAggregate rule is not silently
  replaced by a zero secret key;
- zero subtotal in one 128-position subnet with a valid full 512-position aggregate: ordinary
  individual/direct-sync succeeds even though one contribution-level oracle rejects infinity;
- a missing/replaced key after committee preparation fails current lookup before signing jobs.

Both modes now pass through the SAME byte comparisons, not merely verification against their own
computed public key. New tests cover position permutations, another DST, Drop wiping on success,
error, final zero and unwind, and four-signature admission rejecting swapped/non-subgroup signatures
and compensating +delta/-delta errors with an unchanged full signature. These 12 library tests
passed in the primary agent's four-group execution. The candidate API accepts exactly ONE root and
the fixed Ethereum DST per batch; it does not accept heterogeneous requests. Future integration must
partition/fallback before calling it for heterogeneous messages. If ANY subnet has a zero scalar
sum, fall back the ENTIRE batch to the existing individual/direct-sync path. Re-aggregating
individual signatures for the same zero subnet and submitting it to the new aggregate endpoint is
not an adequate fallback: contribution admission is stricter than the final full-block SyncAggregate
check. Resolve all live keys on every call; do not cache groups of secrets or retain deleted key
handles across calls. Drop/zeroize Fr/scalar scratch on every return/error and preserve ordinary key
guards. Shared public aggregate-key cache is allowed only for the exact immutable
membership/multiplicity.

Group math alone does not implement VC-to-BN transport, selection/membership validation, W06 durable
records for slashable duties, or full network W01-W22 release gates. This package cannot claim those
checks. Also unverified: concurrent key disable/DELETE behavior in the actual VC, remote signer
fallback, committee/fork boundaries, aggregate transport and operation-pool admission, live
deposit/activation, exits/consolidations, historical state/reward queries, failure recovery and the
full 8192-slot warp plus first transaction. Unweighted summation is not a verification shortcut.
