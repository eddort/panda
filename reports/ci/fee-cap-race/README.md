# Fee-capped transaction observation race

Reported CI failure: Gloas bake `ci-c7660efa51dc9304ccb373aea28f291bbc36c4c1`,
`fee-capped tx produced blocks`, slot `5 !== 4`.

The scenario read its baseline immediately after observing receipts for earlier transactions.
`Consensus.move` can expose those EL receipts before its remaining barriers finish; `Timeline`
updates its clock only after `move` returns. Reading status then can report slot 4 while EL already
contains the slot-5 transactions. Completion of that existing work was attributed to the later
fee-capped transaction.

The extracted assertion initially retained the original ordering. A deterministic reproduction using
the actual `Automine` and `Timeline` with a gated backend failed with `5 !== 4` for both Pectra and
Gloas phase schedules. This tests coordination, not real EL/CL compatibility.

The assertion now disables/drains automine before recording the baseline, enables it for the
fee-capped submission, then disables/drains it before checking the outcome. The one-second
observation window remains. Slot, protocol time, EL hash/timestamp and absence of a receipt are
checked; automine errors fail the assertion. Negative controls confirm that new slots and EL-only
changes still fail. Runtime automine logic, client build inputs and CI execution are unchanged.

The complete GitHub Gloas job also exposed an independent honest-warp timeout. In
[run 36845242445](https://github.com/eddort/panda/actions/runs/36845242445), 8 scenarios passed and
2 failed: the observation race above, and the 20-minute honest watchdog. On the 2-CPU runner the
latter stopped the chain at slot 7521 (starting at 128), with finalized epoch 233. The raw failure
is preserved in [ci-honest-timeout.json](ci-honest-timeout.json). The user then explicitly shortened
the standard honest scenario to two 1000-slot traversals. The proposed watchdog increase was
discarded; original watchdogs remain. Economics, duty coverage for every traversed slot, finality,
signing history and post-warp transactions remain checked. Fast mode retains two 8192-slot jumps and
its 25-second latency gate. This suite no longer certifies an 8192-slot honest traversal.

Executed checks:

- Before correction: 3 regression failures, including the original `5 !== 4` in both phase
  schedules.
- After correction: 6 focused automine tests passed, including eligibility and disable/notify races.
- `deno task check`: formatting, lint and types passed.
- `deno task test`: 96 passed, 0 failed; 13 Docker/profile opt-ins ignored by this command.
- The 1000-slot scenario regression failed with `8192 !== 1000` before the change and passed
  afterward; default reports still use the registered `warp` / `warp-fast` names.
- Both Lighthouse build identities match the previously published client locks.

After the user authorized the full Docker verification, the original real Gloas E2E passed in 56.65
seconds using the existing `ci-main-merge` bake. Two initial full attempts were stopped before
completion: first to investigate the additional CI timeout, then to apply the requested 1000-slot
scope. Neither is counted as successful full verification.

Raw local evidence is ignored under `.cache/fee-cap-race/`. Current local clients are `linux/arm64`;
published `linux/amd64` GHCR images could not be read with the local registry authorization (HTTP
401). These results do not claim a new GitHub/amd64 run. Lighthouse binaries were restored from
their exact cached archives; native inputs did not change and no Rust rebuild was needed. The shared
helper and scenario parameters are included by the recursive suite fingerprint.

Completed full local profile verification:

- Gloas `ci-main-merge`: **10/10 passed**, 589.84 seconds. Both honest samples checked all 1000
  blocks and 30 closed reward epochs; ready including the next tx in 88.70 / 92.48 seconds. Fast
  samples remained 8192 slots, ready in 8.62 / 8.90 seconds.
  [Bound verification](../../profiles/gloas/ci-main-merge/verification.json).

- Pectra `ci-main-merge`: **9/9 passed**, 674.49 seconds. Both honest samples checked all 1000
  blocks and 30 closed reward epochs; ready including the next tx in 99.37 / 95.11 seconds. Fast
  samples remained 8192 slots, ready in 16.22 / 15.27 seconds.
  [Bound verification](../../profiles/pectra/ci-main-merge/verification.json).

Additional completed checks:

- `actionlint`: all Panda workflows and the Lido consumer workflow passed.
- `deno task smoke:docker`: passed in 4.60 seconds.
- `test:baker` for Gloas and Pectra: **4/4 each**, including artifact reuse, archive restoration,
  rollback and protection of another owner.
- Both Panda service images built successfully using the existing Lighthouse binaries. The first
  local build command selected a builder in the wrong Docker context; it was corrected before
  compilation, without a product or workflow change.
- `test:image`: Gloas passed in 22.16 seconds, Pectra in 23.52 seconds. Checks cover fresh genesis,
  readiness without mining, transaction/pause, public CL/VC, VC authentication after replacement
  during fast warp, client logs and graceful shutdown. Evidence: [Gloas](gloas-image.json),
  [Pectra](pectra-image.json).
- Lido Node SDK: **8/8 passed**; `yarn typecheck` passed.

- Lido `yarn test:integration:panda --bail`: **15/15 passed**, 314.55 seconds including a fresh
  scratch deployment, against the newly built Gloas service and its directly exposed Beacon API.
  [Service evidence](lido-container.json),
  [verifier proof/transaction evidence](lido-verifiers.json).
- Both `ci-main-merge` bakes report `verified: true` against the final suite fingerprints.

[Docker and consumer command results](docker-and-consumer.json) include all successful stages.
Packaging reused cached native artifacts. Local package test images are unpublished; GitHub release
jobs were not restarted by this verification.

Final cleanup check found no Panda test containers or networks and no remaining test processes. The
two existing Lighthouse compiler-cache volumes were preserved.
