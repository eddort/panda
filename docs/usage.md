# Using Panda

Panda is a local Ethereum development environment with Pectra/Gloas profiles: Geth, a Lighthouse
beacon node and real validators, one Deno/TypeScript controller, and Docker managed through
dockerode. A one-shot ethereum-genesis-generator creates genesis. See
[measurements](measurements.md) for validation results and benchmarks, and the
[project plan](plan.md) for completed work and next steps.

## Setup and startup

```sh
sh scripts/bootstrap.sh
deno task smoke:docker
deno task bake pectra --tag local # Build local artifacts from the pinned recipe on this machine.
deno task test:profile pectra --bake local
deno task up --profile pectra --bake local # Foreground; Ctrl-C cleans up this instance's resources.
```

Tasks use the local Deno 2.9.7 runtime in `.tools`; a system Deno is only needed to invoke
`deno task`. `deno.json` contains the compatible task list, while `deno.runtime.json` contains
dependencies and runtime settings.

See [bake profiles](bakes.md) for EL/CL version selection, tags and validation suites. For example,
run `deno task up --profile gloas --bake trial` after building and verifying `gloas:trial`.

## Connections and configuration

In another terminal, run `deno task down` or `deno task reset --profile pectra --bake local`.
`ZAP_ID` selects the instance (default: `local`), and `ZAP_PORT` sets the controller port (8545). To
select a Docker socket, use `ZAP_DOCKER_SOCKET=/path/to/docker.sock` or
`DOCKER_HOST=unix:///path/to/docker.sock`. Docker Desktop on macOS is detected automatically. Remote
Docker daemons are not supported because the network uses local bind mounts. Public RPC and Beacon
API bind to 127.0.0.1. The internal Engine proxy accepts container connections through the host
gateway and verifies JWTs; see the [architecture](architecture.md).

JSON-RPC is available at the root of the controller URL. Standard Beacon API paths `/eth/v1/...` and
`/eth/v2/...` use the same address. Automine is off by default. Keys and the mnemonic are public and
intended only for this local environment.

Panda retains the previous `ZAP_*` configuration names, `.zap/` state paths and `io.zap-net.*`
Docker labels so existing instances and build artifacts remain compatible. `ZAP_PROFILE` and
`ZAP_BAKE` select the default profile and bake when command-line options or API configuration do not
specify them. Commands currently run through `deno task`.

## TypeScript API

The examples below use paths relative to the repository root.

```ts
import { Devnet } from "./src/api.ts";

await using net = await Devnet.start({ id: "my-e2e", profile: "pectra", bake: "local" });
const initial = await net.status();
await net.stepSlot();
await net.advanceEpochs(2);
await net.advanceTime(3600); // Jump one protocol hour; produce a block at the destination.
await net.advanceTo(new Date((initial.now + 7200) * 1000));
await net.setAutomine(true);
// eth_sendRawTransaction returns the usual transaction hash; wait for the receipt separately.
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 3n,
  { maxSlots: 160 },
);
```

To connect to a running controller, use `new Devnet("http://127.0.0.1:8545")`. `close()` and
`await using` stop only an instance created by that object. Connecting to another controller does
not transfer ownership of its lifecycle.

## Protocol time

`advanceTime` accepts seconds with millisecond precision. `advanceTo` accepts a Unix timestamp in
seconds or a `Date`. Time only moves forward. Jumps larger than one epoch skip intermediate blocks
and votes, then produce a real block in the destination slot. Smaller jumps execute every phase. If
the target falls within a slot, later duties wait for the next advancement. `stepSlot` and
`advanceSlots` finish slots at the 11.5-second phase. The initial pause is at genesis + 11.5
seconds, before the first block proposal in slot 1. Protocol slots remain 12 seconds long.

`skipSlots(n)` explicitly skips slots without blocks or attestations. This can reduce participation,
delay finality and incur inactivity penalties. The validator client restarts with its keys and
slashing protection preserved. Lighthouse performs state transitions during subsequent state
processing. Large `advanceTime`/`advanceTo` jumps have the same inactivity semantics, but include
the destination block. Use `advanceSlots`/`advanceEpochs` when continuous participation is required.

## Network parameters

