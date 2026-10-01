# Controlled attestations without aggregator wrappers

Research only, 2026-09-30. No client change or new test execution is claimed here. The target
remains 8192 honest slots plus the first transaction within 60 seconds; this candidate does not
prove that target. Sources are the pinned Gloas checkout under `.cache/warp-native/gloas` and Pectra
under `.cache/upstream/lighthouse`. Measurements are the existing direct-sync 32-slot report.

## Algorithmic finding

A new direct-attestation admission API is probably unnecessary. Lighthouse already transfers the
naive aggregation pool into the operation pool during block production:

- Gloas: `beacon_node/beacon_chain/src/block_production/gloas.rs:415–437`.
- Pectra: `beacon_node/beacon_chain/src/beacon_chain.rs:5288–5307`.

Ordinary HTTP publication verifies each individual signature and membership, applies the vote to
fork choice, then inserts it into the naive pool
(`beacon_node/http_api/src/publish_attestations.rs:76–120`). The naive pool aggregates only matching
full attestation data and committee, and suppresses duplicate bits
(`beacon_node/beacon_chain/src/naive_aggregation_pool.rs:18–118,267–295`). With the current 64
active validators there are two attesters in one committee per slot. Their individual signing and
durable slashing protection can remain entirely unchanged.

The controlled path could omit attestation selection proofs and the local `SignedAggregateAndProof`
GET/sign/POST routine. The latter is a gossip transport wrapper; the block contains the inner
attestation. Keep early individual votes and ordinary block packing/import. This removes the
redundant computation, without requiring removal of a protocol-clock phase. Slashing database
pruning is separately scheduled in the same VC function and must remain
(`validator_client/validator_services/src/attestation_service.rs:433–436`). Ordinary mode keeps its
existing aggregation behavior.

This can preserve block attestations, state, economics and fork-choice results for the complete
local input set. It deliberately does not preserve the gossip-wrapper trace. Equivalence must be
demonstrated, not inferred merely from complete bits: operation-pool insertion is greedy and packing
can aggregate across committees (`beacon_node/operation_pool/src/attestation_storage.rs:457–510`;
`src/lib.rs:395–396`).

## Required completion guard

VC publication marks are insufficient. Signing and HTTP errors are logged but the method still marks
`attestations` and returns success
(`validator_client/validator_services/src/attestation_service.rs:602–626`). Also, the HTTP handler
currently inserts into the naive pool even if fork-choice application failed. A full pool plus the
last successfully processed vote therefore does not prove successful fork-choice admission for every
participant. `add_to_naive_aggregation_pool` additionally treats `SlotTooLow` as `Ok`
(`beacon_node/beacon_chain/src/beacon_chain.rs:2571–2616`).

A controlled BN barrier must establish all of the following before the next proposal:

1. The current slot and canonical head are the exact head already accepted by the controller's
   envelope/EL agreement barrier. Resolve committees and expected attestation data from one
   consistent head/state context; two root reads alone do not rule out A→B→A state changes.
2. For every nonempty committee, the pool has the exact full `AttestationData` root, committee bit,
   bitlist length and participant set derived from that state. Bind source/target checkpoints and
   the Gloas payload-status `data.index` as well as slot/head. Do not join separate partial data
   roots or use only participant counts. Empty committees are exempt according to upstream rules.
3. Every admitted participant has succeeded through ordinary fork choice. Either retain explicit
   success evidence from each individual admission, or reapply the assembled, genuinely verified
   aggregate through ordinary `on_attestation` after deriving its valid indexed form. The latter
   avoids a new per-validator completion ledger, but needs its own narrow native helper and tests;
   `on_attestation` assumes valid indexed signatures and does not establish that prerequisite. No
   fabricated `VerifiedAggregatedAttestation` wrapper is needed or acceptable.
4. Readiness cannot survive loss/pruning of the pool before production. Recheck the required
   aggregate at production, or invalidate readiness and replay/fail closed after restart. Ordinary
   production logs a naive→op-pool transfer failure and continues, so the final packed block also
   needs a controlled completeness check if runtime no-penalty guarantees are to hold.

The ordinary fork-choice path queues current-slot votes rather than applying their weight early
(`consensus/fork_choice/src/fork_choice.rs:1330–1400`). Reapplying the same complete vote must
retain that rule. Its eventual latest-message update is idempotent for identical slot/data
(`consensus/proto_array/src/proto_array_fork_choice.rs:683–698`). No fork-choice algorithm rewrite
is required. However, a sound completion/production guard is more than two VC early returns. The
likely touch points are the existing VC selection/aggregate routines, BN readiness and production
guards, and controller barrier selection, plus shared patch installation and both profile tests. A
precise line-count estimate has not been established.

