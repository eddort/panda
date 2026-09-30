import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { executionAt, finalizedExecutionHash } from "../../../src/consensus.ts";
import { Infrastructure, LABEL, ROLE } from "../../../src/docker.ts";
import { Network } from "../../../src/network.ts";
import { delay } from "../../../src/http.ts";
import { report } from "./report.ts";
import type { ValidatorRecord } from "./validators.ts";
import { assertSigningHistory, type SigningHistory } from "./warp_assertions.ts";

const started = performance.now();
await using net = await Devnet.start({ id: `warp-${crypto.randomUUID().slice(0, 8)}` });
const initial = await net.status();
const manifest = await Network.manifest(initial.id);
const infra = new Infrastructure(initial.id);
const docker = await infra.docker.info();
const beaconContainer = await infra.docker.getContainer(`zap-${initial.id}-bn`).inspect();
const environment = {
  architecture: docker.Architecture,
  dockerVersion: docker.ServerVersion,
  dockerCpus: docker.NCPU,
  dockerMemoryBytes: docker.MemTotal,
  beaconCpuLimit: (beaconContainer.HostConfig.NanoCpus ?? 0) / 1e9,
  beaconHierarchy:
    beaconContainer.Config.Cmd?.find((arg) => arg.startsWith("--hierarchy-exponents=")) ??
      "upstream default",
  validators: manifest.config.validators,
  otherContainers:
    (await infra.docker.listContainers()).filter((c) => c.Labels[LABEL] !== initial.id).length,
};
const wallet = new Wallet(privateKey);
const records = async () =>
  (await net.beacon<{ data: ValidatorRecord[] }>("/eth/v1/beacon/states/head/validators")).data;
