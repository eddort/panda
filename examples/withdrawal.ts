import { report as writeReport } from "./report.ts";
import assert from "node:assert/strict";
import { Devnet } from "../src/api.ts";
import { exitValidator, validator } from "./validators.ts";

const start = performance.now();
await using net = await Devnet.start({ id: `withdrawal-${crypto.randomUUID().slice(0, 8)}` });
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 2n,
  { maxSlots: 160 },
);
// Explicit skipped slots test time-dependent eligibility with unchanged mainnet delays.
// This deliberately incurs missed duties and inactivity penalties.
const beforeSkip = await net.status();
await net.skipSlots(256 * 32 - beforeSkip.slot);
assert.equal((await net.status()).el.hash, beforeSkip.el.hash, "skip produced a block");
await net.stepSlot();
await exitValidator(net, 0);
await net.stepSlot();
const exiting = await validator(net, 0);
assert.equal(exiting.status, "active_exiting");
const withdrawable = Number(exiting.validator.withdrawable_epoch);
assert(withdrawable >= Number(exiting.validator.exit_epoch) + 256);
await net.skipSlots(withdrawable * 32 - (await net.status()).slot - 1);
let withdrawal: unknown;
await net.advanceUntil(async () => {
  const block = await net.rpc<
    { withdrawals: { validatorIndex: string; amount: string; address: string }[] }
  >("eth_getBlockByNumber", ["latest", false]);
  withdrawal = block.withdrawals.find((w) =>
    BigInt(w.validatorIndex) === 0n && BigInt(w.amount) > 16_000_000_000n
  );
  return Boolean(withdrawal);
}, { maxSlots: 16, timeoutMs: 180_000 });
const afterFirstWithdrawal = await validator(net, 0);
// Sync committee membership can outlive exit. The first post-skip block has an
// empty sync aggregate, but later blocks can credit the exited member again.
// Wait for committee rotation and its final sweep without modifying protocol delays.
assert(BigInt(afterFirstWithdrawal.balance) < 1_000_000_000n);
const nextPeriodEpoch = (Math.floor(withdrawable / 256) + 1) * 256;
await net.skipSlots(nextPeriodEpoch * 32 - (await net.status()).slot - 1);
await net.advanceUntil(async () => {
  const record = await validator(net, 0);
  // Lighthouse classifies withdrawal_done using effective_balance (updated per epoch).
  return record.balance === "0" && record.status === "withdrawal_done";
}, { maxSlots: 64, timeoutMs: 180_000 });
const exited = await validator(net, 0);
assert.equal(exited.status, "withdrawal_done");
assert.equal(exited.balance, "0");
const report = {
  event: "withdrawal-passed",
  elapsedMs: performance.now() - start,
  exiting,
  afterFirstWithdrawal,
  exited,
  withdrawal,
  status: await net.status(),
};
await writeReport(net, "withdrawal", report);
