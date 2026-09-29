# Measurements and validation

Recorded on 2026-09-29. All results below are actual executions; raw JSON is tracked in
[reports](../reports). macOS arm64 host, native Linux arm64 containers, Docker Desktop 4.59.1 /
Engine 29.2.0, VM with 6 CPUs and 8,322,592,768 bytes RAM. There were 3 unrelated running containers
during measurement. No other zap-net tests ran concurrently with `deno task measure` or the
baseline.

## Startup and throughput

| Measurement                                                     | Observed result                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Controlled, fresh empty EL/CL databases and regenerated genesis | 10.771 s to readiness; 11.258 s to first verified block      |
| Controlled, repeated fresh-state startup with cached images     | 10.419 s to readiness; 10.920 s to first block               |
| Ordinary Lighthouse baseline, fresh state                       | 13.391 s to readiness; 41.814 s to first block               |
| Controlled 128-slot advancement, run 1                          | 44.814 s; 2.856 slots/s; 34.28 protocol seconds/real second  |
| Controlled 128-slot advancement, run 2                          | 44.599 s; 2.870 slots/s                                      |
| Ordinary empty-block production                                 | One slot per 12 real seconds; observed non-optimistic slot 3 |
| Initial native Lighthouse release build                         | 1,345.476 s (22 min 25 s), excluding builder-image download  |
| Rebuild after clock corrections                                 | 662.126 s (11 min 2 s)                                       |

Commands: `deno task measure`, `deno task baseline`, `deno task build:clients`. Both controlled runs
recreate genesis, keys and empty databases; images, OS caches and build artifacts are already
cached. The second run uses the same Deno measurement process. **A fully uncached end-to-end run,
including all image downloads, has not been measured.** These fresh-database numbers must not be
reported as a cold image-cache startup. Initial individual pulls observed earlier: Geth 4.16 s,
official Lighthouse 5.37 s. They cannot be added into a reliable full cold-start number.

The baseline deliberately chooses genesis 30 seconds ahead of wall time, which is included in its
first-block measurement. Controlled time starts in 2033 and needs no real genesis wait. Throughput
measures proposals, votes, aggregates, verified EL payloads and phase barriers, with empty user tx
pools; it is not transaction throughput. No protocol slot length was shortened.

## Per-component resources

Memory / CPU, first controlled run versus ordinary wall-clock baseline. CPU 100% means one logical
CPU. Docker memory subtracts inactive file cache; Deno uses process RSS. Raw/cache memory and limits
are retained in JSON. These are window samples, not peak-memory measurements.

| Component       | Ordinary baseline  | Controlled pause  | Controlled advancement |
| --------------- | ------------------ | ----------------- | ---------------------- |
| Geth            | 59.4 MiB / 0.46%   | 101.1 MiB / 0.32% | 108.0 MiB / 2.54%      |
| Lighthouse BN   | 249.8 MiB / 4.16%  | 270.0 MiB / 0.62% | 297.4 MiB / 103.90%    |
| Lighthouse VC   | 116.3 MiB / 14.36% | 118.9 MiB / 0.16% | 122.1 MiB / 42.89%     |
| Deno controller | —                  | 55.0 MiB / 1.78%  | 65.6 MiB / 7.28%       |

Sample intervals: baseline 26.070 s spanning ordinary slots; controlled pause 7.044 s after 32
slots; load 6.013 s during the first part of a 128-slot advance. The second run is in
`reports/controlled.json`: measurements vary with GC, database work and other host workloads. The
baseline script is not a resident controller, so no comparable Deno baseline value is claimed.

Geth cache is 64 MiB; peer discovery/peering are disabled for this local topology. Each client has a
2-CPU maximum. Memory reservations are EL/VC 128 MiB, BN 512 MiB; there is no hard per-container
memory cap. The reported memory limit is the Docker VM limit. No comparative cache-size/CPU-limit
sweep was done, so these measurements do not prove the chosen values optimal.

After 160 produced slots, allocated persistent data: EL 35.63 MiB, BN 16.56 MiB, validator
keys/slashing database 1.72 MiB (`du -sk` inside the clients). Image layers, build volumes,
`.cache`, `.zap` metadata/logs and the Docker VM disk are additional costs; these figures are not
total host disk consumption. The native controlled runtime image is 218,443,288 bytes.