## Measured reserve, without double counting

The matching files are `reports/warp-tdd/native/metrics-direct-sync-{bn,vc}-{before,after}.txt`;
`metrics-gloas-direct-sync.json` records 32 slots in 2956.23025 ms. Subtracting those same-run
counters and dividing by 32 gives:

| Existing work                              | Recorded duration per slot | Interpretation                                  |
| ------------------------------------------ | -------------------------: | ----------------------------------------------- |
| VC aggregate routine                       |                3.984313 ms | Includes GET, wrapper signing and POST          |
| VC attestation selection proofs            |                1.259100 ms | Separate removable computation                  |
| BN aggregate gossip verification           |                1.877833 ms | Already inside the POST above; do not add again |
| BN individual attestation signature checks |                7.593497 ms | Two first-time checks per slot; retained        |

Thus about 5.243413 ms/slot of recorded VC work is the gross candidate scope, before replacement
guards. It is not a demonstrated wall-time saving. Multiplying by 8192 gives about 42.95 seconds of
those recorded operation durations, not a proven reduction of an 8192-slot run. At this validator
count, the candidate removes two selection-proof signatures and two wrapper signatures per slot; the
two slashable attestation signatures and their first verifications remain.

## Exact positive-cache reuse

For message/root `m`, the individual tuples `(m, PK_A, sig_A)` and `(m, PK_B, sig_B)` differ from
`(m, PK_A + PK_B, sig_A + sig_B)`. Exact lookup cannot turn the two cached individual successes into
an aggregate success. The 7.593497 ms above cannot therefore be counted as an aggregate-cache gain.

An aggregate genuinely checked on a prior path can hit at block import if the signing root,
aggregate public key and signature bytes are exactly identical, with the same fixed BLS context. An
identical inner aggregate may also recur inside different aggregator wrappers, but their
wrapper/selection-proof equations differ, and duplicate gossip can already be rejected before
cryptography. Admission builds three signature sets
(`beacon_node/beacon_chain/src/attestation_verification/batch.rs:64–101`); block import builds the
attestation set from its own state/context
(`consensus/state_processing/src/per_block_processing/block_signature_verifier.rs:283–309`).

Skipping wrappers also removes their earlier aggregate verification: the first subsequent block
aggregate is then normally a cache miss. Packing a larger participant union changes its key and
signature and also misses. Domain, source/target checkpoint or Gloas payload-status changes alter
the signing root. Adding a preverification merely to warm the cache moves a check; it does not by
itself eliminate one. Membership, bits, fork-choice application and state processing remain outside
the cryptographic cache and must still run on every required path.

## Smallest useful TDD sequence

1. Preserve an ordinary baseline and demonstrate existing no-wrapper naive-pool block inclusion.
   That behavior should already pass; it is not the required RED. The new RED should expose the
   missing strict BN barrier or prove that controlled selection/wrapper jobs still execute.
2. Native differential fixture: same individually signed votes, with and without wrappers; compare
   packed attestation SSZ, imported state root, participation/balances and fork-choice head after
   its ordinary slot tick. Include multiple committees and the epoch boundary, not only two
   validators signing one common root.
3. Failure fixture: missing signer, invalid signature, duplicate/chunked delivery, wrong source or
   target, Gloas index 0/1 split, head change, forced FC rejection, pool eviction/restart and failed
   packing. No complete barrier/proposal may succeed with missing required votes. In particular,
   full naive bits after an FC error must stay unready.
4. Cache fixture: individual A/B successes do not yield an aggregate hit; a genuinely verified
   unchanged aggregate can hit at import; expanded bits, root/domain/signature changes miss/reject.
5. Each released profile must pass live economics, finality, signing-history and post-warp gates.
   Native fixtures cannot prove real EL/envelope agreement. Existing attestation-production tests
   name Gloas present/absent cases at `tests/attestation_production.rs:495,547`; use their
   scenarios, without treating upstream mock-EL fixtures as the live release oracle.

Verdict: a promising thin algorithmic simplification, with an existing upstream inclusion path. It
is not yet an implemented or validated replacement, and it alone does not establish one-minute
warps.