const allUnslashed = async () => {
  const validators = await records();
  assert.equal(validators.length, manifest.config.validators);
  assert(
    validators.every((v) => !v.validator.slashed),
    "A validator was slashed after time travel",
  );
  assert(
    validators.every((v) => v.status === "active_ongoing"),
    "Time travel unexpectedly ejected a validator",
  );
  return validators;
};
const exportHistory = async (): Promise<SigningHistory> => {
  const containers = await infra.docker.listContainers({
    filters: { label: [`${LABEL}=${initial.id}`, `${ROLE}=vc`] },
  });
  assert.equal(containers.length, 1);
  const vc = infra.docker.getContainer(containers[0].Id);
  assert.equal((await vc.inspect()).Config.Labels?.[LABEL], initial.id);
  // Lighthouse holds an exclusive SQLite lock. Freeze the owned VC briefly and
  // copy the database plus journal files; export from the copy, preserving live protection.
  const snapshot = `${manifest.directory}/warp-slashing-snapshot`;
  await Deno.mkdir(snapshot, { recursive: true });
  await vc.pause();
  try {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const name = `slashing_protection.sqlite${suffix}`;
      await Deno.remove(`${snapshot}/${name}`).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.copyFile(
        `${manifest.directory}/validator-keys/keys/${name}`,
        `${snapshot}/${name}`,
      ).catch((error) => {
        if (suffix === "" || !(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  } finally {
    await vc.unpause();
  }
  await infra.exec(vc, [
    "env",
    "-u",
    "ZAP_CLOCK_START_MS",
    "-u",
    "ZAP_CLOCK_PORT",
    "lighthouse",
    "--testnet-dir=/shared/metadata",
    "account",
    "validator",
    "--validators-dir=/shared/warp-slashing-snapshot",
    "slashing-protection",
    "export",
    "/shared/warp-signing-history.json",
  ]);
  return JSON.parse(await Deno.readTextFile(`${manifest.directory}/warp-signing-history.json`));
};
await net.advanceUntil(
  async () => Number((await net.status()).finality.data.finalized.epoch) >= 2,
  { maxSlots: 160 },
);
await allUnslashed();
const beforeHistory = await exportHistory();
assert.equal(beforeHistory.data.length, manifest.config.validators);
assertSigningHistory(beforeHistory);
let previousHistory = beforeHistory;
const samples = [];
// Mainnet withdrawal delay (8192 slots) and a second jump across a committee period.
for (const [index, slots] of [8192, 8192].entries()) {
  const before = await net.status();
  const target = before.now + slots * 12;
  const start = performance.now();
  if (index === 0) await net.advanceTime(slots * 12);
  else await net.advanceTo(new Date(target * 1000));
  const advanceMs = performance.now() - start;
  const advanced = await net.status();
  assert.equal(advanced.now, target);
  assert.equal(advanced.slot, before.slot + slots);
  assert.notEqual(advanced.el.hash, before.el.hash);
  assert.equal(
    Number(BigInt(advanced.el.timestamp)),
    manifest.config.genesisTime + advanced.slot * 12,
  );
  assert.equal((await executionAt(manifest, "head")).block_hash, advanced.el.hash);
  await net.setAutomine(true);
  const nonce = Number(
    BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"])),
  );
  const signed = await wallet.signTransaction({
    chainId: 1337,
    nonce,
    to: account,
    value: 1n,
    gasLimit: 1_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: 2,
  });
  const hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
  const receipt = await net.waitForService(
    "transaction after warp",
    async () =>
      (await net.rpc<{ status: string; blockHash: string } | null>("eth_getTransactionReceipt", [
        hash,
      ])) ?? undefined,
    10_000,
  );
  assert.equal(receipt.status, "0x1");
  await net.setAutomine(false);
  const readyMs = performance.now() - start;
  const after = await net.status();
  assert.equal(after.el.hash, receipt.blockHash);
  await allUnslashed();
  // Skipped states must be accessible while unfinalized. Lighthouse prunes history later.
  const skipped = await net.beacon<{ data: { root: string } }>(
    `/eth/v1/beacon/states/${advanced.slot - 64}/root`,
  );
  assert.match(skipped.data.root, /^0x[0-9a-f]{64}$/);
  assert.equal(
    (await net.beacon<{ data: ValidatorRecord[] }>(
      `/eth/v1/beacon/states/${skipped.data.root}/validators`,
    )).data.length,
    manifest.config.validators,
  );
  const head = await net.beacon("/eth/v1/beacon/headers/head");
  await delay(250);
  assert.deepEqual(await net.beacon("/eth/v1/beacon/headers/head"), head);
  assert.equal((await net.status()).el.hash, after.el.hash);
  samples.push({
    advanceMs,
    slots,
    readyMs,
    targetSlot: advanced.slot,
    receipt,
    finalizedBefore: before.finality.data.finalized,
  });
  console.log(JSON.stringify({ event: "warp-sample", ...samples.at(-1) }));
  // Real new finality must reach a checkpoint after the jump, not merely stay nonzero.
  await net.advanceUntil(
    async () =>
      Number((await net.status()).finality.data.finalized.epoch) >= Math.floor(advanced.slot / 32),
    { maxSlots: 160 },
  );
  const cl = await finalizedExecutionHash(manifest);
  assert.equal(
    (await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
    cl,
  );
  assert.equal(
    (await net.beacon<{ data: ValidatorRecord[] }>(
      "/eth/v1/beacon/states/finalized/validators",
    )).data.length,
    manifest.config.validators,
  );
  const history = await exportHistory();
  assertSigningHistory(history, previousHistory, advanced.slot);
  previousHistory = history;
}
const validators = await allUnslashed();
const afterHistory = previousHistory;
assert.deepEqual(
  afterHistory.data.map((v) => v.pubkey.toLowerCase()).sort(),
  validators.map((v) => v.validator.pubkey.toLowerCase()).sort(),
);
assertSigningHistory(afterHistory, beforeHistory, samples.at(-1)!.targetSlot);
await report(net, "warp", {
  event: "warp-measured",
  passed: samples.every((sample) => sample.readyMs < 25_000),
  budgetMs: 25_000,
  environment,
  elapsedMs: performance.now() - started,
  samples,
  validators: validators.map((v) => ({
    index: v.index,
    slashed: v.validator.slashed,
    balance: v.balance,
    status: v.status,
  })),
  signedValidators: afterHistory.data.length,
  status: await net.status(),
});
// Includes the real destination block and receipt, so deferred work cannot hide behind the API.
assert(
  samples.every((sample) => sample.readyMs < 25_000),
  "Time travel exceeded 25 seconds including the next transaction",
);