The default genesis timestamp is 2,000,000,000 (2033), deliberately testing protocol time ahead of
the host clock. Override it with `genesisTime` in `Devnet.start`. The mainnet preset uses 32 slots
per epoch, 64 genesis validators, and standard churn, activation and withdrawal parameters.
Electra/Prague is active from genesis. The genesis validator count is explicitly reduced. There is
no `minimal` profile.

## Tests and measurements

```sh
deno task test                         # Fast unit checks; Docker and e2e tests are skipped.
ZAP_DOCKER_TEST=1 deno task test        # Rollback and protection of unrelated resources.
ZAP_E2E=1 deno task test                # All four real e2e scenarios, sequentially; requires the image.
deno task e2e                          # Time, automine, finality and a separate indexer.
deno task e2e:withdrawal               # Real exit to withdrawal across hundreds of epochs.
deno task e2e:protocol                 # Deposit, activation and consolidation with an explicit churn override.
deno task e2e:deploy                   # 20 sequential deployments through RPC and ethers.
deno task test:lifecycle               # Repeated up/down/reset and reproducible genesis.
deno task test:clock                   # Rust clock regression; uses the build cache.
deno task measure                      # Two fresh instances: CPU, memory, disk and advancement speed.
deno task diagnose
deno task profile                      # A running instance; advances 32 slots.
deno task check
```

## Automine and sequential deployments

For sequential deployments, enable `await net.setAutomine(true)`, wait for the previous
transaction's receipt, then submit the next transaction. Automine produces the next block
automatically; no `stepSlot` call or `sleep` is needed between transactions. Each block still goes
through real EL/CL processing, so computation takes a nonzero amount of time.

When using ethers, configure receipt polling for the fast local network:

```ts
import { JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { privateKey } from "./src/config.ts";

const provider = new JsonRpcProvider(net.url, 1337, {
  staticNetwork: true, // This instance has a fixed chainId.
  pollingInterval: 25,
  cacheTimeout: -1,
  batchMaxCount: 1,
});
const signer = new NonceManager(new Wallet(privateKey, provider));
// new ContractFactory(abi, bytecode, signer).deploy(...)
// await contract.waitForDeployment() before the next dependent deployment.
// Call provider.destroy() when finished.
```

Polling and batching are client settings; they do not change the protocol slot length. Request
caching is disabled so sequential operations do not see stale nonces or block numbers. See the
[ethers options](https://docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcApiProviderOptions). The
[deployment example](../bakes/shared/tests/deploy.ts) checks constructors, runtime code and a
continuous block sequence. Individual latency measurements are saved in `reports/deploy.json`.

## Errors, timeouts and external services

`advanceUntil` has both a slot limit and a real-time deadline. An error within a phase does not roll
back the clients. Further advancement is blocked until reset to avoid continuing from an uncertain
state. Independent requests and network watchdogs continue to use real time. An external service
sees advanced block timestamps, while its own system clock remains unchanged.

## State and cleanup

Fork sources, build artifacts and instance state live in `.cache/`, `.tools/` and `.zap/`, which are
not committed. Images and volumes named `zap-build-*` form a separate, reusable build cache.
`down/reset` cleans up resources only for the selected `ZAP_ID`. Global Docker prune is never used.

## Validator exits and consolidation

The consolidation example sets `churnLimitQuotient: 4`: with 64 validators, standard churn leaves no
capacity for consolidation. Gloas also requires the separate `consolidationChurnLimitQuotient: 4`.
These are explicit test overrides; the ordinary churn defaults are 65536 for Pectra and 32768 for
Gloas, and Gloas consolidation defaults to 65536. The full exit example preserves standard delays
and uses explicit `skipSlots` for long periods without blocks. Real inactivity penalties apply after
skipped slots.

## Engine API

Geth provides the execution layer. To control block production, the same Deno process hosts an
Engine proxy. It defers preparation of future payloads and waits for the current payload build to
finish, using the pinned Geth version's JSON log. This dependency must be checked again when
upgrading Geth. The [review results](review.md) describe defects found and the checks used to verify
their fixes.

## Limitations

HTTP JSON-RPC is supported. WebSocket, long-lived Beacon SSE, multiple beacon nodes and arbitrary
external validators are unverified or unsupported in this version. After a crash, run
`deno task down`, then `deno task up`: resuming existing state after a controller restart is not
implemented. Geth's real-time transaction-pool expiry continues while protocol time is paused.
