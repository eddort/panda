# Lighthouse release PR automation

Implemented flow: manual Lighthouse publication on the default branch → all
selected matrix jobs succeed → a release PR contains the published client locks
and planned Panda tag → a maintainer merges the PR → the merge workflow
validates the locks, creates the tag at the exact merge commit and dispatches
Panda publication.

The button accepts a future Panda `version` and a profile selection. Lighthouse
upstream/baker versions still come from profile recipes. PR commits use GitHub's
`createCommitOnBranch` API; the workflow neither approves nor merges the PR. The
repository must allow Actions to create PRs. No actual GitHub PR, tag or image
publication was performed during local validation.

## Executed verification

| Check                                                            | Actual result                                         | Evidence              |
| ---------------------------------------------------------------- | ----------------------------------------------------- | --------------------- |
| Feature tests before implementation                              | 5 failed, 1 passed; the new automation was absent     | [red](red.log)        |
| Initial focused feature tests after implementation               | 6 passed                                              | [green](green.log)    |
| Final unit suite, including a seventh partial-failure regression | 67 passed, 0 failed, 13 Docker/profile checks ignored | [unit](unit.log)      |
| `deno task check`                                                | Passed: formatting, lint and types                    | [check](check.log)    |
| `actionlint` on all three publisher/release workflows            | Passed                                                | [log](actionlint.log) |

The seven feature regressions cover complete immutable pins and the planned tag
in the PR; invalid/incomplete releases; retrying after branch/commit/PR API
failures; preservation of unrelated branch changes and authorization failures;
tagging the exact merge commit and avoiding a duplicate Panda dispatch;
rejection of unmerged/foreign/changed PR data; and retry after a failed dispatch
without moving an existing tag.

GitHub operations in these tests use an in-memory transport. They do not
establish live token permissions, API signing, artifact service availability or
a successful Actions release. Workflow syntax and expressions were checked
separately by actionlint. Runtime/native client sources and Docker topology were
unchanged; Docker builds and devnet suites were not run for this CI change.

GitHub behavior checked against primary documentation:

- [Workflow chaining with GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow):
  the merge job explicitly dispatches Panda after creating its tag.
- [GitHub-signed API commits](https://docs.github.com/en/graphql/reference/commits):
  the release PR uses `createCommitOnBranch`.
- [Artifact download layout](https://cli.github.com/manual/gh_run_download):
  each named artifact is downloaded to an explicit per-profile directory.
