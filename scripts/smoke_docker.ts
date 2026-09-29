import { Infrastructure, LABEL } from "../src/docker.ts";

const infra = new Infrastructure(`smoke-${crypto.randomUUID().slice(0, 8)}`);
const started = performance.now();
let events: Awaited<ReturnType<typeof infra.docker.getEvents>> | undefined;
try {
  const version = await infra.docker.version();
  await infra.image("alpine:3.21.3");
  events = await infra.docker.getEvents({ filters: { label: [`${LABEL}=${infra.id}`] } });
  let sawStart = false;
  events.on("data", (data) => {
    if (data.toString().includes('"Action":"start"')) sawStart = true;
  });
  const network = await infra.network();
  const volume = await infra.volume("data");
  const container = await infra.container("smoke", {
    Image: "alpine:3.21.3",
    Cmd: ["sh", "-c", "echo smoke-started; sleep 120"],
    HostConfig: { NetworkMode: network, Binds: [`${volume}:/data`] },
  });
  await container.start();
  const result = await infra.exec(container, [
    "sh",
    "-c",
    "echo smoke-exec > /data/probe; cat /data/probe",
  ]);
  const logs = await infra.logs(container);
  if (!result.includes("smoke-exec") || !logs.includes("smoke-started")) {
    throw new Error("I/O failed");
  }
  await container.stop({ t: 1 });
  if (!sawStart) throw new Error("Docker start event was not observed");
  console.log(
    JSON.stringify({
      test: "docker-smoke",
      deno: Deno.version.deno,
      docker: version.Version,
      architecture: Deno.build.arch,
      elapsedMs: performance.now() - started,
      logs: logs.trim(),
      exec: result.trim(),
      events: sawStart,
    }),
  );
} finally {
  (events as import("node:stream").Readable | undefined)?.destroy();
  await infra.cleanup();
  await infra.cleanup();
}
