# Lighthouse release PR automation

Console logs mentioned below are local or CI artifacts, not versioned files. See the
[report retention policy](../../README.md).

Implemented flow: manual Lighthouse publication on the default branch → all selected matrix jobs
succeed → a release PR contains the published client locks and planned Panda tag → a maintainer
merges the PR → the merge workflow validates the locks, creates the tag at the exact merge commit
and dispatches Panda publication.

The button accepts a future Panda `version` and a profile selection. Lighthouse upstream/baker
versions still come from profile recipes. PR commits use GitHub's `createCommitOnBranch` API; the
workflow neither approves nor merges the PR. The repository must allow Actions to create PRs. No
actual GitHub PR, tag or image publication was performed during local validation.

## Executed verification

| Check                                                            | Actual result                                         | Evidence         |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ---------------- |
| Feature tests before implementation                              | 5 failed, 1 passed; the new automation was absent     | `red.log`        |
| Initial focused feature tests after implementation               | 6 passed                                              | `green.log`      |
| Final unit suite, including a seventh partial-failure regression | 67 passed, 0 failed, 13 Docker/profile checks ignored | `unit.log`       |
| `deno task check`                                                | Passed: formatting, lint and types                    | `check.log`      |
| `actionlint` on all three publisher/release workflows            | Passed                                                | `actionlint.log` |

The seven feature regressions cover complete immutable pins and the planned tag in the PR;
invalid/incomplete releases; retrying after branch/commit/PR API failures; preservation of unrelated
branch changes and authorization failures; tagging the exact merge commit and avoiding a duplicate
Panda dispatch; rejection of unmerged/foreign/changed PR data; and retry after a failed dispatch
without moving an existing tag.

GitHub operations in these tests use an in-memory transport. They do not establish live token
permissions, API signing, artifact service availability or a successful Actions release. Workflow
syntax and expressions were checked separately by actionlint. Runtime/native client sources and
Docker topology were unchanged; Docker builds and devnet suites were not run for this CI change.

GitHub behavior checked against primary documentation:

- [Workflow chaining with GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow):
  the merge job explicitly dispatches Panda after creating its tag.
- [GitHub-signed API commits](https://docs.github.com/en/graphql/reference/commits): the release PR
  uses `createCommitOnBranch`.
- [Artifact download layout](https://cli.github.com/manual/gh_run_download): each named artifact is
  downloaded to an explicit per-profile directory.

## GraphQL branch field regression

GitHub rejected the release commit because the request used `refName` instead of the
[`CommittableBranch.branchName` input](https://docs.github.com/en/graphql/reference/git#committablebranch).
The test transport previously accepted this invalid input. It now checks the exact branch fields;
the request uses `branchName`, and commit failures report API messages without dumping echoed file
contents from GraphQL error extensions.

The stricter request regression failed before the fix (5 passed, 3 failed). After correcting the
branch field, the error-output regression still failed (7 passed, 1 failed), then all 8 release
tests passed. `deno task check` passed. The first full unit run had 76 passed, 11 failed and 13
ignored: the sandbox denied the localhost listeners required by those 11 tests. With localhost
access, the full suite passed: 87 passed, 0 failed, 13 ignored. Red/green logs are private local
artifacts under `.cache/release-pr-graphql/`. Docker and live GitHub mutations were not run.
Lighthouse build inputs are unchanged.

For a fresh run after this failure, first check whether the release branch still points exactly to
the original failed run's source SHA. If it has no release or contributor commits, remove that
abandoned branch before reusing the same version. Preserve any branch that has acquired changes.
Push the fix to the default branch and use **Run workflow** from that branch; rerunning the old run
uses its old source revision. Existing matching Lighthouse images can be reused from GHCR.
Under repository **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub
Actions to create and approve pull requests** for the release bot to open its PR.

## Standalone release from published images

**Release Panda from published images** selects the newest published client lock artifact for every
registered profile and opens a release PR. It has no Docker, bake, native compilation or Lighthouse
workflow dispatch step. The three existing workflows are unchanged. Exact artifact IDs are used for
download, so selection cannot switch to another artifact with the same name during download.

Five new regressions cover publication followed by a failed PR job, separate runs per profile,
workflow/branch/repository restrictions, missing or expired locks and authorization errors,
pagination, publication-time ordering, and the independent workflow's lack of build steps.
The initial run failed before the new selector module existed. After implementation, 14 focused
release/security tests passed. The full unit suite passed 92 tests with 13 Docker/profile opt-ins
ignored; formatting, lint, types and `actionlint` passed. Local evidence is under the ignored
`.cache/release-existing/` directory.

Read-only verification against GitHub selected run `36836753889`, with Pectra artifact
`11150842738` and Gloas artifact `11150726579`. Both ZIP archives were downloaded and each contained
only `clients.lock.json`; both real locks passed `prepareRelease` validation. This establishes
artifact selection/download and local release preparation, not an executed Actions job or PR
publication. No GitHub mutation, Docker build or devnet test was performed.
