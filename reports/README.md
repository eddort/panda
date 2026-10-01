# Verification reports

Keep structured results, bake identities, measurements and concise verification summaries in Git.
`profiles/<hardfork>/<tag>/` contains the raw profile reports required by `AGENTS.md`; verification
binds the bake key and suite fingerprint.

Console output (`*.log` and numbered rotations) is ignored by default. CI event streams
(`ci/**/*.jsonl`) are also ignored. Keep these locally or as Actions artifacts. Historical CI
summaries retain the actual commands and results; any mentioned console filenames refer to local or
CI artifacts, not tracked files.

Raw logs under `profiles/`, `warp-tdd/` and `warp-modes/` remain eligible for Git because they
preserve protocol regressions, measurements and red/green evidence alongside their reports. JSON
results, source/transaction manifests, patches and text measurements remain tracked.

Before publishing reports, remove personal home paths and unrelated Docker container names/IDs.
Historical console logs use `/workspace/panda` in place of the original checkout path. Unrelated
workload entries are redacted while retaining their count. These are privacy edits, not new runs:
measurements, bake identities and pass/fail outcomes are unchanged. Profile verification JSON and
immutable bake manifests are retained byte-for-byte. Original private copies stay outside Git.

External pilot deployment dumps, workstation inventories and session handoff notes remain local.
They are not part of the public source snapshot.
