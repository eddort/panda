import assert from "node:assert/strict";
import { Devnet } from "../src/api.ts";
import { configuration } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { waitFor } from "../src/http.ts";
import { Network } from "../src/network.ts";

const id = `lifecycle-${crypto.randomUUID().slice(0, 8)}`;
const env = { ZAP_ID: id, ZAP_PORT: "0" };
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
    const endpoint = JSON.parse(await Deno.readTextFile(`.zap/${id}/controller.json`));
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
  };
  await Deno.mkdir("reports", { recursive: true });
  await Deno.writeTextFile("reports/lifecycle.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  try {
    await run("down");
  } catch {
    child?.kill("SIGTERM");
  }
  await output;
  await infra.cleanup();
}
