# zap-net

![zap-net — a pixel-art firefly with a clock abdomen](docs/assets/banner.png)

**Real Ethereum. Your time.**

A local Ethereum devnet for integration tests that need control over protocol time. zap-net runs
Geth and Lighthouse in Docker, with a small Deno/TypeScript API to start the network, produce
blocks, advance epochs and clean up afterward.

The goal is to make tests involving time, consensus and validator lifecycle practical to run
locally. A test decides when the chain advances, while the clients perform the actual execution,
signing, voting and state transitions.

## Why zap-net?

Ethereum applications often need to wait for a deadline, a finalized block or a validator
transition. On a network driven by the host clock, those waits become part of every test run.
zap-net makes protocol time explicit: pause the chain while inspecting state, advance one slot to
observe a block, or move through many epochs to reach the condition a test needs.

It is useful for:

- **Time-dependent contracts:** exercise timelocks, vesting and expiry against real block
  timestamps.
- **Application integrations:** test deployments, receipts, indexers and finalized-block consumers
  against execution and consensus clients.
- **Validator workflows:** exercise deposits, activation, exits and withdrawals with the protocol's
  state transitions and delays.

The network can run ahead of the host clock. Advancing time still requires computation: ordinary
advancement processes every intermediate slot, including block proposals and validator duties.

## How it works

One Deno process owns the network lifecycle and exposes HTTP JSON-RPC, Beacon API and time controls.
It manages Geth, a Lighthouse beacon node, a validator client and a one-shot genesis generator
through Docker. Each instance has its own resource label, so cleanup is scoped to that instance.

Geth runs without a fork. A Lighthouse patch gives protocol clocks and schedules an explicit time
source. The controller advances protocol phases and waits for their work to finish; an Engine API
gate coordinates execution payload preparation with those phases. Signature checks, execution
validation and finality remain part of the real client pipeline.

The default network targets **Pectra (Prague/Electra)** with the mainnet preset: 12-second slots,
32-slot epochs and 64 genesis validators. Validator count is reduced explicitly. Network deadlines,
JWT timestamps and watchdogs continue to use real time, including while protocol time is paused.

## Quick start

Requires a running local Docker daemon. Bootstrap installs the pinned Deno runtime in `.tools/`. The
first Lighthouse build takes time; client compilation is separate from ordinary network startup.

```sh
sh scripts/bootstrap.sh
./scripts/deno run -A scripts/prepare_clients.ts
./scripts/deno task build:clients
./scripts/deno task smoke:docker
./scripts/deno task up
```

HTTP JSON-RPC and Beacon API share `http://127.0.0.1:8545`: use `/` for JSON-RPC and the standard
`/eth/v1/...` and `/eth/v2/...` paths for Beacon API.

Press Ctrl-C to stop and clean up, or run `./scripts/deno task down` in another terminal.
`./scripts/deno task reset` starts again with fresh state. Use `ZAP_ID` and `ZAP_PORT` for separate
instances. Once Deno is available on your path, the same commands can be written as `deno task …`.

## Control time

From a TypeScript file in the repository root:

```ts
import { Devnet } from "./src/api.ts";

await using net = await Devnet.start({ id: "my-test" });

await net.stepSlot(); // Produce a block and complete the slot's duties.
await net.advanceEpochs(2); // Advance through two epochs.
await net.advanceTime(3600); // Process one hour of protocol time.

await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 3n,
  { maxSlots: 160 },
);
```

`await using` cleans up the instance when the scope ends. To connect to an existing controller, use
`new Devnet("http://127.0.0.1:8545")`; closing that connection does not stop the network.

Use `advanceSlots(n)` for a specific number of slots, `advanceTo(timestampOrDate)` for a target
time, or `advanceUntil(predicate, options)` to wait for a condition within a slot budget and a
real-time deadline. Time only moves forward.

Automine is off by default. Enable it with `await net.setAutomine(true)` to produce blocks for
eligible pending transactions, then wait for receipts as usual. See the
[deployment example](examples/deploy.ts) for sequential contract deployment with ethers.

`skipSlots(n)` is a separate operation that advances through slots without blocks or votes. It can
delay finality and incur inactivity penalties. Use normal advancement when the test needs continuous
participation.

## Scope and limitations

The current topology is one execution client, one beacon node and one validator client. Public APIs
bind to localhost, and Docker must run locally because the network uses local bind mounts.
Development keys are public and intended only for this environment.

HTTP JSON-RPC is supported. WebSocket, long-lived Beacon SSE, multiple beacon nodes and arbitrary
external validators are outside the current verified scope. Resuming an existing chain after a
controller restart is not implemented; use `down` followed by `up` to start fresh. Geth's real-time
transaction-pool expiry continues during a protocol pause.

## Validation

```sh
./scripts/deno task check
./scripts/deno task test
./scripts/deno task e2e # Requires the locally built client image.
```

The default test suite runs unit checks and skips Docker and end-to-end scenarios. Separate
scenarios cover time advancement, automine, finality, validator lifecycle, deployments and resource
ownership. Finality checks compare the Beacon finalized block's execution hash with Geth's finalized
hash.

[Measurements and validation](docs/measurements.md) records executed checks, host conditions and raw
reports. Keep resource measurements separate from other devnet tests.

## Documentation

- [Usage guide](docs/usage.md) — configuration, API details, ethers settings and troubleshooting.
- [Architecture](docs/architecture.md) — clock boundaries, client patches and Engine API
  coordination.
- [Project plan](docs/plan.md) — completed work and next steps.
- [Artwork](docs/branding.md) — the clockwork firefly, logo and banner.
