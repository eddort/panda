# Shared public hash: isolated signing experiment

2026-09-30, pinned blst 0.3.17, Linux ARM64, 2 CPU. No client changes. Baseline ran before candidate
implementation; 4 baseline and 7 combined correctness tests passed. Both performance runs exited 2:
**the mean/p95 <=1 ms component gate remains RED**.

| 64 keys, changing roots, mean | Ordinary SK.sign | One public hash per batch |
| ----------------------------- | ---------------: | ------------------------: |
| Serial                        |        19.929 ms |                 10.855 ms |
| Persistent one worker         |        20.234 ms |                 10.731 ms |
| Persistent two workers        |        14.081 ms |                  5.508 ms |

Candidate p95 for two workers was 5.634 ms. Eight samples per case are a short component probe, not
a network latency guarantee. The standard threadpool is a scheduling surrogate for VC's Rayon/Tokio.
A VC detecting two CPUs currently configures only one high-priority Rayon worker; runtime VC CPU
detection was not measured here. Repeated-root diagnostic cases are in raw JSON, but sequential
blocks have changing roots.

Each candidate call hashes the complete root/DST/augmentation once, then performs the exact same
secret multiplication primitive as ordinary SK.sign for every current caller-owned key. There is no
persistent public cache, secret cache or secret aggregation. Hashing, signing, serialization and job
submission/collection are timed. Key setup is excluded. Every measured signature is verified by the
unchanged BLS API after timing. Byte equality, mixed concurrent contexts and key release/replacement
have separate tests. The candidate still makes 64 secret multiplications.

Sources and exact dependency locks are in baseline-source/ and candidate-source/. Both results,
correctness logs, compiler stderr, source hashes and detailed probe boundaries are retained.

From the repository root, with no concurrent resource measurement:

```sh
./scripts/deno run -A reports/warp-tdd/shared-hash/run.ts baseline
./scripts/deno run -A reports/warp-tdd/shared-hash/run.ts candidate
```

The reproduction runner writes into ignored .cache/warp-native/reproduce-shared-hash-<mode>/,
refuses to replace existing results and removes only its exact labelled container. It uses the saved
sources and recorded builder image at 2 CPU. run-original.ts preserves the original script as run
from .cache/warp-native/; its imports refer to that original location. No full warp, validator
lifecycle, slashing history, finality or transaction was tested by this probe.