## Executed checks

| Command / scenario                 | Result                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deno task check`                  | Format, lint, TypeScript checks including examples passed                                                                                                                                                          |
| `deno task test`                   | 9 unit regressions passed; Docker and full e2e opt-in tests are skipped by default                                                                                                                                 |
| `ZAP_DOCKER_TEST=1 deno task test` | 10 passed, 1 e2e opt-in skipped; failed-start rollback preserves foreign volume and cleanup is repeatable                                                                                                          |
| `deno task smoke:docker`           | Passed socket, network, volume, container, logs, exec, events, stop/remove/repeated cleanup; 1.469 s with cached Alpine                                                                                            |
| `deno task test:clock`             | Native Rust clock regression passed: real pause, monotonic advance, backwards rejection, no zero-duration spin                                                                                                     |
| `deno task e2e`                    | Passed in 76.106 s: forward duration/date, timestamp beyond host time, 13-second real pause, EVM TIMESTAMP, batch/errors/notifications, low fee, nonce gap, concurrent sends, actual finality and external indexer |
| `deno task e2e:withdrawal`         | Passed in 101.509 s: signed exit, EL withdrawal, committee rotation, zero actual balance and withdrawal_done                                                                                                       |
| `deno task e2e:protocol`           | Passed in 186.670 s: 32 ETH deposit, imported key activated at epoch 11, 0x02 credential switch and actual consolidation                                                                                           |
| `deno task test:lifecycle`         | Passed in 27.502 s: repeated up/down, reset with identical EL genesis, duplicate-owner rejection, no leftover stand resources                                                                                      |
| Five repository skills             | All pass skill-creator validation; each was applied during implementation                                                                                                                                          |

Finality was checked by equality of the Beacon finalized block's execution hash and Geth's
`finalized` hash, not by slot count. The withdrawal fixture reached slot 24576 (294,912 protocol
seconds), using **explicit skipped slots** for long waits and retaining real inactivity penalties.
Its first large payout was 31.711599587 ETH; final validator balance is zero. It did not fabricate
votes/finality during skipped periods. Normal `advanceTime`/`advanceTo` process all intervening
slots.

Consolidation is explicitly tested with `churnLimitQuotient: 4`: the default mainnet quotient 65536
leaves no consolidation capacity at 64 validators. The default exit/withdrawal test keeps 65536 and
standard 256-epoch delays. EL genesis repeatability and independently regenerated CL genesis SSZ
hashes are recorded in `reports/lifecycle.json` and `reports/provenance.json`.

## Scope and limits

Verified: native macOS arm64 + Docker Desktop, one EL/BN/VC, 64 genesis validators and one added
key, Pectra from genesis, forward-only time, HTTP RPC/Beacon API. Linux/x86 build/bootstrap paths
exist but were not executed here. No multi-node, later-fork transition, sustained blob load,
WebSocket or long-lived SSE coverage is claimed. All active keys must be held by this VC for phase
barriers.

Geth remains unmodified; EngineGate relies on its pinned structured full-payload log event. Check
that dependency when upgrading. Network/JWT deadlines and txpool expiration keep real time, and
external services' system clocks are unaffected. Recovery after controller failure is cleanup and
reset, not resumption of existing chain state. Build sources/images are pinned; apt repositories are
not snapshotted, so this is not a claim of bit-for-bit reproducible client binaries.

See [review findings and fixed regressions](review.md). Raw reports contain only local development
keys/addresses, public fixture data and timings; JWT secrets and private key files are not included.

Final launcher regression: `ZAP_DOCKER_TEST=1 ZAP_E2E=1 deno task test` passed all **11 tests**
through the installed system Deno 1.36.4; workload execution uses the pinned local Deno 2.9.7.
`deno.json` is the backwards-compatible task launcher (no runtime lockfile parsing);
`deno.runtime.json` owns the pinned runtime configuration and `deno.lock`. A separate post-fix
`deno task test:lifecycle` passed as well. `reports/cleanup.json` records final Docker inventory;
only the two intentional build cache volumes remain.
