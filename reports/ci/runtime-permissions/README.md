# Non-root runtime file ownership

Console logs mentioned below are local or CI artifacts, not versioned files. See the
[report retention policy](../../README.md).

The supplied Linux CI log failed on `metadata/bootstrap_nodes.txt` after genesis generation. Eight
profile scenarios reported the same permission error; CLI lifecycle timed out before readiness. The
genesis and VC containers did not select a user, leaving bind-mounted output owned by root while the
GitHub runner controller was non-root. VC's private API token and newly generated deposit keys had
the same exposure to this ownership mismatch.

## Acceptance and implementation

- Genesis and VC use the controller's numeric UID/GID for both hardforks.
- Fast VC replacement preserves the inspected container user, including a non-root UID/GID and
  `0:0`.
- Deposit-key generation uses the controller's numeric UID/GID before the host reads private keys.
- Private file modes are not relaxed. Docker labels and scoped cleanup are unchanged.
- Native Lighthouse build inputs are unchanged; this controller fix does not require a new CL image.

The existing profile suite exercises real genesis, CLI reset, validator import/exit and
signing-history access after fast restarts. These integration scenarios must pass on the non-root
Linux CI runner before treating the filesystem/client compatibility as verified.

## Executed checks

`./scripts/deno test -A tests/network_permissions_test.ts`:

- Before implementation: **0 passed, 5 failed**, each from a missing Docker `User` field. See
  `red.log`.
- After implementation: **5 passed, 0 failed**. See `green.log`.

These are Docker/HTTP adapter fixtures exercising the real startup, replacement and deposit fixture
code. They do not run a daemon, emulate Linux UID permissions or certify real client compatibility.

`./scripts/deno task check`: passed formatting, lint and type checks. See `check.log`.

`./scripts/deno task test`: **85 passed, 0 failed, 13 ignored**. See `unit.log`.

Docker smoke, profile suites and the original CI reproduction were **not executed locally**, at the
user's request. No Docker commands or containers were started for this change.
