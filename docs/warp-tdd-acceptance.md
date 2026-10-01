# Warp: TDD and acceptance criteria

Date: 2026-09-30. Mandatory sequence requested by the user. Implementation was authorized by the
subsequent request to "start work", with a requirement for narrow changes. Partially completed
checks and open criteria are listed in [warp-tdd-results.md](warp-tdd-results.md). The matrix below
is not yet fully satisfied.

Latest user decision: **two explicit modes**, fast with ordinary skip penalties and slow honest
mode. Retain verified `direct-sync`, without integrating new cryptographic experiments. The mode is
selected in the controller, not through a separate bake. Honest mode remains the default and retains
the W criteria for economics/completeness; the user canceled its previous mandatory ≤60 s target.
Fast mode does not promise W03/W04/W07 within the skipped range, but must preserve real transitions,
EL/CL agreement, slashing protection, failure handling, and subsequent operation. Slashing is not an
acceptable price for speed. Contracts and current checks: [warp-modes.md](warp-modes.md).

## Flaw in the previous acceptance criteria

`bakes/shared/tests/warp.ts` checks active/unslashed status, timestamp, head agreement, intermediate
state availability, and signing history. Balances are only recorded in the report. After the
measured jump, the test separately allows up to 160 slots for finality recovery. These checks are
useful, but do not prove full participation within the jump or absence of economic consequences.

`bakes/shared/tests/withdrawal.ts` and `bakes/shared/tests/protocol.ts` use explicit `skipSlots` for
long intervals. Their success does not prove correctness of future warp with full duties. Separate
scenarios through `advanceTime`/`advanceTo` are needed, with operations before, within, and after
the range.

The old `verified` status applies to the old requirements. It does not confirm this document's
requirements. Adding executable checks must change the suite fingerprint.

## Contract and independent reference

Scope: one BN, a real EL, all required validator keys under the network's control, mainnet preset,
and 12-second slots. Pectra and Gloas pass the criteria independently. Ownership of a new key cannot
be assumed for an arbitrary deposit: its availability is explicitly checked, including activation
within the range. If full participation is impossible, penalty-free success is not promised.

`advanceTime`/`advanceTo` without options or with `{ mode: "honest" }` must reproduce normal
validator operation throughout the interval. Explicit `skipSlots` remains a separate downtime
scenario; its normal penalties cannot weaken warp requirements. Different economics or compensating
deposits do not fulfill this contract.

Verification oracles:

1. Identical genesis, keys, pre-jump state, operations and submission points, fee recipient,
   operation-selection policy, and other block-affecting inputs. Slow sequential execution with full
   participation and the fast path are compared at the same protocol time.
2. Ordinary verification functions from the pinned upstream independently replay the generated
   history with real BLS verification and state-root checks. The EL is checked for real execution
   and corresponding roots; Gloas envelopes are saved and replayed. Merely calling the same new
   helper from the "reference" does not count as independent verification.
3. Separate checks of duty completeness and economic accounting under the profile's rules. If the
   slow path itself misses required votes, it does not become a reference for absence of penalties.
   Requirements cannot be reduced to "the fast path repeated the slow path's error".

With identical block contents, exact root equality is expected. If the original scheduler permits
different packing choices, fix a deterministic policy before implementation. Inconvenient fields
cannot be arbitrarily excluded from comparison after a mismatch.

Check the trajectory at epoch boundaries and significant operations, not just the final balance. An
external effect may be temporary and disappear by the end of the range. Evidence includes CL/EL
roots, checkpoints, validator registry/balances/effective balances, participation, inactivity
scores, queues, receipts/logs, and signing history. Final API checks do not replace checking
internal transitions through independent history replay.

## Mandatory criteria matrix

Each row is a future executable scenario with its own result. Overall status of the full suite:
**not implemented / not verified**. Existing partial checks are listed below.

