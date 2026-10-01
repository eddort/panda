import { report as writeReport } from "./report.ts";
import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { depositValidator, send } from "./deposit_fixture.ts";
import { validator } from "./validators.ts";

const start = performance.now();
// Explicit non-mainnet churn quotient: at 64 validators, mainnet has zero consolidation capacity.
await using net = await Devnet.start({
  id: `protocol-${crypto.randomUUID().slice(0, 8)}`,
  churnLimitQuotient: 4,
  consolidationChurnLimitQuotient: 4,
});
const profile = (await net.status()).profile;
if (profile === "gloas") {
  const spec = await net.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec");
  assert.equal(spec.data.CONSOLIDATION_CHURN_LIMIT_QUOTIENT, "4");
}
await net.setAutomine(true);
const pubkey = await depositValidator(net, 64);
await net.setAutomine(false);
await net.advanceUntil(async () => {
  try {
    return (await validator(net, 64)).status === "active_ongoing";
  } catch (error) {
    if (String(error).includes("404")) return false;
    throw error;
  }
}, { maxSlots: 512, timeoutMs: 600_000 });
const activated = await validator(net, 64);
assert.equal(activated.validator.pubkey, pubkey);
const address = "0x0000BBdDc7CE488642fb579F8B00f3a590007251";
const consolidate = async (source: number, target: number) => {
  const from = await validator(net, source);
  const to = await validator(net, target);
  const fee = BigInt(await net.rpc<string>("eth_call", [{ to: address, data: "0x" }, "latest"]));
  return await send(net, address, from.validator.pubkey + to.validator.pubkey.slice(2), fee);
};
await net.setAutomine(true);
await consolidate(1, 1); // EIP-7251 switch from 0x01 to 0x02 credentials.
await net.setAutomine(false);
await net.advanceUntil(
  async () => (await validator(net, 1)).validator.withdrawal_credentials.startsWith("0x02"),
  { maxSlots: 4 },
);
await net.skipSlots(Math.max(0, 256 * 32 - (await net.status()).slot));
await net.setAutomine(true);
await consolidate(0, 1);
await net.setAutomine(false);
await net.advanceUntil(async () => (await validator(net, 0)).status === "active_exiting", {
  maxSlots: 4,
});
const source = await validator(net, 0);
assert.equal(source.status, "active_exiting");
const balanceBefore = BigInt((await validator(net, 1)).balance);
await net.skipSlots(
  Number(source.validator.withdrawable_epoch) * 32 - (await net.status()).slot - 1,
);
await net.advanceUntil(async () => (await validator(net, 0)).balance === "0", {
  maxSlots: 64,
  timeoutMs: 180_000,
});
assert(BigInt((await validator(net, 1)).balance) > balanceBefore + 16_000_000_000n);
const report = {
  event: "protocol-passed",
  elapsedMs: performance.now() - start,
  activated,
  source: await validator(net, 0),
  target: await validator(net, 1),
  status: await net.status(),
  churnLimitQuotient: 4,
  consolidationChurnLimitQuotient: profile === "gloas" ? 4 : undefined,
};
await writeReport(net, "protocol", report);
