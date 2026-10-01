import { Devnet } from "../../src/api.ts";
import { Consensus } from "../../src/consensus.ts";
import { Infrastructure, LABEL } from "../../src/docker.ts";
import { Network } from "../../src/network.ts";
import { EngineGate } from "../../src/engine.ts";

const timings: Record<string, number[]> = {};
let measuring = false;
// Diagnostic wrapper only: waiting still executes the unchanged readiness implementation.
const waitPayload = Reflect.get(EngineGate.prototype, "waitPayload");
Reflect.set(EngineGate.prototype, "waitPayload", async function (this: EngineGate, id: string) {
  const start = performance.now();
  try {
    return await Reflect.apply(waitPayload, this, [id]);
  } finally {
    if (measuring) (timings.enginePayloadWait ??= []).push(performance.now() - start);
  }
});
for (const name of ["move", "mark", "clock", "consistency"] as const) {
  const original = Consensus.prototype[name];
  Object.defineProperty(Consensus.prototype, name, {
    value: async function (this: Consensus, ...args: unknown[]) {
      const started = performance.now();
      try {
        return await Reflect.apply(original, this, args);
      } finally {
        if (measuring) {
          const key = name === "move" ? `phase:${args[1]}` : name;
          (timings[key] ??= []).push(performance.now() - started);
        }
      }
    },
  });
}
await using net = await Devnet.start({
  id: `critical-${crypto.randomUUID().slice(0, 8)}`,
});
const initial = await net.status();
const m = await Network.manifest(initial.id);
const infra = new Infrastructure(initial.id);
const info = await infra.docker.info();
const other = (await infra.docker.listContainers()).filter((c) =>
  c.Labels[LABEL] !== initial.id
).map((c) => ({ names: c.Names, id: c.Id }));
await net.advanceSlots(64);
const before = await net.status();
const started = performance.now();
measuring = true;
await net.advanceTime(32 * 12);
measuring = false;
const elapsedMs = performance.now() - started;
const after = await net.status();
const report = {
  profile: m.config.profile,
  bake: m.bake.tag,
  bakeKey: m.bake.key,
  host: Deno.build,
  cpu: info.NCPU,
  memoryBytes: info.MemTotal,
  other,
  slots: 32,
  elapsedMs,
  before,
  after,
  timings,
  recordedAt: new Date().toISOString(),
};
await Deno.writeTextFile(
  Deno.args[0] ?? `reports/warp-tdd/critical-path-${m.config.profile}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
for (const [key, values] of Object.entries(timings)) {
  console.log(key, {
    count: values.length,
    totalMs: values.reduce((s, n) => s + n, 0),
    meanMs: values.reduce((s, n) => s + n, 0) / values.length,
  });
}
console.log({ slots: 32, elapsedMs });
