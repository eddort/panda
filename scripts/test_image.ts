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
const ports = [8545, 5052, 5062];
const container = await infra.container("service", {
  Image: image,
  ExposedPorts: Object.fromEntries(ports.map((port) => [`${port}/tcp`, {}])),
  HostConfig: {
    Privileged: true,
    PortBindings: Object.fromEntries(ports.map((port) => [
      `${port}/tcp`,
      [{ HostIp: "127.0.0.1", HostPort: "" }],
    ])),
  },
});
let provider: JsonRpcProvider | undefined;
const started = performance.now();
const evidence: Record<string, unknown> = { image, profile, id, passed: false };
async function saveClientLogs(): Promise<void> {
  await Deno.mkdir(".cache/container-reports", { recursive: true });
  const errors: unknown[] = [];
  for (const role of ["el", "cl", "vc"]) {
    try {
      const logs = await infra.exec(container, ["panda", "logs", role, "--tail", "2000"]);
      assert.ok(logs.trim().length > 0, `Missing ${role} logs`);
      await Deno.writeTextFile(`.cache/container-reports/${profile}-${id}-${role}.log`, logs);
    } catch (error) {
      errors.push(new Error(`${role} logs: ${error}`));
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
}
try {
  await container.start();
  const running = await container.inspect();
  evidence.imageId = running.Image;
  const endpoint = (port: number) =>
    `http://127.0.0.1:${running.NetworkSettings.Ports[`${port}/tcp`]![0].HostPort}`;
  const url = endpoint(8545);
  const beacon = endpoint(5052);
  const validator = endpoint(5062);
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
  assert.deepEqual(
    await json(`${beacon}/eth/v1/beacon/genesis`),
    await json(`${url}/eth/v1/beacon/genesis`),
  );
  for (const [token, expected] of [[undefined, 401], ["invalid-token", 403]] as const) {
    const denied = await fetch(`${validator}/eth/v1/keystores`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(denied.status, expected);
    await denied.body?.cancel();
  }
  const token = (await infra.exec(container, ["panda", "validator-token"])).trim();
  assert.ok(token.length > 16, "Missing VC token");
  const keys = () =>
    json<{ data: { validating_pubkey: string }[] }>(
      `${validator}/eth/v1/keystores`,
      { headers: { authorization: `Bearer ${token}`, connection: "close" } },
    );
  const publicKeys = async () => (await keys()).data.map((key) => key.validating_pubkey).sort();
  const validators = await publicKeys();
  assert.ok(validators.length > 0, "Native VC API must expose the actual genesis validators");
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
  // Fast mode replaces VC and its internal port; the public port and token must still work.
  await net.advanceTime(64 * 12, { mode: "fast" });
  assert.deepEqual(await publicKeys(), validators);
  const final = await net.status();
  assert.equal(final.slot, paused.slot + 64);
  const head = await json<{ data: { header: { message: { slot: string } } } }>(
    `${beacon}/eth/v1/beacon/headers/head`,
  );
  assert.equal(Number(head.data.header.message.slot), final.slot);
  evidence.final = final;
  evidence.clientAccess = { beacon: true, validator: true, validatorAfterFastWarp: true };
  await saveClientLogs();
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
  await saveClientLogs().catch((logsError) => evidence.logsError = String(logsError));
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
