import { Devnet } from "../src/api.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { diskUsage, sampleResources } from "../src/profile.ts";

const infra = new Infrastructure("measure");
const info = await infra.docker.info();
const foreign = (await infra.docker.listContainers()).filter((c) => !c.Labels[LABEL]).length;
const runs = [];
for (let run = 0; run < 2; run++) {
  const started = performance.now();
  await using net = await Devnet.start({ id: "measure" });
  const readyMs = performance.now() - started;
  await net.stepSlot();
  const firstBlockMs = performance.now() - started;
  await net.advanceSlots(31);
  const paused = await sampleResources("measure", 5000, net.url);
  const advancing = performance.now();
  const [_, load] = await Promise.all([
    net.advanceSlots(128),
    sampleResources("measure", 5000, net.url),
  ]);
  const advanceMs = performance.now() - advancing;
  runs.push({
    run,
    readyMs,
    firstBlockMs,
    paused,
    load,
    slots: 128,
    advanceMs,
    slotsPerSecond: 128000 / advanceMs,
    protocolSecondsPerSecond: 1536000 / advanceMs,
    disk: await diskUsage("measure"),
    head: (await net.status()).el,
  });
  console.log(JSON.stringify({ event: "measurement-run", ...runs.at(-1) }));
}
const report = {
  recordedAt: new Date().toISOString(),
  environment: {
    host: Deno.build,
    engine: info.ServerVersion,
    dockerCpus: info.NCPU,
    dockerMemoryBytes: info.MemTotal,
    otherRunningContainers: foreign,
  },
  cache: "Images and build cached; each run regenerates genesis and starts empty EL/CL volumes.",
  runs,
};
await Deno.mkdir("reports", { recursive: true });
await Deno.writeTextFile("reports/controlled.json", JSON.stringify(report, null, 2));
