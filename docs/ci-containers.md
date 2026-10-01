# Versioned CI images

## Separate Lighthouse and Panda releases

Lighthouse is built by **Publish Lighthouse images** (`.github/workflows/lighthouse.yml`). Panda is
packaged by **Publish Panda images** (`.github/workflows/images.yml`). Publishing a new Panda
version pulls existing client images by digest; it never invokes the Rust compiler or `bake`.

| Artifact                  | Example                                                 | Version source   |
| ------------------------- | ------------------------------------------------------- | ---------------- |
| Patched Pectra Lighthouse | `panda-lighthouse-pectra:v7.1.0-cfb1f7331064-b1-<hash>` | Upstream + baker |
| Patched Gloas Lighthouse  | `panda-lighthouse-gloas:v8.2.2-2d281dfa1b40-b1-<hash>`  | Upstream + baker |
| Panda with Pectra clients | `ghcr.io/eddort/panda-pectra:v1.2.3`                    | Git tag `v1.2.3` |
| Panda with Gloas clients  | `ghcr.io/eddort/panda-gloas:v1.2.3`                     | Git tag `v1.2.3` |

Lighthouse repositories also live under `ghcr.io/eddort/`. Their tags are derived automatically:
`v<upstream-version>-<commit-12>-b<baker-version>-<baker-hash-12>`. There is no manually assigned
client release number. `clVersion`, the pinned `clRef`, and `bakerVersion` are declared in each
profile recipe. The builder reads the actual upstream Cargo package version and rejects a mismatch.
The existing pins declare 7.1.0 for Pectra and 8.2.2 for Gloas; the Gloas commit identifies the
experimental branch even though its Cargo version is shared with other revisions.

The two inputs that invalidate a Lighthouse image are:

1. **Upstream Lighthouse:** its original package version and exact Git commit.
2. **Panda's baker:** its explicit version and the content hash of builder code, the selected
   patch/clock/native sources, native test targets, pinned toolchain/runtime images and platform.

Bump `bakerVersion` when releasing a new baker revision. The content hash also changes automatically
when a build input changes, protecting against accidentally reusing an image after an unbumped edit.
Changing another profile's patch or changing the Panda controller does not invalidate this image.
Rust and runtime image refs must be immutable before the CI identity is computed. The Gloas Rust
builder is now pinned to the digest already recorded in its existing bake.

The complete EL/CL/genesis selection has a separate `ci-<hash>` bake tag. Updating Geth, genesis,
baseline client or runtime profile settings changes that selection, while retaining the same
Lighthouse identity. The native Lighthouse cache is likewise separate from the full-bake cache. Two
Panda Git versions can therefore reuse precisely the same Lighthouse image and client lock.

## First publication and client updates

1. Set the desired `clVersion`/`clRef` and `bakerVersion` in the profile recipe. Run **Publish
   Lighthouse images** with `profile=all`, or select just the changed profile.
2. The workflow computes the upstream/baker tag and checks GHCR. HTTP 404 builds native
   `linux/amd64` Lighthouse and runs native tests. HTTP 200 reuses the existing image by digest,
   verifies its embedded full build identity, and skips Rust compilation. Authentication failures,
   outages and malformed registry responses fail instead of triggering a rebuild. Geth, genesis and
   baseline Lighthouse use their own pinned images. The complete selected profile suite runs in
   either case, then the workflow publishes a new Lighthouse image or retains the existing one.
3. Download the `lighthouse-<profile>-<upstream-baker-tag>` workflow artifact. It includes a
   generated `clients.lock.json`, the original bake manifest and verification reports. For each
   profile, run:

   ```sh
   ./scripts/deno task clients:pin /path/to/downloaded/clients.lock.json
   ```

   This validates the release and writes `bakes/<profile>/release/clients.lock.json`. Commit that
   generated file. Keep it unchanged until intentionally selecting another client release.
4. Create and push the Panda Git tag, for example `v1.2.3`. This triggers **Publish Panda images**
   for all registered profiles. There is no manual Panda `revision` input. For a retry or a single
   profile, dispatch the workflow on that same Git tag using, for example,
   `gh workflow run images.yml --ref v1.2.3 -f profile=gloas`.

