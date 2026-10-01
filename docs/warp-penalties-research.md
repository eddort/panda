# Warp penalties: research

> Update 2026-09-30: the user rejected a separate bake with modified economics. The candidate below
> is preserved as research history, **not an implementation plan**. The current direction is
> [real duties with accelerated execution](warp-honest-fast-forward-research.md) for all supported
> profiles. Matching the previous speed is not yet proven possible.

Date: 2026-09-30. Status: analysis of the specification, pinned sources, and existing reports.
Runtime, clients, recipes, and completed bakes were unchanged. The new modes below are **not
implemented or integration-tested**.

For the current algorithm, which skips votes over the entire interval, preserving mainnet economics
and removing deductions are incompatible. Ordinary advancement with real votes, already available
through `advanceSlots`/`advanceEpochs`, carries the lowest risk of consensus changes, but does not
match our large-jump speed. If seconds and no losses from missed duties are both required, the
simplest candidate for separate testing is fixed economic parameters in a separate bake. This
changes the test network's rules; it is not another clock optimization. Zero risk cannot be promised
without verification.

Lighthouse Pectra `cfb1f7331064b758c6786e4e1dc15507af5ff5d1` and Gloas
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2` were inspected; local upstream HEADs match the recipes.
Conclusions about configuration capabilities apply specifically to these versions.

## Current deductions

In both clients, ordinary penalties for missing timely source/target are applied independently of an
inactivity leak. The additional penalty uses the accumulated inactivity score; restoring finality
does not itself reset that counter. Ordinary balances and effective balance affect subsequent state
transitions. This matches the
[Altair rewards/inactivity rules](https://ethereum.github.io/consensus-specs/specs/altair/beacon-chain/#get_flag_index_deltas)
and pinned
[Gloas single-pass processing](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_epoch_processing/single_pass.rs#L635).

For scale: with a fixed set of 64 active validators at 32 ETH each, base reward = 1,431,072 Gwei.
Missing source/target costs 894,420 Gwei per epoch; over 256 epochs this is **0.22897152 ETH per key
without additional leak**. This is an arithmetic estimate with unchanged effective balances and no
participation, not a separate run result. The formula was checked against the
[pinned base reward](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/common/altair.rs#L41).

In the real [stable report](../reports/profiles/gloas/stable/warp.json), balances after two jumps
and network recovery were 31.319638–31.322265 ETH, averaging 31.320961 ETH. The genesis balance was
32 ETH. The difference is not a clean measurement of one penalty category: the scenario also
includes blocks, rewards, and withdrawals. However, a no-slashing check clearly does not imply
preservation of balances.

There are also sync committee penalties when processing a block with missing votes. They are not
applied through `process_sync_aggregate` on every empty slot: an empty slot has no block containing
a sync aggregate. The first block after a jump must also be checked. See
[signature verification and sync rewards/penalties](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_block_processing/altair/sync_committee.rs#L12).

## Option comparison

| Option                                                    | Benefit                                                                              | Limitation / risk                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| All intermediate duties, real blocks and votes            | Removes penalties caused by artificial inactivity; preserves mainnet rules           | Already available, but work is proportional to slot count; seconds for 8192 slots are unproven           |
| Short jumps with periodic finality recovery               | May limit leak                                                                       | Ordinary penalties remain; finality does not reset the score; requires additional real blocks            |
| Real top-ups through the deposit contract                 | Offset some losses without manually changing state                                   | Separate transactions and queues; do not cancel an already scheduled exit; need a buffer before the jump |
| Increase stake / validator count                          | May reduce relative ordinary losses or provide a buffer                              | Changes the test set and load; leak remains, and unchanged balances are not guaranteed                   |
| Permanently change economic parameters in a separate bake | May remove ordinary rewards/penalties and leak without switching rules during a jump | Requires a small CL change and separate verification; economics differ from mainnet                      |
| Disable penalties only during warp commands               | Appears to preserve balances while retaining familiar economics between jumps        | Hidden controller state makes replay depend on command history; unsafe without a new deterministic rule  |
| Manually restore balances after a jump                    | Cosmetically restores funds                                                          | Breaks the state root and derived data; does not undo exits/queues. Do not use                           |

Real top-ups are a valid protocol mechanism, but not universal protection. In Electra/Gloas, new
deposit processing checks the finalized slot, and ejection is checked before pending deposits are
applied. A top-up after an exit is scheduled does not make the validator active again. See
[Electra pending deposits](https://ethereum.github.io/consensus-specs/specs/electra/beacon-chain/#new-process_pending_deposits)
and the
[ordering in pinned Lighthouse](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_epoch_processing/single_pass.rs#L1099).

Sparse blocks with accumulated real attestations are another idea, but not a ready, cheap solution.
In Pectra, timely source requires inclusion within at most 5 slots; after Deneb, target allows later
inclusion. One arbitrary block per epoch is insufficient to claim no penalties: votes from all
committees, correct inclusion, and separate Gloas/PTC checks are needed. Specification:
[Deneb participation flags](https://ethereum.github.io/consensus-specs/specs/deneb/beacon-chain/#modified-get_attestation_participation_flag_indices).
This option adds a new scheduler and has no measured speed yet.

## Why setting a few YAML values to zero is insufficient

`INACTIVITY_SCORE_BIAS` is available in runtime config, but is part of the penalty denominator.
Setting it to 0 causes `safe_div(0)` when a target vote is missing. Reducing a nonzero bias does not
solve accumulated leak either: it contributes both to score growth and the denominator. Increasing
the recovery rate does not help during leak, because that branch does not subtract recovery. See
[lines 635–760 of pinned Gloas](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_epoch_processing/single_pass.rs#L635).

`BASE_REWARD_FACTOR`, `MIN_EPOCHS_TO_INACTIVITY_PENALTY`, and
`INACTIVITY_PENALTY_QUOTIENT_BELLATRIX` belong to the preset. In the inspected Lighthouse versions,
they exist in `ChainSpec` but are absent from runtime `Config` fields; adding these keys to ordinary
`config.yaml` is not a supported override. `BasePreset` is explicitly intended for consistency
checks and the API, not for applying an arbitrary preset file. Sources:
[Config](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/core/chain_spec.rs#L2150),
[Preset](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/core/preset.rs#L6).

The quotient must not be 0; an excessively large quotient is also dangerous because of checked
multiplication by bias. Lowering the ejection balance does not stop losses and may only postpone the
problem until the active set is nearly depleted. These settings are not recommended as a remedy.

## Simplest candidate if different economics are acceptable

For a new test network with initially zero inactivity scores, consider two permanent `ChainSpec`
settings applied from genesis:

- `base_reward_factor = 0`: zeros ordinary attestation and sync rewards and their corresponding
  penalties.
- `min_epochs_to_inactivity_penalty = u64::MAX`: prevents entry into leak. With unchanged bias=4 and
  recovery=16, a score starting at zero stays zero after every update. Denominators remain nonzero;
  the additional inactivity penalty is zero.

This is a **candidate inferred from code**, not a currently supported zap-net setting or a proven
safe configuration. In the inspected formulas, `base_reward_factor` is a multiplier and the leak
threshold is a comparison value; this does not require zeroing denominators or intervening in every
warp command. Applying this scheme to an existing database with accumulated scores cannot promise an
immediate end to losses: a new genesis is required.

The policy must be fixed for the lifetime of the network and applied identically in state
preparation, proposal, block verification, and replay. It must be visible in the bake manifest and
Beacon spec API. BN/VC must receive the same configuration. A client with ordinary economics must
not join this chain; the separate test network's configuration and identity must prevent it.

Profiles retain hardfork names: for example, a separate tag `gloas/test-economics`, not a new
"penalty-free hardfork". `gloas/stable` stays unchanged. Geth needs no changes. SSZ sizes, 12-second
slots, real signatures, state transitions, and finality can be preserved; finality will still
require real votes after a skip. Slashing for violations, deposits, consolidations, and withdrawals
must continue to apply. EL gas fees and separate builder payments also do not become zero from these
two parameters.

The cost: ordinary consensus rewards disappear too. Such a bake is suitable for testing contract
deadlines and validator operations, but does not establish application correctness with respect to
mainnet yields, inactivity leak, or the network's economic security under partition. This goes
beyond the project's current "mainnet preset" and "clock/scheduling-only patch" constraints; the
research does not change them.

## Checks required to establish candidate safety

1. Native epoch and sync transition checks: fixed balances/zero scores without operations; ordinary
   deposits/withdrawals/consolidations apply; slashing for real violations works; invalid signatures
   are rejected. Results for the ordinary bake stay unchanged.
2. Independent replay from the pre-jump state **without a prepared cache**: the same `state_root`
   for the same blocks and when advancing in one interval versus parts. Check each hardfork
   independently. This matters more than simply matching the BN to its own cache.
3. Full `test:profile` for the new tag only; both warps including a transaction within the accepted
   budget, real EL/CL agreement and finality, and signing-history comparison.
4. Repeated jumps with and without finality recovery, epoch/committee boundaries, and deposits,
   exits, and consolidations queued during the jump. Reconcile every balance and the reason for its
   change; verify continued network operation after repeated jumps, not just absence of
   `slashed=true`.

Completed so far: reading both pinned clients, checking specifications, extracting actual balances
from the old report, and calculating the ordinary penalty. No new builds, Docker runs, or consensus
changes were made. A separate experimental tag and preservation of `stable` minimize risk to the
existing working solution; the new mode's risk must be measured through these checks, not declared
absent based on source inspection.
