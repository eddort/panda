import { Infrastructure } from "../../../src/docker.ts";
import { readBake } from "../../../src/profiles.ts";
import { BuildLock, requireImage } from "../../../src/artifacts.ts";
import { resolve } from "node:path";

const mode = Deno.args[0] ?? "baseline";
const shape = Deno.args[1] ?? "four";
if (!["baseline", "candidate"].includes(mode)) throw new Error("Unknown mode");
if (!["four", "full"].includes(shape)) throw new Error("Unknown shape");
const archiveName = shape === "full" ? `full-${mode}` : mode;
const bake = await readBake("gloas", "panda");
if (
  bake.builders.rust.id !==
    "sha256:9ad0c47880881464036f8b5779f49a15d058154581404d0d50a20f9d11f3436e"
) {
  throw new Error("Pinned Rust builder changed; preserve the recorded environment for comparison");
}
const cacheId = `bake-cache-${bake.builders.rust.id.slice(7, 23)}`;
await using lock = await BuildLock.acquire(`.cache/baker/locks/${cacheId}-batch.lock`);
const infra = new Infrastructure(`warp-group-sync-${shape}-proof`);
const cacheInfra = new Infrastructure(cacheId);
const cache = await cacheInfra.volume("cl-cache");
const target = await cacheInfra.volume("cl-target");
await requireImage(infra, bake.builders.rust);
const source = resolve(`reports/warp-tdd/group-sync/${archiveName}-source`);
const output = resolve(`.cache/warp-native/reproduce-group-sync-${shape}-${mode}`);
await Deno.mkdir(resolve(".cache/warp-native"), { recursive: true });
await Deno.mkdir(output);
await Deno.mkdir(`${output}/src`);
for (const file of ["Cargo.toml", "Cargo.lock", "src/lib.rs", "src/main.rs"]) {
  await Deno.copyFile(`${source}/${file}`, `${output}/${file}`);
}
const command = shape === "full"
  ? 'cargo run --release --locked --offline -- --mode "$PROBE_MODE" --shape full'
  : 'cargo run --release --locked --offline -- --mode "$PROBE_MODE"';
const container = await infra.container("probe", {
  Image: bake.builders.rust.id,
  WorkingDir: "/source",
  Env: ["CARGO_TARGET_DIR=/target/batch-proof", "CARGO_BUILD_JOBS=2", `PROBE_MODE=${mode}`],
  Cmd: [
    "sh",
    "-ec",
    `cargo test --release --locked --offline > correctness.txt 2>&1; ${command} > result.json 2> stderr.txt`,
  ],
  HostConfig: {
    Binds: [`${output}:/source`, `${cache}:/usr/local/cargo`, `${target}:/target`],
    NanoCpus: 2e9,
  },
});
try {
  await container.start();
  const result = await container.wait();
  console.log(
    JSON.stringify({
      mode,
      shape,
      exitCode: result.StatusCode,
      cpuLimit: 2,
      image: bake.builders.rust.id,
    }),
  );
  if (![0, 2].includes(result.StatusCode)) {
    throw new Error("Probe build/test/harness failed; inspect saved output, not performance RED");
  }
  const report = JSON.parse(await Deno.readTextFile(`${output}/result.json`));
  console.log(
    JSON.stringify({
      componentGatePass: report.component_gate_pass,
      meanMs: report.mean_total_ms,
      p95Ms: report.p95_total_ms,
      coldCommitteeMs: report.committee_prepare_ms,
    }),
  );
} finally {
  const owned = await container.inspect();
  if (owned.Config.Labels?.["io.panda.id"] !== infra.id) throw new Error("Foreign probe container");
  await container.remove({ force: true, v: true });
}
