import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { configuration } from "../../../src/config.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { waitFor } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { profileReport } from "./report.ts";
import { readBake } from "../../../src/profiles.ts";

const id = `lifecycle-${crypto.randomUUID().slice(0, 8)}`;
const env = { PANDA_ID: id, PANDA_PORT: "0" };
const infra = new Infrastructure(id);
const command = (task: string) =>
  new Deno.Command(Deno.execPath(), {
    args: ["task", task],
    env,
    stdout: "piped",
    stderr: "piped",
  });
let child: Deno.ChildProcess | undefined;
let output: Promise<Deno.CommandOutput> | undefined;
const start = async (task: string) => {
  child = command(task).spawn();
  output = child.output();
  return await waitFor("CLI ready", async () => {
    const endpoint = JSON.parse(await Deno.readTextFile(`.panda/${id}/controller.json`));
    const net = new Devnet(endpoint.url);
    return (await net.status()).id === id ? net : undefined;
  }, 120_000);
};
const run = async (task: string) => {
  const result = await command(task).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
};
const empty = async () => {
  const filters = { label: [`${LABEL}=${id}`] };
  assert.equal((await infra.docker.listContainers({ all: true, filters })).length, 0);
  assert.equal((await infra.docker.listNetworks({ filters })).length, 0);
  assert.equal((await infra.docker.listVolumes({ filters })).Volumes?.length ?? 0, 0);
};
const started = performance.now();
try {
  const first = await start("up");
  const genesis = (await first.status()).el.hash;
  assert((await run("up")).includes("already-running"));
  const running = await first.status();
  const incompatible = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config=deno.runtime.json",
      "-A",
      "src/cli.ts",
      "up",
      "--profile",
      running.profile === "pectra" ? "gloas" : "pectra",
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(!incompatible.success);
  assert(new TextDecoder().decode(incompatible.stderr).includes("requested"));
  await assert.rejects(new Network(configuration({ id })).start(), /owned by live process/);
  await first.stepSlot();
  await run("down");
  assert((await output!).success);
  await empty();
  await run("down");
  const second = await start("reset");
  assert.equal((await second.status()).el.hash, genesis, "genesis changed on reset");
  assert.equal((await second.status()).slot, 0);
  await second.stepSlot();
  await run("down");
  assert((await output!).success);
  await empty();
  const report = {
    event: "lifecycle-passed",
    elapsedMs: performance.now() - started,
    repeatedUp: true,
    repeatedDown: true,
    resetGenesis: genesis,
    duplicateOwnerRejected: true,
    differentProfileRejected: true,
  };
  const config = configuration();
  const bake = await readBake(config.profile, config.bake);
  await profileReport({ ...config, bakeKey: bake.key }, "lifecycle", report);
} finally {
  try {
    await run("down");
  } catch {
    child?.kill("SIGTERM");
  }
  await output;
  await infra.cleanup();
}
