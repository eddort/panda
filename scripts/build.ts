import { Infrastructure } from "../src/docker.ts";
import { buildImages, images } from "../src/config.ts";
await import("./prepare_clients.ts");

const infra = new Infrastructure("build");
const root = Deno.cwd();
await Deno.mkdir(".cache/image", { recursive: true });
await infra.image(buildImages.rust);
const registry = await infra.volume("cargo");
const target = await infra.volume("target");
const t = performance.now();
const container = await infra.container("lighthouse", {
  Image: buildImages.rust,
  WorkingDir: "/source",
  Env: ["CARGO_TARGET_DIR=/target", "CARGO_BUILD_JOBS=2", "CARGO_NET_GIT_FETCH_WITH_CLI=true"],
  Cmd: [
    "sh",
    "-ec",
    "apt-get update && apt-get install -y --no-install-recommends cmake libclang-dev protobuf-compiler && cargo build --release --locked --bin lighthouse --features portable && cp /target/release/lighthouse /output/lighthouse",
  ],
  HostConfig: {
    Binds: [
      `${root}/.cache/upstream/lighthouse:/source`,
      `${root}/.cache/image:/output`,
      `${registry}:/usr/local/cargo`,
      `${target}:/target`,
    ],
    NanoCpus: 4e9,
  },
});
try {
  await container.start();
  console.log(JSON.stringify({ event: "build-start", container: container.id }));
  const stream = await container.logs({ follow: true, stdout: true, stderr: true });
  infra.docker.modem.demuxStream(
    stream,
    (await import("node:process")).stdout,
    (await import("node:process")).stderr,
  );
  const result = await container.wait();
  if (result.StatusCode !== 0) throw new Error(`Lighthouse build failed: ${result.StatusCode}`);
  await Deno.writeTextFile(
    ".cache/image/Dockerfile",
    `FROM ${buildImages.runtime}\nRUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*\nCOPY lighthouse /usr/local/bin/lighthouse\nENTRYPOINT ["lighthouse"]\n`,
  );
  const build = await infra.docker.buildImage({
    context: `${root}/.cache/image`,
    src: ["Dockerfile", "lighthouse"],
  }, { t: images.controlled });
  await new Promise<void>((resolve, reject) =>
    infra.docker.modem.followProgress(
      build,
      (error: Error | null) => error ? reject(error) : resolve(),
    )
  );
  const measurement = {
    event: "build-complete",
    elapsedMs: performance.now() - t,
    image: images.controlled,
    imageId: (await infra.docker.getImage(images.controlled).inspect()).Id,
    recordedAt: new Date().toISOString(),
    buildImages,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        ["clients/lighthouse.patch", "clients/controlled_clock.rs"].map(async (
          path,
        ) => [
          path,
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(path))),
          )
            .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        ]),
      ),
    ),
  };
  await Deno.mkdir("reports", { recursive: true });
  await Deno.writeTextFile("reports/build.json", JSON.stringify(measurement, null, 2));
  await Deno.writeTextFile(
    `reports/build-${Date.now()}.json`,
    JSON.stringify(measurement, null, 2),
  );
  console.log(JSON.stringify(measurement));
} finally {
  await container.remove({ force: true });
}
