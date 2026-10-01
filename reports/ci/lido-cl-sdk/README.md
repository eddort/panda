# Lido SDK consensus checks

Local verification on 2026-10-01 against the Lido consumer checkout based on
`c96c893ac67011681f4aa7caf4f7b9e25fa33aef`.

The consumer workflow uses the native Beacon API on port 5052. SDK startup verifies canonical,
non-optimistic CL genesis, controller/native head identity, genesis time, chain ID and Gloas
configuration. Proof captures verify the Gloas block/bid/envelope against canonical EL history.
Finalization waits confirm the Gloas checkpoint's execution parent against EL's finalized block.
Existing SSZ, EIP-4788, signature, contract-revert and fast-warp scenarios remain in place.

Executed:

- TDD red: all seven initial SDK regression groups failed against the old client (`red.log`).
- Focused green: eight SDK groups passed, including malformed/unavailable CL endpoints, optimistic
  or mismatched CL data, canonical payload mismatches and incorrect finalized execution
  (`green.log`).
- `yarn typecheck`: passed.
- `yarn eslint lib/panda/index.ts test/integration/panda/helpers/protocol.ts
  test/integration/panda/verifiers.integration.ts --max-warnings=0`:
  passed.
- Prettier checks for modified consumer files: passed.
- Strict actionlint reports an existing missing description in the consumer's shared `Common setup`
  action (`actionlint.log`). Its metadata was confirmed unchanged from the base commit. Workflow
  validation passes with only that exact pre-existing diagnostic excluded; the unrelated shared
  action was not modified. The exclusion was
  `-ignore '^description is required in metadata of "Common setup" action '`.
- The regenerated consumer patch applies to a clean temporary index at the documented base.

The SDK regressions above use local HTTP fixtures. After the user requested consumer verification,
the updated integration suite was also executed against real clients:

- `yarn test:integration:panda --bail`: **15 passing**, exit code 0 (`lido-verifiers.log`).
- The full run, including startup and cleanup, took 348.55 seconds. Scratch deployment completed
  all 21 steps in 213.49 seconds.
- Profile `gloas`, bake `ci-main-merge`, key
  `d769395a4ea4f4f4d3290b54aefa32780d32410248518ea319648353ab18fb86`.
- External SDK mode used `PANDA_URL=http://127.0.0.1:18547` and
  `PANDA_BEACON_URL=http://127.0.0.1:5052`. The native Beacon API was relayed independently of the
  controller's HTTP proxy. `PANDA_ROOT` was empty, and `PANDA_BAKE=ci-main-merge`.
- Existing immutable Geth, Lighthouse and genesis images were restored from local archives. No
  clients were rebuilt. This run used a host controller with Docker clients on `linux/arm64`;
  it does not validate the packaged service image or the GitHub Actions `linux/amd64` build.
- All eight proof captures passed SSZ, EIP-4788 and Gloas block/bid/envelope/canonical EL agreement
  checks. Valid and invalid BLS deposits, activation, consolidation request delivery, recent and
  historical exit proofs, and a real signed voluntary exit passed their existing assertions.
- After the fast jumps, the suite confirmed that both the finalized CL epoch and its matching EL
  finalized block advanced, then accepted a fresh proof. The final CL checkpoint was epoch 769.
- Cleanup left zero containers, networks or volumes labeled `io.panda.id=lido-cl-90829ad9`.
  Ports 18547 and 5052 were closed; unrelated Docker workloads were still running.

`real-run.json` records client identities, endpoints, initial/final status and cleanup.
`lido-verifiers.json` records proof roots, corresponding execution blocks and transactions.
`sources.json` binds the run to the Panda commit and tested consumer files. The portable consumer
patch was applied to a temporary index at the documented base and all eight files were compared
byte-for-byte with the tested checkout; the real checkout's index was not changed.

The local harness and complete controller/client logs remain under `.cache/ci-lido-cl/`; the
consumer's full state captures and deployment log are under
`.cache/pilots/lido-pr-1940-working/.local/panda/core-62a984ad/`.
