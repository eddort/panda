# Warp experiment log

2026-09-30. Historical target of the research cycle: **8192 slots including the first subsequent
transaction in ≤60 seconds**, without a major client rewrite or penalties from missed duties. 25
seconds remains the desired result. The user had not accepted runtimes of minutes: the assistant's
earlier interpretation was incorrect.

Latest constraint: further investigation must focus on **algorithms only**, without tuning threads
or scheduling. Old results are preserved; new comparisons use a fixed environment.

**Subsequent user decision:** stop searching for speedups, retain `direct-sync`, and provide two
modes on one bake: fast with real penalties and slow honest mode. Group signature/MSM/shared-H
prototypes remain archived only. All eight native inputs matched Gloas `direct-sync` (`e41c863b…`),
so no client rollback or rebuild was required.
[Two-mode contract and new verification](warp-modes.md).

This is an index of experiments performed and options rejected. Detailed commands, bake keys, and
RED/GREEN evidence are preserved in the [actual results](warp-tdd-results.md). Theoretical proposals
do not count as measured speedups. Full [acceptance](warp-tdd-acceptance.md) has not yet passed.

| Experiment                                         | What was tested                                                                   | Actual result                                                                                                                                                        | Decision / limitation                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old skip with a short tail                         | Jump through time quickly and restore operation                                   | Gloas stable: 10.783 / 11.616 s; Pectra default: 17.594 / 18.302 s for 8192 + tx                                                                                     | Fast, but skipped duties cause penalties. Unsuitable for honest warp. History in `docs/bakes.md` and old `warp.json` files.                               |
| Removal of automatic skip                          | Execute every slot with the regular phase executor                                | RED: one block instead of 96, flags 0, penalties; GREEN on both profiles: 96 blocks, participation, and finality. About 32 s/96                                      | Fixes short-range economics, but speed is insufficient. `reports/warp-tdd/{red,green}/`.                                                                  |
| Extended economics regression                      | All sync bits, Gloas PTC, slashing, next deploy                                   | Both profiles passed 192 blocks; the first Gloas deploy with 100k gas failed, and the corrected profile fixture passed                                               | The gas error is not a successful test. Explicit skip in old protocol/withdrawal tests does not prove the same operations through honest warp.            |
| Initial bound on a large run                       | Check 25 s without waiting for a predictably slow range                           | Pectra 78/8192 and Gloas 74/8192 in 25 s                                                                                                                             | Performance RED; the first tx was not attempted.                                                                                                          |
| Phase diagnostics                                  | Separate proposal, sync, aggregate, PTC, and fork choice                          | Gloas 32 slots in 11.158 s; attestation/sync 240.18 ms/slot                                                                                                          | The main initial delay is in voting; do not add nested timings to their parents.                                                                          |
| `honest-v1`: cache of exact successful BLS checks  | Repeated subnet checks for the same key/root/signature                            | Native RED/GREEN; 32 slots in 5.749 s; economics 96 in 15.771 / 16.074 s                                                                                             | Cache of 512, only real positive checks; membership/state checks remain.                                                                                  |
| `honest-v2`: native completion wait                | Remove polling for exact phase marks                                              | Native/controller RED/GREEN; 32 slots in 4.917 s; economics 96 in 14.143 / 13.598 s                                                                                  | Bounded real timeout, condvar; old bakes retain the old protocol. Large test RED: 177/8192 in 25 s.                                                       |
| `honest-v3`: randomized sync batch verification    | One batch instead of independently repeating cryptography                         | 8 native tests; economics 96 in 13.921 / 11.678 s                                                                                                                    | Real random coefficients, subgroup checks, and standard structural checks; an invalid batch does not populate the cache.                                  |
| Engine head notification                           | Additional notification that the EL head is ready                                 | 32 slots: 4.411→4.372 s in one comparison                                                                                                                            | Excluded from implementation: the small unconfirmed gain does not justify new synchronization. The `engine-head*` logs are historical.                    |
| Waiting for a ready Geth payload                   | Investigate suspected EngineGate wait                                             | 0.705 ms total/32, about 0.022 ms/call                                                                                                                               | This waits for an already ready payload, not the entire Engine RPC/build/execution cost. The wait alone does not explain minutes.                         |
| Prometheus/Docker v3 profile                       | Amount of work performed by BN/VC/EL                                              | 32 slots in 3.857 s; VC 11615 signing jobs, including 8192 sync proofs + 991 wrappers + 2048 sync messages                                                           | 79.1% of jobs in the sample window is not 79.1% of time. Snapshots include lookahead/background work. No CFS throttling was observed.                     |
| `direct-sync`: delivery of complete verified votes | Remove election and wrappers, retain individual signatures                        | Native RED/GREEN; ordinary mode, missing/corrupt/duplicate, one key with 512 positions and no aggregator. Live economics 96: 8.292 / 9.033 s; deploy 0.109 / 0.099 s | Root-bound BN barrier. A removed sync key causes an error in 30.082 s before the next block; further advancement requires reset.                          |
| Direct-sync metrics                                | Compare with v3 under the previous limits                                         | 32 slots in 2.956 s; VC 2432 jobs; 2048 individual sync signatures retained. VC CPU 1.098 versus 4.393 CPU-s                                                         | About 23.4% faster for the short call; the 60 s target requires another ≈12.6×. This is one measurement, not p95.                                         |
| Independent Gloas CL replay                        | Verify real history with ordinary upstream                                        | 64 blocks 129–192 and envelopes: signatures, every state root, and byte-for-byte post-state SSZ matched; 4.390 s. Tampered signatures were rejected                  | Not independent EL execution or 8192 slots. Clean replay includes the old expensive weighted selection: its duration is not a lower bound for production. |
| Full direct-sync profile                           | Baseline/lifecycle/e2e, long warp, remaining scenarios                            | First 3 scenarios passed. Warp **FAILED after 12m40s** on rewards API 404 for pruned state 191; EL reached 8320 and the next tx at 8321                              | The second 8192-slot advance was not executed. Exact advance duration was not saved. Incorrectly removing the 25 s gate led to an unacceptably long test. |
| Continuation of the same full profile              | Repeat economics, then protocol                                                   | Economics failed because the Geth image was missing; protocol was interrupted by the user                                                                            | Why the image disappeared in this run is unknown. Containers from the interrupted run were removed by exact IDs; the runtime process exited.              |
| Pectra direct-sync                                 | Port the shared native test to the older pinned Lighthouse                        | Found and adapted 2 fixture API differences; patch clean-apply passed                                                                                                | A new Pectra bake and native/live checks **were not run**. Gloas GREEN cannot be transferred to Pectra.                                                   |
| Docker artifact recovery                           | Runtime image disappeared before packaging; Docker HTTP 200 contained errorDetail | Regression RED/GREEN, 4 real baker/Docker checks passed                                                                                                              | Separate infrastructure fix; not a warp speedup. Global Docker cleanup is prohibited.                                                                     |

