import assert from "node:assert/strict";
import { request } from "node:http";
import { JsonRpcProvider, Wallet } from "ethers";
import { Devnet } from "../src/api.ts";
import { privateKey } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { delay, json, waitFor } from "../src/http.ts";
import { atomicJson } from "../src/artifacts.ts";

const [image, profile] = Deno.args;
if (!image || !profile) throw new Error("Usage: test_image.ts <image> <profile>");
const id = `image-${crypto.randomUUID().slice(0, 8)}`;
const infra = new Infrastructure(id);
const container = await infra.container("service", {
  Image: image,
  ExposedPorts: { "8545/tcp": {} },
  HostConfig: {
    Privileged: true,
    PortBindings: { "8545/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
  },
});
let provider: JsonRpcProvider | undefined;
const started = performance.now();
const evidence: Record<string, unknown> = { image, profile, id, passed: false };
try {
  await container.start();
  const running = await container.inspect();
  evidence.imageId = running.Image;
  const port = running.NetworkSettings.Ports["8545/tcp"]![0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  const net = new Devnet(url);
  const ready = async () => {
    const deadline = performance.now() + 300_000;
    while (performance.now() < deadline) {
      if (!(await container.inspect()).State.Running) {
        throw new Error("Service exited during startup");
      }
      const status = await net.status().catch(() => undefined);
      if (status) return status;
      await delay(250);
    }
    throw new Error("Packaged Panda readiness timed out");
  };
  const initial = await ready();
  assert.equal(initial.profile, profile);
  assert.equal(BigInt(initial.el.number), 0n);
  assert.equal(initial.slot, 0);
  assert.equal(initial.automine, false);
  evidence.initial = initial;
  // Exercise the real health command repeatedly: a readiness probe must never mine.
  for (let i = 0; i < 2; i++) {
    await infra.exec(container, [
      "deno",
      "run",
      "--config=deno.runtime.json",
      "--cached-only",
      "-A",
      "container/health.ts",
    ]);
  }
  assert.equal((await net.status()).el.hash, initial.el.hash);
  assert.equal((await net.status()).slot, 0);
  await json(`${url}/eth/v1/beacon/genesis`);
  // fetch normalizes Host; use an HTTP request that can send an actual foreign Host.
  const denied = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/control`, {
      method: "POST",
      headers: { host: "external.example", connection: "close" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode!));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Host probe timed out")));
    req.end(JSON.stringify({ method: "status" }));
  });
  assert.equal(denied, 403);
  assert.equal(
    (await infra.docker.listContainers({ filters: { label: [`${LABEL}=${initial.id}`] } })).length,
    0,
    "Inner clients must not be created on the host daemon",
  );
  await net.advanceSlots(1);
  await net.setAutomine(true);
  provider = new JsonRpcProvider(url);
  const tx = await new Wallet(privateKey, provider).sendTransaction({
    to: "0x0000000000000000000000000000000000000001",
    value: 1n,
  });
  const receipt = await waitFor(
    "packaged transaction",
    async () => (await provider!.getTransactionReceipt(tx.hash)) ?? undefined,
    60_000,
  );
  assert.equal(receipt.status, 1);
  await net.setAutomine(false);
  const paused = await net.status();
  await delay(1000);
  assert.equal((await net.status()).el.hash, paused.el.hash);
  evidence.transaction = tx.hash;
  evidence.final = paused;
  provider.destroy();
  provider = undefined;
  // GitHub Actions stops service containers with SIGTERM.
  await container.stop({ t: 120 });
  const stopped = await waitFor("packaged graceful shutdown", async () => {
    const state = (await container.inspect()).State;
    return state.Running ? undefined : state;
  }, 90_000);
  assert.equal(stopped.ExitCode, 0);
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  provider?.destroy();
  evidence.elapsedMs = performance.now() - started;
  try {
    await Deno.mkdir(".cache/container-reports", { recursive: true });
    await Deno.writeTextFile(
      `.cache/container-reports/${profile}-${id}.log`,
      await infra.logs(container),
    );
    await atomicJson(`.cache/container-reports/${profile}-${id}.json`, evidence);
  } finally {
    await infra.cleanup();
  }
}
console.log(JSON.stringify(evidence));