| ID  | Scenario                                                                                                 | Acceptance condition                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W01 | Small jump, 32/33-slot boundary, two honest 1000-slot / fast 8192-slot jumps, starting mid-slot          | `advanceTime` and `advanceTo` reach the requested time without undeclared duty skipping; full-slot history contains the expected blocks and transitions.                                                                                                                                                                            |
| W02 | 0, same date, fractional seconds down to milliseconds, past, invalid/oversized input                     | Zero advance leaves state unchanged; unsupported input is rejected before effects; the target date is not silently rounded; overflow is excluded.                                                                                                                                                                                   |
| W03 | Full participation during the jump                                                                       | All required proposal/attestation/sync duties are executed; Gloas also requires payload/envelope/PTC. Check participants, inclusion delay, participation flags, and signatures, not just internal marks.                                                                                                                            |
| W04 | Economics at every epoch transition and block with a sync aggregate                                      | No warp-induced penalties or new inactivity leak in an initially healthy network. Rewards, balances, effective balances, and inactivity scores match the reference; no manual compensation.                                                                                                                                         |
| W05 | Existing queues, withdrawals, consolidation, previously accumulated inactivity scores                    | Legitimate balance changes and queue processing match the reference. Balances need not be monotonic. Existing consequences are neither erased nor attributed to a new warp error.                                                                                                                                                   |
| W06 | Signatures throughout the range and after handing control back to the VC                                 | Complete verifiable history of expected signers; no double proposal, double vote, or surround vote. For slashable duties, slashing checks and durable recording occur before releasing a signature; other signatures are confirmed by messages/blocks. After handoff, the VC continues normal duties.                               |
| W07 | Finality during the jump and at successful return                                                        | Justified/finalized checkpoints match the reference at the same slots and advance through real votes. EL finalized matches the CL under the Gloas execution-parent rule. An extra 160 "recovery" slots do not satisfy this criterion.                                                                                               |
| W08 | All blocks, envelopes, and execution payloads                                                            | Correct parent links, state/execution roots, timestamps, Engine versions, withdrawals, requests, and profile-specific fields. Success is not returned with optimistic/INVALID/SYNCING state presented as confirmed.                                                                                                                 |
| W09 | Long real pause, protocol time far ahead of system time                                                  | Protocol state/head does not move during the pause. Real HTTP deadlines, JWT, and watchdogs use real time; a new block and transaction succeed after the pause.                                                                                                                                                                     |
| W10 | Deposit before warp with activation inside it, and deposit immediately afterward                         | Amount, validator pubkey/credentials, finality gate, queue, and activation epoch follow the rules. The new key begins duties on time; the deposit is neither lost nor applied twice.                                                                                                                                                |
| W11 | Signed voluntary exit and full withdrawal through warp                                                   | Correct exit/withdrawable epochs and mainnet delay, real EL payment exactly as specified by the protocol. Remaining sync duties are accounted for. Other validators continue without new penalties.                                                                                                                                 |
| W12 | Credential switch and consolidation through warp                                                         | Queues/churn, source/target balances, effective balance, status, and transition timing match the reference. Explicit test churn settings are identified separately; mainnet configuration is not silently changed.                                                                                                                  |
| W13 | Ordinary contract, state, and events before warp; dependent deployments and calls afterward              | Code/storage remain intact; `block.timestamp`, number, parent/hash, and available historical information match the generated history. Nonces/receipts/logs agree; events are neither lost nor duplicated; 20 sequential deployments, one per next slot, succeed after each jump.                                                    |
| W14 | Txpool: pending tx before the command, submission during it, nonce gap, underpriced tx, concurrent sends | Admission ordering and the range boundary are defined before implementation. Every accepted tx is preserved and executes exactly once under that policy or remains correctly pending. Closing a gap restores operation; the first post-warp tx does not wait for hidden range processing.                                           |
| W15 | Concurrent time commands, automine enable/disable, and shutdown                                          | One owner of time and signing; ordering is defined by the queue; no conflicting forkchoice/signatures, spontaneous blocks, hanging requests, or hidden warp continuing after shutdown completes.                                                                                                                                    |
| W16 | EL/BN/VC/controller failure, signer/DB/disk-write failure, timeout at phase transitions                  | A real-time-bounded error without false success. Signed history is not lost. The system either continues from a proven consistent position or explicitly blocks advancement until reset; automatic resume is not assumed.                                                                                                           |
| W17 | Exact epoch boundary, sync committee change, different balances, changing registry                       | Schedules and caches match current state. Check membership/multiplicity updates and proposer selection. Fork-domain signatures are checked separately; a full live fork transition is claimed only with separate support.                                                                                                           |
| W18 | Aggregate signer: different subsets, same/different messages, repeated positions                         | Result matches ordinary aggregation of individual signatures for the exact participant set. Invalid bits/domain/root/key/signature are rejected. Repeated PTC indices are preserved for pinned Gloas; zero/empty cases pass only under upstream rules.                                                                              |
| W19 | History reads and a real data consumer                                                                   | Blocks/states are available within the declared retention policy; processing queues and the indexer reach the confirmed head, and data matches the reference. An instant API response cannot hide unfinished history.                                                                                                               |
| W20 | Repeated jumps and network isolation                                                                     | After repeated jumps, no lost tasks/keys, stuck build jobs, ports, or containers. Memory/queues return to the range established by measurement; disk growth matches preserved history. A second network and unrelated Docker resources are unchanged.                                                                               |
| W21 | Performance of the complete successful path                                                              | Fast: two 8192-slot jumps, each including the first tx in ≤25 s. Honest: duration is measured and bounded by a profile watchdog (Gloas 20 min, Pectra 55 min); penalties and skipped duties for speed are prohibited. All standard result checks finish before return; deferred work and work moved to startup must not hide costs. |
| W22 | Unsupported bake, missing key/required capability, incompatible Engine API                               | Explicit diagnosable error; no silent fallback to skipped votes or weaker checks. An error does not become `verified`; resources are cleaned up only by exact ID.                                                                                                                                                                   |

Profile-specific fields in full state/payload are checked by independent replay even when not named
in the table: for example, system-contract changes, RANDAO, sync committee, historical roots, and
Gloas builder-related accounting. Extract the field list from the specific pinned version; one
expected JSON for all future hardforks is unsuitable.

