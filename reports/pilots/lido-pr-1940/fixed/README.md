# Working Lido PR 1940 scratch deployment on Gloas

The canonical **`yarn deploy:scratch` completed all 21 migration steps in 263.27 seconds** on a
fresh `gloas:stable` chain. All **514 transaction receipts succeeded**, and all six post-deployment
acceptance groups passed. This is one successful full measurement with cached sources, dependencies
and compiler artifacts, not a cold-install benchmark.

The independent working clone is `.cache/pilots/lido-pr-1940-working/`, based on core commit
`2f4a21d0ba89826087ef328ecf9fbdf0775f8e44`. Its HEAD is unchanged. No commits were created in core or
zap-net. All deploy changes are uncommitted in that clone; the original pilot clone was preserved.
Zap-net client/runtime source and the baked images were not modified.

## Measurement

| Phase | Wall time |
| --- | ---: |
| Start fresh Gloas network using existing images, outside deploy timer | 10.69 s |
| Empty slot and transaction-indexer readiness, outside deploy timer | 0.40 s |
| Full `yarn deploy:scratch`, including cached compile invocation | **263.27 s** |
| Circuit Breaker step, included above | 1.58 s |
| EDF step, included above | 1.94 s |
| CSM + CMv2 deployment step, included above | 128.48 s |
| Module connection and governance step, included above | 18.00 s |
| Final role handoff, included above | 27.41 s |

Step durations run from a migration's start to the next start (or process exit for the last step).
The timed command includes external dependency checks, Forge deployments, RPC polling, on-chain
configuration, and DAO voting. Initial core dependency installation and compilation were completed
before timing. External source/compiler caches were populated by the preceding run.

There were 539 execution blocks: 514 transaction-bearing blocks and 25 empty blocks (one warmup,
24 for the vote). Each transaction was sent by the ordinary local development EOA. There were 117
top-level contract creations and zero failed receipts. The 24 full protocol slots needed for the
vote took **8.91 seconds**, included in the deployment timer. The post-deployment Beacon API
reported finalized epoch 14; no new finality/validator-economics certification was attempted here.

## Changes

- Respect the supplied genesis time and use RPC gas estimation by default in the shell wrapper;
  preserve an explicitly configured fixed gas limit.
- Apply Foundry `--skip-simulation` RPC estimation and sequential broadcasting to Circuit Breaker,
  EDF, CSM and CMv2. Solidity sources in core and external packages are unchanged.
- Pin external repositories to explicit commits and cache source/dependencies/build artifacts in
  `.cache/external-deploy/`. Verify the selected HEAD and reject tracked source modifications.
- Replace Agent impersonation in module setup with an actual TokenManager → Voting → Agent vote,
  signed by a configured LDO holder. Keep the existing 300-second voting duration. The runner
  advances complete slots through zap-net's control API while the vote waits.
- Calculate the external HashConsensus far-future sentinel using its actual genesis and slot
  configuration. The upstream hardcoded value did not match this chain, silently leaving both
  external oracles inactive; the acceptance check exposed this on the intermediate run.
- Supply a local deployment TOML with Gloas activation slots zero and the largest existing LDO
  allocation assigned to the local deployer, keeping total allocations and voting parameters.
- Add a repeatable local runner, shell regression tests, and real-RPC deployment acceptance.

External commits are recorded in [source-manifest.json](source-manifest.json). The complete
[core.patch](core.patch) includes the new files and applies to the pinned core commit. Run commands
and prerequisites are documented in the working clone's `docs/scratch-zapnet.md`.

## Verification and TDD

- Before the wrapper fix: the new shell regression failed on overwritten genesis and fixed gas;
  afterwards `node --test scripts/tests/migration-env.test.cjs` passed both tests.
- Before the deployment fixes: real-chain acceptance failed on the original incomplete deployment.
- The first modified full run exited successfully in 269.57 seconds, but acceptance rejected the
  inactive external oracle epoch. It is retained as **red evidence**, not a successful deployment.
- After the epoch fix: a second run from fresh genesis completed in 263.27 seconds with all six
  acceptance groups passing. This also exercised reuse of the pinned external build cache.
- `yarn typecheck`, ESLint for the six changed/new TypeScript files, core compilation, and
  `git diff --check` passed. No upstream Hardhat/Foundry repository test suites were run.

Acceptance reads actual chain state: deployed code at recorded implementations/proxies, four
registered staking modules, resumed CSM/CMv2, active external consensus epochs, circuit breaker
permissions, DAO admin roles with deployer roles revoked, 11 core proxy admin handoffs, and an
executed governance vote. A separate receipt sweep checks every transaction in this fresh chain.

This establishes scratch deployment and the listed wiring checks. Deposits, oracle submissions,
withdrawals, Gloas proofs and upgrade paths have not been exercised. EasyTrack remains the upstream
scratch `EasyTrackEVMScriptExecutorStub`.

## Evidence and running network

- [Timing and initial/final chain status](result.json)
- [Acceptance result](acceptance.json), [transaction summary](chain-summary.json),
  [all receipt statuses](transactions.json)
- [Deployment state and contract addresses](deployment-state.json)
- [Deployment log](deploy.log), [progress events](progress.jsonl)
- [Environment red](tdd/env-red.log), [environment green](tdd/env-green.log),
  [original deployment red](tdd/original-deploy-red.json),
  [oracle epoch red](tdd/oracle-epoch-red.json), [final green](tdd/final-green.json)

The successful network is left running at **http://127.0.0.1:18546**, ID `lido1940fix`, chain ID
1337, profile `gloas:stable`, bake key
`8b1fa94aaf9f1719d3c61793bd960344531335270ab88b82c908ca2184b094f9`. Automine is enabled.

To stop only this network, from zap-net:

```sh
ZAP_ID=lido1940fix ./scripts/deno task down --profile gloas --bake stable
```
