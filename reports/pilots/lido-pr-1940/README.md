# Lido PR 1940 scratch deployment on Gloas

**Follow-up: [the modified clone now completes the full deployment](fixed/README.md)** in 263.27
seconds, with 514 successful transactions and passing deployment acceptance. The account below
preserves the original unmodified attempt and its failure evidence.

The full scratch deployment **failed** at `0100-deploy-circuit-breaker`. This
pilot ran the upstream migration entrypoint against real Geth/Lighthouse with
automine. No upstream repository tests were executed. Contract and zap-net
source were unchanged.

| Measured phase                                  |   Wall time |
| ----------------------------------------------- | ----------: |
| Install core dependencies                       |     24.60 s |
| Compile core contracts                          |     98.50 s |
| Start measured Gloas network with cached images |     12.83 s |
| Empty block / transaction indexer readiness     |      0.40 s |
| Successful migration prefix, through `0090`     | **67.15 s** |
| Entire attempt, ending in failure               | **72.73 s** |

The successful prefix contains **114 successful transactions**. The next
transaction reverted. All **84 contract addresses recorded in the partial
deployment artifact** have nonempty runtime bytecode. This checks deployment
presence, not protocol behavior or initialization completeness.

## Failure

Foundry 1.7.1 broadcast CircuitBreaker creation with **1,426,395 gas**. The
receipt has status `0` and consumes that entire allowance. Geth's call tracer
reports `contract creation code storage out of gas`; Geth estimates **7,586,344
gas** for the same creation input. The upstream Forge command already passes
`--gas-limit 16000000`, but the broadcast transaction still uses the lower
simulation estimate.

The next scoped task is to make external Forge deployments use gas estimates
compatible with Amsterdam, then rerun from a fresh chain. A later obstacle is
visible in source: step `0140` uses Agent account impersonation. That step was
not reached or executed here.

## Reproduction inputs

- Source: [Lido core PR 1940](https://github.com/lidofinance/core/pull/1940),
  commit `2f4a21d0ba89826087ef328ecf9fbdf0775f8e44`.
- Bake: `gloas:stable`, key
  `8b1fa94aaf9f1719d3c61793bd960344531335270ab88b82c908ca2184b094f9`.
- Controller:
  `ZAP_ID=lido1940 ZAP_PORT=18545 ./scripts/deno task up --profile gloas --bake stable`.
- Core:
  `yarn hardhat --network local-devnet run --no-compile scripts/utils/migrate.ts`.
- Use the standard public local-development deployer, chain ID `1337`, genesis
  `2000000000`, genesis fork version `0x10000000`, 32 slots/epoch, real genesis
  deposit contract `0x4242424242424242424242424242424242424242`,
  `GAS_MAX_FEE=10`, `GAS_PRIORITY_FEE=1`, empty `GAS_LIMIT`, and the supplied
  `deploy-params.toml` (four `gloasSlot` values set to zero).
- Compile beforehand; invoke the migration directly because the upstream scratch
  shell helper overwrites `GENESIS_TIME`. Run one empty real slot and verify
  indexer readiness before timing.
- `STEPS_FILE=scratch/steps.json`, `MODE=scratch`, `AUTO_CONFIRM=true`,
  `ALLOW_SKIP_STEPS=false`, `NETWORK_STATE_FILE=deployed-local-devnet.json`. No
  migration steps were skipped.

Timing starts before the Hardhat process launches and ends when it exits. It
includes migration logic, RPC polling and file I/O. The failed CircuitBreaker
phase also includes its external repository clone, dependency installation,
compilation and Forge simulation. Preparation phases above are outside the
deployment timer. These are one-run measurements, not full-deploy benchmarks.

## Launch audit

A dry run of the upstream `dao-deploy.sh` → `run-migration.sh` wrappers with an
inert `yarn` shim confirmed they invoke the same migration command used by the
pilot. Compilation was done separately in the pilot. Comparing the explicitly
configured deployment variables revealed two substantive wrapper differences: it
overwrites `GENESIS_TIME` with `1639659600` and fills an empty `GAS_LIMIT` with
`16000000`. The pilot uses the actual network genesis (`2000000000`) and Geth
gas estimation. The wrapper also normalizes absent `UPGRADE` to `false`; this is
not an upgrade run.

The installed Foundry version, `1.7.1`, matches this commit's scratch
integration workflow. The CircuitBreaker Forge command is unchanged, including
its existing `--gas-limit 16000000` argument. The audit did not execute a second
deployment or any repository tests. See [launch audit](launch-audit.json) for
captured wrapper commands and environment differences.

## Evidence

- [Summary and step timings](summary.json)
- [Deployment output](deploy.log), with the public local-development key
  redacted
- [Transaction receipts, selected fields](transactions.json)
- [Partial deployment state](deployment-state.json)
- [Recorded contracts and runtime code sizes](deployed-code.json)

This original partial-state network has been stopped. The successful follow-up is running at
`http://127.0.0.1:18546`; see the [follow-up report](fixed/README.md).
