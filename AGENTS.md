# zap-net

One Deno controller drives dockerode, Geth, Lighthouse BN/VC and a one-shot genesis container. The
target is Pectra (Prague/Electra), mainnet preset, 12-second slots. Protocol time is explicit;
sockets, RPC deadlines, watchdogs and profiling use real time. Never substitute a mock EL, signature
bypass or a fabricated finalized checkpoint.

Commands: `sh scripts/bootstrap.sh`; `deno task smoke:docker`; `deno task check`; `deno task test`;
`deno task baseline`; `deno task up`; `deno task down`; `deno task reset`; `deno task diagnose`;
`deno task profile`. Tasks use the repository-local pinned Deno. Client builds are separate from
`up`.

Use `.agents/skills/develop-feature/SKILL.md` for implementation, `test-change/SKILL.md` for
validation, `review-changes/SKILL.md` for review, `debug-devnet/SKILL.md` for stalled chains, and
`profile-resources/SKILL.md` for measurements. Read the selected skill, execute its relevant
commands, and record actual results. Never report an unexecuted integration scenario as passing.

Sources: `src/network.ts` owns lifecycle; `src/docker.ts` owns Docker operations; `src/config.ts`
pins versions/configuration; `src/engine.ts` gates payload preparation using pinned Geth JSON logs;
`clients/controlled_clock.rs` and the Lighthouse patch change only protocol clocks/schedules.
`src/http.ts` contains real bounded waits. Keep third-party source/build artifacts under ignored
`.cache/`. All Docker mutations must be scoped by the exact `io.zap-net.id` label. Never prune
Docker globally: this machine may have unrelated running workloads.

Extended verification: `deno task e2e`, `e2e:withdrawal`, `e2e:protocol`, `test:lifecycle`,
`test:clock`, `measure`. Raw reports are tracked under `reports/`. Do not run resource measurements
concurrently with another devnet test. Public HTTP endpoints are localhost-only; the internal Engine
gate binds the host gateway and verifies JWT before forwarding.
