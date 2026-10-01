# Compiler CPU limit regression

Local verification on 2026-10-01. The reported GitHub Actions Gloas build used tag
`ci-b312399cd32ffd8272775480aef22a1cc5412d9c` and failed before compilation because its Docker
daemon exposed two CPUs while Panda requested `NanoCpus: 4e9`.

Acceptance: the shared CL/EL compiler path must retain the four-CPU ceiling while never requesting
more CPUs than the Docker daemon reports. Resource bindings, command, environment and exact Panda
ownership labels must survive. Invalid or unavailable CPU information must fail before container
creation. Cargo job concurrency is independent of the Docker CPU quota.

The original compiler-container configuration was extracted unchanged for the red test. A fixture
enforces Docker's CPU range at container creation. The one- and two-CPU cases failed; the eight-CPU
case passed. Invalid CPU information also failed its expected rejection assertion (`red.log`). After
querying the daemon's `NCPU` and using `min(4, NCPU)`, all four checks passed (`green.log`). Both
client kinds use this path for both hardfork profiles. These are Docker transport fixtures, not
evidence of a completed native build.

Executed checks:

- `./scripts/deno test -A tests/compiler_resources_test.ts`: 4 passed.
- `./scripts/deno task check`: formatting, lint and types passed (`check.log`). An initial global
  format check found an unformatted paragraph in concurrently edited Lido documentation; only its
  wrapping was corrected before repeating the check.
- `PANDA_DOCKER_TEST=0 PANDA_E2E=0 ./scripts/deno task test`: 76 passed, 0 failed, 13 ignored
  (`unit.log`).

No Docker tests, native compilation or profile suites were run locally, as requested. Real GitHub
runner validation remains pending. Once the fix reaches the default branch, start a new Lighthouse
workflow run. A rerun of the failed run retains its original commit. The builder source hash changes
automatically; existing bake manifests were not edited.

Log files preserve command output with trailing whitespace removed.