## Red → Green → Refactor

1. **Before implementation**, define the contract, reference, operation inputs/boundaries, and
   measured budgets. Write a minimal W03/W04/W07 regression for the current large warp. It must
   reproduce missed participation/penalties or lagging finality on real clients. Save the command,
   bake key, seed/inputs, and actual assertion failure. Failure due to Docker, compilation, or a
   missing fixture does not count as behavioral red.
2. Separately prove that the new assertions detect errors: corrupted signatures, a missing
   participant, wrong domain/root, a lost signing-history record, an incorrect payout amount, and
   delayed finality must fail the corresponding tests. These controlled defects belong in test
   data/injections, not a production bypass.
3. Before each subsequent change, add the corresponding failing test from the matrix. Then implement
   the minimum behavior and repeat **the same** test. Existing valid checks, such as no slashing,
   may remain green; they need not be broken artificially.
4. First establish a correct complete path on small ranges, then accelerate it under the same
   oracles. For optimization, record a reproducible performance-budget violation before the change.
   Do not obtain green by removing checks, increasing the budget without agreement, fake crypto,
   fabricated finality, reduced protocol delays, or economic changes.
5. After green, refactor and separately rerun the original regression; then run relevant scenarios
   for the selected profile and its full release suite. Prototypes follow the same sequence.

## Performance and evidence completeness

Existing baseline including the next tx: Gloas stable **10.783/11.616 s**, Pectra default
**17.594/18.302 s**. These are two historical measurements of the old behavior. They provide a
reference, not a statistically robust p95. Before performance changes, repeat the selected baseline
under comparable conditions and record the comparison method. The user chose separate contracts:
seconds with real penalties in fast mode, a full honest flow with minutes permitted in honest mode.
The historical honest 8192 ≤60 s target is preserved in research notes and is not considered met.
Short checks are needed before another full honest run; state its expected duration in advance.

Metrics: full `advance → first confirmed tx`, separately the call duration, VC handoff, subsequent
deployment, CPU/RSS, queues, and disk. Save first and repeated executions; separate build/startup
from execution. If warmup or preparatory work is required, show its cost and effect on ordinary
startup explicitly. Fix resource limits and machine load before measurement; do not run resource
measurements alongside other devnet tests. Independent verification replay is an additional test;
account for its duration separately from the standard checks required for successful API return.

Thresholds for memory/queues and individual service delays are not yet established. These are **open
acceptance items** that must be measured and fixed before the corresponding changes. Do not choose
thresholds retrospectively to fit an observed result.

For each criterion, save: ID, implemented test, fixture/seed, profile/tag/bake key, suite hash,
command/run ID, red evidence, green evidence, duration, and independent replay result.
`not implemented`, `not run`, `blocked`, `failed`, and `passed` are distinct. Mock-only checks do
not establish EL/CL compatibility. Absence of log errors does not replace assertions.

## Mapping to current tests and profile independence

| Existing location                                                                   | Partial coverage                                                                           | Additions needed to accept the new warp                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bakes/shared/tests/warp.ts`, `warp_assertions.ts`, `tests/warp_assertions_test.ts` | Time, unslashed/status, post-jump signatures, head agreement, subsequent finality recovery | Participation/economics/signatures throughout the range, finality at return, independent replay, sequential operations after each warp. |
| `bakes/shared/tests/protocol.ts`, `withdrawal.ts`                                   | Real deposit/activation, consolidation, exit, and withdrawal                               | The same lifecycles through the new warp and comparison of exact transitions; distinguish mainnet from explicitly modified churn.       |
| `bakes/shared/tests/deploy.ts`, `e2e.ts`, `indexer.ts`, `tests/automine_test.ts`    | Transactions, automine, deployment, basic consumer                                         | Execution before/during/after warp and at time-ownership handoffs.                                                                      |
| `tests/time_test.ts`, `bakes/shared/controlled_clock_test.rs`                       | Time queue and scheduler                                                                   | New range executor, phase failures, partial progress, and preservation of pending work.                                                 |
| `bakes/gloas/tests/gloas.ts`                                                        | Gloas API and phase marks over a small slot count                                          | Full envelope/PTC contents over the range, signatures/repeated indices, forkchoice/finality, and replay.                                |
| `bakes/shared/tests/lifecycle.ts`, Docker/baker/verification tests                  | Lifecycle, ownership, and profile independence                                             | Failures during warp, executor handoff, and no false status for a new capability.                                                       |

Testing one bake must not rebuild or run all others. Shared unit/cryptographic checks run
separately; integration uses the selected `test:profile <hardfork> --bake <tag>`. When shared
implementation changes, every profile released with it must obtain its own compatibility evidence.
The new suite does not relabel old reports as passing.

Tests cannot prove the absence of every imaginable defect. The practical readiness condition is: the
entire applicable matrix is covered by executable checks and actual results, limitations are
explicit, and newly found defects first receive regression tests. While any mandatory criterion
remains unverified, the solution is not declared ready.
