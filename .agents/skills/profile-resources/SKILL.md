---
name: profile-resources
description: Measure zap-net startup, component CPU/memory/disk and slot advancement speed against an ordinary-network baseline.
---

Run deno task baseline for ordinary clients and deno task profile for the controlled stand. Record
machine/native architecture, Docker VM resources, pinned images, validator count and competing
workloads.

Separate image download, client compilation, genesis generation, first readiness and first valid
block. Distinguish first run with images absent from repeated startup with cached images. Sample
Docker stats per component during a real pause and during advancement; CPU needs counter deltas over
a stated real interval, not cumulative totals. Report cache-adjusted memory alongside the raw limit
and sample duration. Count successful slots and protocol seconds separately from wall seconds.

Use labeled resources only. Do not improve numbers by deleting unrelated caches or imposing an
unmeasured memory cap. Keep raw measurements in reports and document limitations in
docs/measurements.md.

Return command/config, measured values, comparison and any missing measurements. Build cost is a
separate number, not part of ordinary startup.

`deno task measure` creates two fresh stands sequentially and records readiness, first block,
128-slot throughput, Docker and controller CPU/RSS, and persistent-data disk usage in
`reports/controlled.json`. Run it without other zap-net integration tests competing for CPU. The
baseline records ordinary wall-clock production in `reports/baseline.json`. Both commands clean up
their stands.