The previously prepared Gloas `weighted_selection` and `prepare_skip` belong to the earlier stable
path: results and rationale are recorded in the [version history](bakes.md) and
[research](warp-honest-fast-forward-research.md). Their presence does not authorize automatically
skipping duties in `advanceTime`/`advanceTo`.

## Preserved evidence from the last run

- [Full interrupted profile log](../reports/warp-tdd/native/direct-sync-profile-interrupted.log).
- [Facts and termination record](../reports/warp-tdd/native/direct-sync-profile-interrupted.json).
- [EL tail with the first subsequent tx](../reports/warp-tdd/native/direct-sync-long-warp-el-tail.log).
- [Immutable bake native tests](../reports/warp-tdd/native/direct-sync-gloas-bake-tests.log).
- [Independent replay and hashes](../reports/warp-tdd/native/direct-sync-replay.json).
- [Short resource measurement](../reports/warp-tdd/native/metrics-gloas-direct-sync.json).

Generated `verification.json` remained `passed:false,status:running` after SIGINT. This is an
incomplete, unsuccessful run, not a running process or a verified bake. It was not manually
corrected.

## Short cryptographic probes

New isolated BLS baseline (same pinned Rust/blst, ARM64, 2 CPU): 11 correctness checks passed; 64
signatures of one message took **15.592 ms** with an empty success cache and **15.065 ms** with a
cache filled with other roots. The preallocated component budget of ≤2 ms was not met: performance
RED was preserved, exit 2. RNG, subgroup checks, serialization, and cache population are included.
This is not a network benchmark. [Raw data](../reports/warp-tdd/same-message/baseline.json),
[tests](../reports/warp-tdd/same-message/baseline-correctness.txt).

