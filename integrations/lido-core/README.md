# Lido core consumer

`panda-ci.patch` contains the consumer changes against Lido core's `feat/devnet-gloas-verifier-e2e`
checkout at `c96c893ac67011681f4aa7caf4f7b9e25fa33aef`. The same changes are applied to the local
pilot checkout under `.cache/pilots/lido-pr-1940-working`; this tracked patch preserves them outside
the ignored cache.

Apply from the matching Lido core checkout:

```sh
git apply --check /path/to/panda/integrations/lido-core/panda-ci.patch
git apply /path/to/panda/integrations/lido-core/panda-ci.patch
node --test scripts/tests/panda-client.test.cjs
yarn typecheck
```

The patch adds `PANDA_URL` support to the existing client and Hardhat network, delegates validator
import/exit to Panda's API, and adds **Integration Tests Panda**. The workflow accepts the published
Gloas image digest and runs `yarn test:integration:panda --bail` against a fresh service on port
18547. See [the image guide](../../docs/ci-containers.md) for publication and runtime details.
