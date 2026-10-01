# Accelerated duty execution during warp

**Current status:** this document preserves earlier research rounds. Direct sync has already been
implemented and checked separately, but the one-minute budget was not met: 32 slots took 2.956 s.
The full profile was stopped after a failed test lasting 12:40. The current target is 8192 slots and
the first subsequent transaction in ≤60 s. All experiments are collected in the
[log](warp-experiments.md); new candidates and their limitations are in the
[one-minute budget research](warp-one-minute-research.md). The "next steps" below belong to dated
historical rounds, not the current plan.

Research date: 2026-09-30. The findings below predate implementation. A subsequent request
authorized TDD work with narrow changes; new measurements and actual status are in
[warp-tdd-results.md](warp-tdd-results.md). The proposed native executor is not yet implemented.

## Reassessment after measurements

On September 30, the user requested a theoretical cycle with subagents. Three areas — transition
dependencies, the measured pipeline, and correctness counterexamples — were compared again after
measuring Gloas `honest-v3`. No new implementation was added in this cycle. Measurement facts are in
the [report](warp-tdd-results.md#gloas-honest-v3-diagnostics): 32 slots in 3.857 s, 11,615 signing
jobs in the observation window, and no CPU throttling. One range request alone does not eliminate
this work. A budget of 25 s / 8192 requires less than 3.052 ms per slot with room for the next
transaction; achieving that duration is not yet substantiated.

**The selected direction for the next TDD step is direct delivery of real sync contributions within
the existing VC/BN, preserving individual validator signatures.** The 8192 sync selection proofs and
991 gossip-wrapper signatures account for 79.1% of jobs in the measured window. These signatures
select and authenticate aggregators, but are absent from the final block `SyncAggregate`. Removing
them is a narrower first step than summing secret keys. This is a share of jobs, not a promised time
saving. Proofs are prepared 64 slots ahead: moving computation outside the measurement does not
count as acceleration. See
[lookahead](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/src/lib.rs#L75)
and
[proof computation](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/validator_services/src/sync.rs#L624).

The VC remains the sole signing owner. Moving all duties to a new executor and transferring keys to
it are unnecessary to test this hypothesis. The shared part applies to Pectra and Gloas; integration
is checked separately for every released bake.

### What a frame means

A frame ends at the next epoch boundary, at most 32 slots away. Known duties, committee memberships,
and independent signatures are prepared ahead: RANDAO by key/epoch/domain, selection proofs for the
remaining ordinary paths by key/slot/subnet/domain. Once a block is accepted, the root for
subsequent signatures is known. Real EL payloads, block/state roots, durable protection for
slashable signatures, imports, Gloas envelopes/PTC, and epoch transitions run sequentially. At frame
boundaries, schedules, key membership, and domains are refreshed; key-registry changes within a
frame must also invalidate dependent caches. A frame is not an atomic transaction: an error leaves
an explicitly identified confirmed position and does not roll back already signed history.

Knowing the final time does not reveal the final state root. Even without user transactions, RANDAO,
rewards, automatic withdrawals, and parent roots change; historical roots and checkpoints contain
real intermediate roots. A reward-sum formula cannot reconstruct this history. In pinned Gloas, some
execution requests are applied by the child block; moving operations across an epoch changes the
result. See pinned
[per-slot transitions](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_slot_processing.rs#L121),
[parent request processing](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_block_processing.rs#L555).

### Sync: completeness before speed

An open risk was found in the current path: availability of every key does not guarantee election of
at least one sync aggregator in every subnet of every slot. Selection proofs choose aggregators
randomly; repeated positions of one key do not provide independent attempts. Individual messages
enter `naive_sync_aggregation_pool`, while blocks are built from contributions in another operation
pool. A successful barrier for elected aggregators therefore does not prove 512 participants in the
next block. This is a source-derived conclusion, not a failure already reproduced by a long test.
See
[selection proof](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/sync_committee/sync_selection_proof.rs#L48),
[operation pool](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/operation_pool/src/lib.rs#L119).

Minimal sequence of changes under tests:

1. In controlled mode, deliver four real contributions from already verified individual messages
   directly into the existing operation pool, preserving exact slot/root, membership, and
   fully-valid execution status. Phase success requires 128 bits in each subnet. Test the case with
   no elected aggregator. The public gossip path stays unchanged; no fake `VerifiedSyncContribution`
   is created. `insert` itself does not validate input: a new receiver accepting data from the VC
   must verify the aggregate with standard cryptography.
2. For this internal path, eliminate unnecessary sync selection proofs and gossip wrappers. Keep
   ordinary validator signatures. Compare block/state roots, economics, and checkpoints;
   independently replay history with the ordinary upstream verifier. Then measure the remaining
   cost.
3. If measurements justify the next step, replace contribution generation inside the same local
   signer with `Sign(Σ multiplicity × secret_key, signing_root)`. First compare it byte for byte
   with ordinary aggregation. The key-sum cache is bound to the exact multiset of
   pubkeys/multiplicities, not the active-validator count. An exited validator may continue sync
   duties. Secrets remain inside the signer and are cleared at the end of their lifetime.

First RED checks: no elected aggregator despite all real sync messages; a missing key/invalid
signature prevents a successful barrier; exit with retained sync membership followed by committee
change. A group signer additionally requires repeated positions, different subsets of the same size,
wrong bits/root/domain, and zero-sum cases. Producing every individual gossip packet is not promised
by the direct path; real participant signatures and all consensus transitions are mandatory.

### Gloas PTC: a separate correctness boundary

A direct PTC aggregate cannot simply be placed into the next block: its votes must affect live
forkchoice on time. First verify slot/root, the exact PTC with repeated positions, a valid envelope,
and payload/blob availability flags; then apply votes to forkchoice and inclusion through the
standard path. This is visible in the separate
[apply and insert](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/beacon_chain.rs#L2349)
steps. The first sync step leaves PTC unchanged. Any future optimization needs a separate forkchoice
comparison **before the next proposal**, including missing/invalid envelopes, duplicate delivery,
and epoch boundaries. With 64 validators, PTC has about two assignments per slot: current data does
not justify taking greater risk by optimizing it first.

This is a justified research direction, not proven speed or a finished algorithm. Current BN block
production at ≈6.38 ms and envelope processing at ≈4.06 ms per call mean that replacing only the
sync signer is insufficient to promise 25 s. These durations include the current
implementation/scheduling and are not physical lower bounds. Each narrow step needs measurements
under unchanged checks; do not write an entirely new executor before proving the remaining
bottleneck.

## Original proposal

Propose a shared native slot-range executor for all supported profiles. It executes real duties of
controlled validators, builds blocks through a real EL, performs CL checks, and obtains finality
from included votes. Every slot retains ordinary mainnet state transitions, rewards, withdrawals,
and queue processing.

Economic parameters do not change. The user rejected the previous option of a separate bake with
different economics; it is not an implementation direction.

**Matching the current 10.783–11.616 s for 8192 slots including the next transaction is not yet
proven possible.** A concrete way to reduce work was identified, but there is no ready upstream API
that both does everything listed and achieves this duration. Replacing HTTP polling alone does not
prove it.

Control of every key allows computations to be combined. It does not reveal future block/state roots
before prior transitions execute. A history with a block in every slot has a sequential dependency
through parent root, execution hash, and state root. Work remains proportional to slot count; a
prebuilt chain does not fit arbitrary state after deployment, deposit, or consolidation. See
[state transition](https://ethereum.github.io/consensus-specs/specs/phase0/beacon-chain/#state-transition).

## Where to reduce work

### 1. One request per range, internal events instead of polling every step

Currently, `src/consensus.ts:34` advances BN/VC through separate HTTP calls, fetches committees, and
polls marks, Beacon head, and EL/CL agreement. `src/http.ts:19` starts retries with a 10 ms delay.
Clock HTTP in `bakes/shared/controlled_clock.rs` closes the connection after each response. The
Engine gate runs on the host; Docker requests go back through the host to the EL.

Candidate: Deno sends one range command; a native loop next to Lighthouse executes phases until
confirmed completion using direct calls/events. The EL connection and gate are in the same Docker VM
with persistent connections. Phase completion means the result was accepted, not merely queued. Real
network deadlines and JWT remain.

Protocol clocks traverse the required points sequentially; waits of 3/4/6/9 seconds occur in virtual
time. The next slot starts after all mandatory actions in the current slot complete. The hardfork
adapter defines concrete duties and dependencies. Gloas must retain payload envelopes and PTC, plus
its mapping of finalized checkpoint to execution parent.

For the first step, the VC retains signing authority and the existing slashing database. If a
separate signer is chosen later, ownership handoff requires confirmed completion of current jobs;
two executors must never sign concurrently with the same keys. The container need not be recreated
for every warp. External signers need a separately supported path; local-key acceleration does not
automatically apply to them.

### 2. Produce a real aggregate signature directly for a group of keys

For the same signing root in Ethereum BLS:

`Aggregate(Sign(sk₁, m), …, Sign(skₙ, m)) = Sign((Σ skᵢ) mod r, m)`.

This follows from BLS linearity: the result equals the sum of individual signatures. The candidate
is especially useful for sync committee and PTC: instead of signing with every unique key and then
adding signatures, produce one signature for the same message and participant group. Different
messages require different groups. Source:
[BLS draft, CoreSign and proof-of-possession](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-bls-signature-06#section-2.6).

The optimization must remain inside the signer, own only local devnet keys, and retain standard
cryptographic verification of the result. Participants, domain, multiplicity, and aggregation bits
must exactly match the selected client's rules. Slashing checks and history recording for every
participant occur before signature release. Keys and temporary sums never leave the signer; a zero
sum must use ordinary aggregation handling, without bypassing validation.

A source-confirmed detail: sync committee accounts for repeated positions of the same key. **Pinned
Gloas also permits repeated PTC indices:** `get_payload_attesting_indices` sorts indices without
deduplication, and verification explicitly allows duplicates. Deduplication from a different
specification revision cannot be imported here. Sources:
[sync aggregate](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_block_processing/signature_sets.rs#L785),
[PTC indices](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/common/get_payload_attesting_indices.rs),
[PTC validation](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_block_processing/is_valid_indexed_payload_attestation.rs).

Lighthouse currently wraps `blst`; no ready high-level secret-key summation method was found in its
wrapper. Mathematical equivalence is established; implementation and the gain on our machine are
unverified. A conservative alternative is parallel individual signatures with hash-to-curve reuse,
if a safe library interface supports it.

### 3. Cache only computations with known inputs

- RANDAO reveal depends on key, epoch, and domain; the same message need not be signed again.
- Duties, committees, and key sums can be prepared ahead within the known schedule.
- Cache keys must include participant membership/multiplicity and fork domain. Schedules beyond
  available lookahead are recomputed from real state, including activation/exit, consolidation,
  effective balances, and RANDAO.
- After obtaining a new block root, signatures for different groups can be prepared in parallel. The
  next dependent state transition remains sequential.

Do not assume a constant set of 64 validators with equal balances: that would break the very e2e
scenarios the network exists to support.

### 4. Use existing batch verification rather than disabling checks

Lighthouse already verifies signature sets through `blst` and imports chain segments split by epoch.
This is an existing capability to reuse, not a cryptographic function yet to be written:
[batch signatures](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/crypto/bls/src/impls/blst.rs#L36),
[segment import](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/beacon_chain.rs#L3179).

Batch import accelerates verification of already built blocks; it does not produce them. Generating
and verifying a whole epoch requires a separate bounded buffer of preliminary results. This is more
complex: unconfirmed state must not be published as verified, finalized, or returned to the user.
First measure standard batch verification within one block and its overlap with independent
preparation. Cross-block speculation cannot be treated as a ready, safe speedup.

The slashing database already provides transactional `check_and_insert_attestations`; use it with
checks enabled. History cannot simply be appended after warp:
[slashing database](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/slashing_protection/src/slashing_database.rs#L651).

### 5. Reduce unnecessary EL preparation, preserve real execution

The inspected Geth versions build an initial transaction-free payload synchronously and start the
full build in the background. For a txpool closed in advance and empty, investigate using the
already-ready initial payload without waiting for `Updated payload`. This requires an explicit
transaction-admission boundary: checking that "the txpool was empty" does not eliminate the race.
Transactions accepted before the boundary execute; new requests are queued after warp. Readiness
with a nonempty txpool must still be confirmed.

Even a payload without user transactions performs system calls, withdrawals, and request queues. It
cannot be replaced with a copy of the parent EL state. See
[Geth payload builder](https://github.com/ethereum/go-ethereum/blob/36b2371c59cd91a9b1da062b3e382f05a6d8687e/miner/payload_building.go#L208)
and
[worker](https://github.com/ethereum/go-ethereum/blob/36b2371c59cd91a9b1da062b3e382f05a6d8687e/miner/worker.go#L96).

The first candidate keeps Geth unchanged. If insufficient, separately measure repeated execution
during build/import and the possibility of correctly reusing results inside the EL. This would be a
potential Geth modification, not a promised Engine API setting. The inspected Geth master `f8f9bc…`
calls `InsertBlockWithoutSetHead` for a new payload; a local build cache alone does not mean no
re-execution occurs. This source SHA **has not been established as the content SHA of the current
Gloas Docker image**, which is pinned by digest:
[Engine import](https://github.com/ethereum/go-ethereum/blob/f8f9bc574459a1afefac7b63163739910ee0fe62/eth/catalyst/api.go#L894).

## What existing measurements show

Gloas baseline: `reports/profiles/gloas/stable/warp.json`, bake key
`8b1fa94aaf9f1719d3c61793bd960344531335270ab88b82c908ca2184b094f9`. Two jumps including the next
transaction: **10.783 / 11.616 s**. This is the current duty-skipping path, not a measurement of the
proposed execution. The target implies about **705–760 full slots/s**, or **1.32–1.42 ms per slot**,
including warp completion and the next transaction.

On September 30, existing `.zap/warp-5400a92c/el.log` and `.zap/deploy-e8e35500/el.log` from the
September 29 run were analyzed. These are saved log tails, not a new microbenchmark. ARM64 macOS,
Docker VM 6 CPU / 8.32 GB; the deploy report records two other running containers. Their load is
unknown.

| Stage, median Geth elapsed           | 60 tx-free blocks after warp | 20 blocks with deploy |
| ------------------------------------ | ---------------------------: | --------------------: |
| Updated payload                      |                     0.343 ms |              0.485 ms |
| Imported new potential chain segment |                     0.890 ms |              0.789 ms |
| Chain head was updated               |                     0.041 ms |              0.101 ms |

For 60 matched empty blocks, the sum of these three records has a median of 1.288 ms and a mean of
1.483 ms. This is **not a full slot or a physical lower bound**: it omits the full initial build,
RPC, CL, signatures, and CL storage; the load conditions differ. Individual-row medians were not
summed to calculate the median of the total. Still, the data shows how tight the budget is: removing
timers alone cannot guarantee the required speed.

Compare Pectra separately: the existing `pectra/default` baseline is 17.594 / 18.302 s including the
next tx. Neither its speed nor Gloas results can be transferred to another bake.

## Path to a verifiable solution

The user clarified the mandatory sequence: **TDD before any prototype/implementation change**. The
full contract, red/green evidence, and acceptance matrix are in
[warp-tdd-acceptance.md](warp-tdd-acceptance.md). First a failing regression, then implementation
and optimization under unchanged checks. Read the list below in that order.

1. An isolated critical-path prototype on pinned clients: 32/256/8192 real slots, persistent EL
   connections, full accounting for state transitions, signing/verification, slashing DB, storage,
   and the first subsequent tx. Separately compare ordinary and direct aggregate signing. Start here
   before expanding the public API or redesigning the whole system.
2. Fix an identical operation-selection policy and compare the slow reference with the fast path:
   block roots, CL state root, EL hashes, balances, participation, and finality. Then independently
   replay the generated blocks and Gloas envelopes through standard verification paths.
3. Check absence of **warp-induced** source/target/sync penalties and inactivity leak, all required
   signatures, and finality. `slashed == false` alone is insufficient. A CL balance decrease from a
   legitimate withdrawal/consolidation is not a penalty; compare transitions with the reference.
   Warp cannot retroactively undo already missed duties.
4. Required boundaries: epoch/sync committee change, fork domain, activation/deposit, voluntary
   exit, consolidation, withdrawals, unequal balances; for Gloas, PTC with repeated indices and
   envelope validation. All activating keys must be available to the executor; one BN does not imply
   ownership of keys for arbitrary deposits.
5. Check stopping midway through the range, signing-history preservation, restart, and return to the
   VC. Return the confirmed position; do not claim the target timestamp was reached after a partial
   failure. Do not imply false atomicity for already signed history.
6. Accept based on two consecutive 8192-slot jumps plus the first tx on the same machine, compared
   with the selected profile's baseline. Do not hide history creation in startup, deferred
   verification, or a slow first transaction. If the duration is not met, the requirement is unmet.

The executor, API contract, and common test vectors are shared. Consensus/Engine API integration,
Gloas envelopes/PTC, and profile-specific scenarios are adapters. Each hardfork is built and checked
independently through existing `bake` / `test:profile`. Old immutable bakes are preserved; a native
capability requires new builds for every supported profile, not a separate profile with different
economics. Shared cryptographic tests do not require building every client.

None of the new scenarios listed above has been run yet. The research justifies the design and
possible speedups; it does not establish target speed or implementation readiness.
