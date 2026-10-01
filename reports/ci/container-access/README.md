# Container client API and log access

Console logs mentioned below are local or CI artifacts, not versioned files. See the
[report retention policy](../../README.md).

Local verification on 2026-10-01. No Docker daemon, client build, devnet or packaged image test was
started for this change.

Acceptance criteria:

- Expose native Beacon API on 5052 and authenticated VC API on 5062 alongside Panda on 8545.
- Preserve request bodies, bearer headers, controller Host/Origin checks and streaming responses.
- Resolve the current VC endpoint after its replacement during a fast warp; close active relay
  connections on service shutdown.
- Read each client's stdout/stderr using exact `io.panda.id` and role, with tail and follow modes.
- Retrieve the VC token explicitly through `docker exec`, without adding it to readiness logs.
- Capture EL/CL/VC logs separately in the packaged smoke check.

Executed checks:

- TDD red: four regression cases failed against unimplemented relay/log access (`red.log`).
- Focused green: five local HTTP/transport/CLI checks passed (`green.log`). Docker log streams are
  fixtures, so this establishes demultiplexing and selection behavior, not live Docker
  compatibility.
- `./scripts/deno task check`: passed formatting, lint and types (`check.log`).
- `PANDA_DOCKER_TEST=0 PANDA_E2E=0 ./scripts/deno task test`: 72 passed, zero failed, 13 opt-ins
  ignored (`unit.log`).
- `actionlint`: all three Panda workflows passed (`actionlint.log`).
- `sh -n container/panda`: passed.

`scripts/test_image.ts` now checks real native Beacon/VC access, missing/invalid tokens, a 64-slot
fast warp followed by authenticated access through the same external VC port, and nonempty logs from
all three clients. CI runs it for each packaged profile before publication. These new real client
scenarios and the installed container command remain unverified locally, per the request not to run
Docker tests. The HTTP fixture includes streaming data but does not certify a long-lived
subscription to a real Beacon node.

Log files preserve command output with trailing whitespace removed.
