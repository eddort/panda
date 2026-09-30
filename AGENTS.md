# zap-net

One Deno controller drives dockerode, Geth, Lighthouse BN/VC and a one-shot genesis container. The
profiles are named by hardfork: Pectra (Prague/Electra) and Gloas (Amsterdam/Gloas), mainnet preset,
12-second slots. Protocol time is explicit; sockets, RPC deadlines, watchdogs and profiling use real
time. Never substitute a mock EL, signature bypass or a fabricated finalized checkpoint.

Commands: `sh scripts/bootstrap.sh`; `deno task smoke:docker`; `deno task check`; `deno task test`;
`deno task baseline`; `deno task up`; `deno task down`; `deno task reset`; `deno task diagnose`;
`deno task profile`. Tasks use the repository-local pinned Deno. Client builds are separate from
`up`: use `deno task bake <hardfork> --tag <tag>`, then
`deno task test:profile <hardfork> --bake <tag>` and
`deno task up --profile <hardfork> --bake <tag>`.

Use `.agents/skills/develop-feature/SKILL.md` for implementation, `test-change/SKILL.md` for
validation, `review-changes/SKILL.md` for review, `debug-devnet/SKILL.md` for stalled chains, and
`profile-resources/SKILL.md` for measurements. Read the selected skill, execute its relevant
commands, and record actual results. Never report an unexecuted integration scenario as passing.

TDD is mandatory: define observable acceptance criteria and add a failing regression before
implementing or optimizing the affected behavior, then make it pass and refactor with the same
checks. For honest fast-forward use `docs/warp-tdd-acceptance.md`. Validator economics, full duty
coverage, real finality, EL/CL agreement, failure safety and post-warp operations are release gates;
speed or `slashed == false` alone is insufficient. Preserve red/green evidence for the selected
bake. A requirement without an implemented, executed check remains unverified. Profile builds and
tests stay independent; shared changes require validation for each profile released with them.

Sources: `src/network.ts` owns lifecycle; `src/docker.ts` owns Docker operations; `src/config.ts`
owns runtime configuration; `bakes/*/recipe.json` pins recipes; `src/baker.ts` builds immutable
`bakes/<hardfork>/tags/<tag>.json` manifests; `src/engine.ts` gates payload preparation using pinned
Geth JSON logs; `bakes/shared/controlled_clock.rs` and the Lighthouse patch change only protocol
clocks/schedules. `src/http.ts` contains real bounded waits. Keep third-party source/build artifacts
under ignored `.cache/`. All Docker mutations must be scoped by the exact `io.zap-net.id` label.
Never prune Docker globally: this machine may have unrelated running workloads.

Extended verification: `deno task e2e`, `e2e:withdrawal`, `e2e:protocol`, `test:lifecycle`,
`test:clock <hardfork> --bake <tag>`, `measure`. Raw profile reports are tracked under
`reports/profiles/<hardfork>/<tag>/`; verification binds the bake key and suite fingerprint. Gloas
uses separate payload envelopes and PTC barriers; finalized execution is the checkpoint's execution
parent. Time jumps must use real state transitions and complete in seconds, including the first
subsequent transaction. `e2e:warp` checks two 8192-slot jumps, resumed finality and signing history.
`test:profile` runs only the selected profile; `test:baker` owns shared Docker/baker checks. Do not
run resource measurements concurrently with another devnet test. Public HTTP endpoints are
localhost-only; the internal Engine gate binds the host gateway and verifies JWT before forwarding.
