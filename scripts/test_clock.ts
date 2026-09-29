import { buildImages } from "../src/config.ts";
import { Infrastructure } from "../src/docker.ts";
await import("./prepare_clients.ts");
const infra = new Infrastructure("build");
await infra.image(buildImages.rust);
const registry = await infra.volume("cargo");
const target = await infra.volume("target");
const container = await infra.container("clock-test", {
  Image: buildImages.rust,
  WorkingDir: "/source",
  Env: ["CARGO_TARGET_DIR=/target", "CARGO_BUILD_JOBS=2", "CARGO_NET_GIT_FETCH_WITH_CLI=true"],
  Cmd: [
    "sh",
    "-ec",
    "apt-get update && apt-get install -y --no-install-recommends cmake libclang-dev protobuf-compiler && cargo test --release --locked -p slot_clock --test controlled",
  ],
  HostConfig: {
    Binds: [
      `${Deno.cwd()}/.cache/upstream/lighthouse:/source`,
      `${registry}:/usr/local/cargo`,
      `${target}:/target`,
    ],
    NanoCpus: 4e9,
  },
});
try {
  await container.start();
  const stream = await container.logs({ follow: true, stdout: true, stderr: true });
  const process = await import("node:process");
  infra.docker.modem.demuxStream(stream, process.stdout, process.stderr);
  const status = await container.wait();
  if (status.StatusCode) throw new Error(`Clock regression failed: ${status.StatusCode}`);
} finally {
  await container.remove({ force: true });
}
