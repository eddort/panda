# Bake layout migration verification

Date: 2026-09-30. This change reorganized the layout and profile loading; time algorithms,
consensus, and native clients were unchanged. A new warp that skips no duties remains a separate
task.

## TDD

Before the changes: `deno task check` passed; `deno task test` — 19 passed, 0 failed, 10 opt-in
ignored.

`deno test -A tests/bake_layout_test.ts tests/profiles_test.ts` after adding regressions and before
the migration: **6 failed, 5 passed**. Failures covered old paths, recipes mixed with tags,
undetected manifest conflicts, and inability to restore a legacy source from the new path. These
were behavioral assertion failures, not compilation errors or Docker unavailability.

After the migration, the same suite plus the isolation check: **12 passed, 0 failed**. An additional
RED found that reassigning scenarios among the same files did not change the suite fingerprint. The
scenario → file map was added to the fingerprint; the same regression passed.

Original session logs: `.cache/bake-layout/red.log`, `red-routing.log`, `green-initial.log`,
`unit-green.log`, and `docker-baker.log`. The `.cache/` directory is not tracked in Git.

## Artifact integrity

SHA-256 hashes of the original files were saved before moving them. After the migration, all **15**
checked files matched: 9 completed manifests, 2 patches, and 4 Rust sources/tests. Image IDs, bake
keys, pins, and patch contents were unchanged. Clients were not rebuilt.

Exact native-input archives for all 9 tags were checked and saved. The archive for
`pectra/geth-source` was missing and was created before the move. A unit regression additionally
restores a legacy hash key from a relocated file without a Git checkout and rejects differing bytes.

The `bakes` CLI lists exactly 9 existing artifacts; recipes are excluded. A test directory
separately checks the tags `recipe` and `shared`, a legacy-only manifest, identical copies, and
rejection of conflicts. Old and new paths do not make successful reads ambiguous.

## Checks

| Command                                                  | Result                                 |
| -------------------------------------------------------- | -------------------------------------- |
| `deno task check`                                        | passed after migration                 |
| `deno task test`                                         | 24 passed, 0 failed, 10 opt-in ignored |
| `deno task test:baker`                                   | 3 passed, 0 failed, 44 s               |
| `deno task test:profile gloas --bake stable`             | 8 passed, 0 failed, 566.9 s            |
| `deno task test:profile pectra --bake default`           | 6 passed, 1 failed (warp), 632.7 s     |
| `ZAP_PROFILE=pectra ZAP_BAKE=default deno task e2e:warp` | failed: second jump 20.679 s > 20 s    |

Docker checks confirmed artifact import and reuse across tags, preservation of the previous tag when
replacement fails, restoration of the same local image ID from an archive, and rollback without
deleting another workload's resource. The syntax of both relocated Python maintainer helpers was
checked through AST parsing.

Both profiles are affected by the migration of the shared test directory and loader. Their
integration was checked sequentially with separate commands on the existing images. This does not
change the rule: editing one independent profile does not trigger builds/tests for another.
Historical `verified` results do not carry over to a new suite fingerprint without an actual run.

[Gloas verification](../reports/profiles/gloas/stable/verification.json) binds all 8 reports to run
ID `1a37152e-768e-4ae9-a748-4afca8b3f2ae` and the previous bake key. Two 8192-slot jumps including
the next transaction took 11.488 / 9.975 s. Deployment: 20 dependent contracts via raw RPC and
ethers, each in the next block, without manual time advancement.

[Pectra verification](../reports/profiles/pectra/default/verification.json), run ID
`3280f20f-4dd3-42d0-82cd-6138671fceea`, remains failed. Baseline, lifecycle,
time/automine/finality/indexer, deposit/activation/consolidation, voluntary exit/full withdrawal,
and 20 sequential deployments passed. The original overall migration report:
[JSON](../reports/bake-layout.json).

The first full Pectra run exposed a failure in the existing warp scenario. The first jump including
the next transaction took **22.243 s** against the unchanged 20 s threshold. After finality
recovered, signing-history export failed with Docker HTTP 409: the VC was paused when `exec`
started. Docker events contain two closely spaced pause/unpause cycles; the source of the second is
unknown. The `warp-892dfa07` test network was removed by normal cleanup; its `.zap/` logs and
diagnostics were saved in `.cache/bake-layout/pectra-warp-*`. The warp scenario itself matches HEAD
byte for byte after import-path normalization. This does not establish the cause of the failure;
Pectra cannot be declared fully verified based on neighboring scenarios passing.

A separate `e2e:warp` rerun on the same code completed in 160.738 s: two jumps including the next
transaction took **17.195 / 20.679 s**, finality recovered after both, all 64 validators were
active/unslashed, and signing-history checks passed. Docker 409 did not recur. The scenario still
**failed** because the second jump exceeded 20 s. The cause of the first Docker failure is unknown;
the rerun confirmed Pectra's unstable SLA. These are unresolved verification results for the
previous warp, not issues fixed by moving directories. The threshold was not relaxed, and algorithms
were unchanged.

This rerun has a separate run ID, `bake-layout-warp-recheck`, in
[warp.json](../reports/profiles/pectra/default/warp.json). It does not replace the failed full-suite
verification. The final `bakes` check confirmed 9 artifacts: Gloas stable verified, Pectra default
unverified. After all runs, no containers with the `io.zap-net.id` label remained; formatting, lint,
types, and whitespace checks for the working tree and staging passed.

The full native build/`test:clock` was not repeated: native-input bytes were unchanged;
archiving/loading was checked separately. This report does not establish the future honest-warp
criteria in `warp-tdd-acceptance.md`: the current large jump still skips votes.

## Subsequent threshold change at the user's request

On 2026-09-30, the user approved **25 s** instead of 20 s for a jump including the next transaction.
Only the criterion, `budgetMs` in the report, and the shared warp test's error text changed. The
algorithm and functional checks were preserved. The earlier failed results above were not
reclassified.

Separate sequential `e2e:warp` runs after the change passed:

| Profile        | Run ID                  | Two jumps including the next tx | Entire scenario |
| -------------- | ----------------------- | ------------------------------- | --------------- |
| Pectra default | `warp-budget-25-pectra` | 18.385 / 17.613 s               | 155.085 s       |
| Gloas stable   | `warp-budget-25-gloas`  | 11.861 / 10.685 s               | 138.805 s       |

Both scenarios checked finality recovery, EL/CL agreement, absence of slashing, and the signing
history of all 64 validators. Docker 409 did not recur in these runs; its cause remains unknown.
`check` and 24 unit tests passed; 10 opt-in tests were skipped by the unit command.

Full `test:profile` runs were not repeated: changing the shared test changes the suite fingerprint,
so previous full verification records remain historical. The new `warp.json` files contain the
separate run IDs above, not the IDs of the old full runs.
