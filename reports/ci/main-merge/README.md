# Main merge and CI consumer verification

Console logs mentioned below are local or CI artifacts, not versioned files. See the
[report retention policy](../../README.md).

The integration combines `origin/main` at `b917a74` with the CI branch at `b3c118c`. Native
Lighthouse patches, controlled clocks, consensus barriers and time algorithms match main. CI keeps
separate Lighthouse/Panda releases, pinned clients and versions derived from Git tags. Image source
labels and the Git remote now point to `https://github.com/eddort/panda`.

The Lido consumer is based on `c96c893ac67011681f4aa7caf4f7b9e25fa33aef`. Its patch is
[tracked separately](../../../integrations/lido-core/panda-ci.patch), and was checked against a
clean index at that base. Long historical-summary and exit-deadline jumps explicitly request
`mode: "fast"`; activation, voting and finality recovery still advance complete slots.

## Executed checks

All client builds and Docker executions in this report use local `linux/arm64`. The release
workflows still target `linux/amd64`; no GitHub workflow or registry publication was executed in
this run.

| Command/check                                                              | Actual result                                                                           | Evidence                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `deno task check`                                                          | Passed: formatting, lint and types                                                      | `check.log`                                                                            |
| `PANDA_DOCKER_TEST=0 PANDA_E2E=0 deno task test`                           | 60 passed; 13 opt-in Docker/profile tests ignored by this command                       | `unit.log`                                                                             |
| Docker registry error regression                                           | Red: stale digest incorrectly accepted; green: error rejected                           | `docker-progress-red.log`, `docker-progress-green.log`                                 |
| Lido RPC client regression                                                 | Red: fast options lost; green: exact options forwarded, default preserved               | `lido-client-red.log`, `lido-client-green.log`                                         |
| Lido `yarn typecheck` and targeted ESLint                                  | Passed                                                                                  | `lido-typecheck.log`, `lido-lint.log`                                                  |
| `actionlint` on both Panda workflows and the Lido consumer workflow        | Passed                                                                                  | `actionlint.log`                                                                       |
| `deno task smoke:docker`                                                   | Passed                                                                                  | `docker-smoke.log`                                                                     |
| `deno task bake gloas --tag ci-main-merge`                                 | Passed: native clock, BLS, weighted selection, direct-sync regressions and binary build | `bake-gloas.log`                                                                       |
| `PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno task test:baker`        | 4 passed                                                                                | `baker-gloas.log`                                                                      |
| `deno task test:image panda-ci-gloas:merge-main gloas`                     | Passed: fresh genesis, readiness, transaction, pause and shutdown                       | [report](gloas-container.json), `image-gloas.log`                                      |
| Lido `PANDA_URL=http://127.0.0.1:18547 yarn test:integration:panda --bail` | 15 passed against the packaged Gloas service; 21 scratch deployment steps               | [verifiers](lido-verifiers.json), `lido-verifiers.log`, [service](lido-container.json) |

Gloas bake: [ci-main-merge](../../../bakes/gloas/tags/ci-main-merge.json), key
`d769395a4ea4f4f4d3290b54aefa32780d32410248518ea319648353ab18fb86`. The local build happened before
the merge commit: its source revision label is `b3c118c`, while the manifest's builder/native hashes
identify the actual merged inputs. This is a local test artifact, not a published release.

## Environment interruption

The first Pectra build failed before compilation because the Docker VM disk was full; apt reported
invalid repository signatures. The `bake-pectra-disk-full.log` is retained locally. Signature
validation was not disabled. The unused, exactly owned Gloas and Pectra target caches was archived
on the host, compared byte-for-byte with `tar --compare`, and removed from Docker to free space. Its
archive, volume metadata and SHA-256 remain under `.cache/ci-main-merge/compiler-cache/`. Compiler
data remains recoverable; no global Docker pruning was used.

Pectra build and complete profile-suite results will be recorded after they finish.
