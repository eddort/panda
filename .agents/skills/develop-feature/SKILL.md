---
name: develop-feature
description: Implement features in Panda, including Deno APIs, Docker lifecycle, and the Lighthouse clock patch.
---

Read AGENTS.md and the affected source before editing. Protocol time belongs to the Lighthouse
clock; real deadlines belong to src/http.ts. Preserve Pectra mainnet constants and real
signature/state validation.

Keep Docker calls in src/docker.ts and topology in src/network.ts. Resource ownership is the exact
io.zap-net.id label. Startup failure and repeated down must clean up only that id. Avoid adding
dependencies when Deno or existing dockerode suffices; pin direct versions in deno.json and retain
deno.lock.

For Rust changes inspect the pinned upstream files, update bakes/shared/controlled_clock.rs and the
maintained patch, and build with ./scripts/deno run -A scripts/build.ts. Check all protocol
schedulers touched; never replace networking or JWT clocks globally.

Run deno task check and deno task test; choose integration checks with test-change. Report behavior
changed, files, executed checks, and remaining limitations.
