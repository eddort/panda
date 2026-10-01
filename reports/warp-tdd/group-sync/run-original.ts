import { Infrastructure } from "../../src/docker.ts";
import { readBake } from "../../src/profiles.ts";
import { requireImage, BuildLock } from "../../src/artifacts.ts";
import { resolve } from "node:path";

const mode = Deno.args[0] ?? "baseline";
if (!["baseline", "candidate"].includes(mode)) throw new Error("Unknown mode");
const bake = await readBake("gloas", "panda");
const cacheId = `bake-cache-${bake.builders.rust.id.slice(7, 23)}`;
await using lock = await BuildLock.acquire(`.cache/baker/locks/${cacheId}-batch.lock`);
const infra = new Infrastructure("warp-group-sync-proof");
const cacheInfra = new Infrastructure(cacheId);
const cache = await cacheInfra.volume("cl-cache");
const target = await cacheInfra.volume("cl-target");
await requireImage(infra, bake.builders.rust);
const container = await infra.container("probe", {
  Image: bake.builders.rust.id,
  WorkingDir: "/source",
  Env: ["CARGO_TARGET_DIR=/target/batch-proof", "CARGO_BUILD_JOBS=2", `PROBE_MODE=${mode}`],
  Cmd: ["sh", "-ec", 'test ! -e "$PROBE_MODE.json"; cargo test --release --locked --offline > "$PROBE_MODE-correctness.txt" 2>&1; cargo run --release --locked --offline -- --mode "$PROBE_MODE" > "$PROBE_MODE.json" 2> "$PROBE_MODE-stderr.txt"'],
  HostConfig: {
    Binds: [`${resolve(".cache/warp-native/group-sync-proof")}:/source`, `${cache}:/usr/local/cargo`, `${target}:/target`],
    NanoCpus: 2e9,
  },
});
try {
  await container.start();
  const result = await container.wait();
  console.log(JSON.stringify({ mode, exitCode: result.StatusCode, cpuLimit: 2, image: bake.builders.rust.id }));
  if (![0, 2].includes(result.StatusCode)) throw new Error("Probe build/test/harness failed; inspect saved output, not performance RED");
  const report = JSON.parse(await Deno.readTextFile(`.cache/warp-native/group-sync-proof/${mode}.json`));
  console.log(JSON.stringify({ componentGatePass: report.component_gate_pass, meanMs: report.mean_total_ms, p95Ms: report.p95_total_ms, coldCommitteeMs: report.committee_prepare_ms }));
} finally {
  const owned = await container.inspect();
  if (owned.Config.Labels?.["io.panda.id"] !== infra.id) throw new Error("Foreign probe container");
  await container.remove({ force: true, v: true });
}