Panda accepts `vMAJOR.MINOR.PATCH` and prereleases such as `v1.2.3-rc.1`; the Docker image tag is
identical. Branch refs, malformed versions and SemVer build metadata (`+...`) are rejected rather
than normalized into potentially colliding Docker tags. Existing registry versions cannot be
overwritten by either workflow.

The first client locks do not exist yet: no amd64 Lighthouse image has been published from this
work. They must come from the actual publication output; the repository does not contain invented
digests or references to unpublished images. Missing locks stop Panda's release before any client
build or service packaging. A default `all` release requires a committed lock for every registered
profile. Adding a new hardfork uses the existing dynamic profile matrix and its own lock.

## What each workflow verifies

The Lighthouse workflow checks that its selected profile passed with the current suite fingerprint
and bake key before publishing. The generated lock contains the original immutable bake verbatim,
plus the published Lighthouse repository digest and the source commit of the build. A bake created
with `--import-cl` cannot be presented as a native Lighthouse release.

The Panda workflow validates that its ref is a release Git tag and that its client locks are
committed. `clients:restore` loads Lighthouse, Geth, genesis and the baseline client by digest and
checks the actual image IDs and architecture. Failed pulls do not install a bake manifest; an
existing conflicting local bake is preserved. Restoring clients has no compiler fallback. The
original bake identity and native provenance survive transport through the registry.

Panda then runs the selected full profile suite against the current controller, packages the exact
EL/CL/genesis images, and tests the resulting service before publishing. A new controller version
therefore requires compatibility verification, but does not require a new Lighthouse build. Each
profile publishes independently after its own checks.

Both workflows serialize publication per profile/version. New publication requires confirmed absence
in the registry. Panda rejects existing versions; Lighthouse reuses existing versions after checking
their digest and build identity. Administrators can still move tags outside these workflows, so
client locks and consumers use `@sha256:...`. Workflow artifacts retain verification and published
identities. The service's `/opt/panda/release.json` records its Git version and commit, original
bake, architecture, client identities and published Lighthouse reference. OCI labels expose the
Panda version, source commit, hardfork and bake key. The Lighthouse image also has labels for
upstream version/commit, baker version/hash, full build identity and the original Panda source
commit used to build it. Reusing Lighthouse preserves that original build commit instead of
substituting the current controller's commit.

GHCR packages must permit the repository's token to pull them. Client restore supports private GHCR
images using `GITHUB_ACTOR` and `GHCR_TOKEN`; public images can be restored without credentials.

## Lido core consumer

The existing Lido suite is `test/integration/panda/verifiers.integration.ts` in the
`feat/devnet-gloas-verifier-e2e` checkout. Its workflow **Integration Tests Panda** accepts the
published Gloas digest and uses:

```yaml
env:
  PANDA_URL: http://127.0.0.1:18547
services:
  panda:
    image: ghcr.io/eddort/panda-gloas@sha256:<published-digest>
    ports:
      - 127.0.0.1:18547:8545
    options: --privileged --stop-timeout 120 --label io.panda.id=lido-ci
```

After the existing Node/Foundry/just setup, it runs `yarn test:integration:panda --bail`. The suite
performs its own warmup and scratch deployment. `PANDA_URL` connects to the service; `PANDA_ROOT`
continues to start a local controller. The remote client reads no Panda files and never stops the
externally owned service. Start a new service for every suite. For a private Panda package the
consumer can use `PANDA_REGISTRY_TOKEN`.

Ethereum RPC, Beacon API and `/control` share one endpoint. Importing validator keys uses the real
Lighthouse keymanager; Lighthouse signs voluntary exits before submission to the Beacon API.
Keymanager credentials stay on the controller host. The consumer patch is described in
[integrations/lido-core](../integrations/lido-core/README.md).

## Packaging and runtime

The final Panda image contains Deno, the controller and archives of the already published EL/CL and
genesis images. Its private Docker daemon loads those archives at startup. Beacon node and validator
client use the same Lighthouse image. Startup uses the packaged artifacts without compiling or
pulling clients. This self-contained service requires `--privileged` and has larger image/storage
requirements than a controller-only image.