After saving the baseline, the same-message MSM candidate ran: **14 tests PASS**; mean **3.329/4.229
ms**, p95 **3.433/7.660 ms**. The component became 3.6–4.7 times faster, but did not reach ≤2 ms:
performance remains RED. The client was unchanged; full warp was not run.
[Result](../reports/warp-tdd/same-message/candidate.json),
[checks](../reports/warp-tdd/same-message/candidate-correctness.txt).

Shared-H signing probe: ordinary baseline — 4 tests PASS; candidate — 7 PASS. Creating 64 signatures
with changing roots: one worker **20.234 → 10.731 ms**, two workers **14.081 → 5.508 ms**. The
candidate computes the public hash point once per batch while retaining all individual signatures.
The ≤1 ms gate remains RED; the comparison has eight samples, and the pool models VC scheduling.
[Data, limitations, and both source versions](../reports/warp-tdd/shared-hash/README.md).

Group-sync baseline: **9 tests PASS**, mean **26.020 ms**, p95 **26.244 ms**, cold preparation
**0.271 ms**. Measured live lookup, 64 signatures, their real verification, and assembly of four
aggregates; additional oracle checks are excluded. The tests already reproduce a zero subnet with a
valid full SyncAggregate. The mean ≤3 ms gate is RED, saved before implementing the candidate.
[Baseline](../reports/warp-tdd/group-sync/baseline.json),
[checks](../reports/warp-tdd/group-sync/baseline-correctness.txt).

After the baseline, the ephemeral group candidate ran: **12 tests PASS**, mean **2.331 ms**, p95
**2.458 ms**, cold preparation **0.307 ms**. Temporary scalar sums are cleared on every path;
results match ordinary signatures byte for byte. Required randomized verification of the four
results is included. The ≤3 ms component gate is **GREEN**. The first build error, E0509 in the test
fixture, is saved separately and does not count as RED; its fix did not change the algorithm.

The next paired experiment used one full aggregate over 512 positions: baseline **27.816 ms** / p95
**31.219 ms** → candidate **1.563 ms** / p95 **1.612 ms**. Candidate cold preparation was **0.266
ms**. Both runs passed 12 library + 2 CLI tests. The baseline ran before enabling the candidate CLI;
the cryptographic helper and environment were unchanged. The ≤3 ms gate is **GREEN**. This is about
17.8× for this component, not for the entire network.
[All sources, raw evidence, verification limits, and reproduction](../reports/warp-tdd/group-sync/README.md).

Production integration, pool/restart safety, the entire slot, and 8192 + tx have not yet been
measured. All component GREEN results apply to the standalone probe, not a completed bake. The
[algorithm design and identified risks](warp-group-sync-research.md) are also preserved.

## Algorithmic peer review findings

The [remaining budget](warp-algorithm-budget.md) does not establish that component GREEN already
puts the entire network within one minute. [PTC and lifecycle](warp-group-sync-research.md) allow
repeated public points to be combined by multiplicity, but the native gain has not been measured.
The [attestation path](warp-attestation-research.md) already supports inclusion without wrappers;
removing them in controlled mode requires a strict FC/full-coverage gate. These are initial designs
for future TDD checks, not additional measured speedups. The client was unchanged, and the large run
was not repeated in this research cycle.

## Archived research-cycle rule

First identify a concrete source of the required gain and a failing regression, then run a minimal
isolated probe, followed by 32/256 slots with all checks. For 60 s, the average full budget is 7.324
ms/slot minus the first tx. Do not run a predictably slow candidate for 8192 slots. Do not move
cryptography, history, DB work, or the first tx outside the measurement. The previously added
30-minute watchdog in `warp.ts` was incorrect for this target. After the two-mode decision it was
replaced with separate budgets; the previous honest ≤60 s target was canceled. No new experiments
are planned.
