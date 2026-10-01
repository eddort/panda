# Publish Lighthouse before Panda profile verification

Local verification on 2026-10-01. The previous Lighthouse workflow ran `test:profile` before its
first registry push, even though the Panda release workflow already ran the same full suite. A
profile failure could therefore discard a successfully compiled Lighthouse with the ephemeral
runner.

The Lighthouse workflow now publishes after `bake` and its native Rust tests. Publication still
validates native provenance, upstream/baker identity, original build commit and platform; imported
or mismatched artifacts remain rejected. It does not require a Panda profile report. The release PR
describes native checks and leaves full profile validation to Panda.

The Panda workflow still runs `test:profile` before packaging and the packaged-service check before
its image push. A failure there blocks Panda publication while the Lighthouse image remains in GHCR.
Builder inputs and the Lighthouse identity algorithm are unchanged by this fix. The workflow already
running on GitHub keeps its original ordering and cannot pick up these local changes.

Executed checks:

- TDD red: four checks failed after extracting the original publication guard without changing its
  behavior. Both profile fixtures were blocked by the missing Panda report; the workflow still
  contained the duplicate full-profile step (`red.log`).
- Focused green: four checks passed for Pectra/Gloas publication without a Panda report, rejection
  of imported/mismatched artifacts and retention of Panda's verification-before-push ordering
  (`green.log`). Artifact fixtures do not establish real client compatibility.
- `./scripts/deno task check`: formatting, lint and type checking passed (`check.log`).
- `PANDA_DOCKER_TEST=0 PANDA_E2E=0 ./scripts/deno task test`: 80 passed, 0 failed, 13 ignored
  (`unit.log`).
- `actionlint`: all three release workflows passed (`actionlint.log`).
- Reviewed the diff of every builder input against HEAD: no builder, recipe, patch, native test or
  pinned dependency changes are part of this fix.

No Docker build, profile run, GitHub workflow dispatch or registry publication was performed for
this change. Actual release execution remains to be verified on GitHub. Logs retain command output
with trailing whitespace removed.