The internal daemon uses a Unix socket and classic `overlay2` storage to preserve baked image IDs.
The controller relay listens on port 8545; bind the host port on loopback. Never mount the host
Docker socket. Host/Origin checks still apply. All resources use exact `io.panda.id` ownership.
SIGTERM closes the controller and its resources before stopping the private daemon.

Initial readiness requires block zero, slot zero and automine off. Health probes remain read-only
while the suite controls time. Restarts start a fresh chain; daemon failure stops the service.
Existing large time jumps retain their documented skipped-slot semantics. These checks do not
establish honest fast-forward or validator-economics certification.

Deno 2.9.7 is inside the service. Base images use digests, direct npm dependencies use exact
versions, and dependency caching uses `deno.lock` with `--frozen-lockfile`. Runtime uses
`--cached-only`.

For local packaging of an existing bake (no registry publication):

```sh
./scripts/deno task package:image gloas panda v0.0.0-local.1 eddort "$(git rev-parse HEAD)"
docker build -t panda-ci-gloas:local \
  -f .cache/containers/gloas/v0.0.0-local.1/container/Dockerfile \
  .cache/containers/gloas/v0.0.0-local.1
./scripts/deno task test:image panda-ci-gloas:local gloas
```

Package directories refuse reuse. Choose a new local version after changing packaged sources. Local
packaging accepts an existing native bake; published client locks require `linux/amd64`. ARM
packaging checks do not establish that the amd64 publication pipeline passed.

## Verification record

For the split release pipelines, local verification is limited to unit tests, formatting, lint,
types and workflow validation. Docker tests and builds were not run, as requested. Unit coverage
checks Git-tag version selection, reuse of a client release across Panda versions, rejection of
mutable/mismatched pins, failed restore behavior and Docker publication ownership using an in-memory
transport. Red/green evidence is under `.cache/ci-release-split-*.log`.

- `deno task check`: passed (formatting, lint and types).
- The split-pipeline unit run passed 39 checks, with 11 Docker/integration checks ignored. The newer
  upstream/baker identity checks are recorded separately below. The HTTP unit fixtures required
  permission to bind loopback; the initial sandbox-only attempt failed on those two fixtures, and
  the run with loopback access passed.
- `actionlint`: passed for both publisher workflows and the existing Lido consumer workflow.
- The initial Git-tag regression run failed three assertions under the old manual revision behavior.
  After implementation all nine release/client unit checks passed.

The following results predate the split and are historical evidence only:

- Controller API and Lido HTTP client regressions passed; Lido `yarn typecheck` passed.
- The existing Lido Gloas suite through port 18547 passed 15 tests in 8 minutes, including validator
  import, signed exit and resumed real finality. The service remained running after client close.
  Raw evidence: [Lido verifier report](../reports/ci/lido-gloas-verifiers.json).
- ARM service checks passed for Pectra (23.46 seconds) and Gloas (20.45 seconds): genesis, read-only
  readiness, Host protection, transaction inclusion, pause and SIGTERM shutdown.
- A Gloas host run failed after its EL image was deleted during startup. The subsequent run in an
  isolated daemon passed all 8 scenarios in 536.2 seconds. The Pectra full run was interrupted; its
  report records failure, not a completed pass.

No GitHub amd64 workflow or GHCR publication has been executed. Current runtime changes require new
profile verification in CI; historical reports do not certify the new release.

The upstream/baker identity change has separate red/green evidence under
`.cache/ci-lighthouse-version-*.log` and `.cache/ci-lighthouse-identity-*.log`. Unit checks cover
both rebuild causes, reuse across Panda/Geth changes, per-profile patch isolation, actual Cargo
version parsing, registry absence/error handling and rejection of mismatched published build labels.
Docker/compiler/profile execution remains unverified for this change and was not run locally.

Current results: `deno task check` passed; the unit command with Docker/e2e disabled passed 45
checks (11 ignored); `actionlint` passed both publisher workflows. The actual cached upstream Cargo
files matched the declared 7.1.0 and 8.2.2 versions. A read-only HTTP query confirmed that the
pinned Gloas Rust digest is a multi-platform index containing `linux/amd64`; no Docker daemon or
container was used for that query.
