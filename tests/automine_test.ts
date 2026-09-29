import assert from "node:assert/strict";
import { Automine, executable, type PoolTransaction } from "../src/automine.ts";
import { Timeline } from "../src/time.ts";
const tx: PoolTransaction = {
  hash: "0x01",
  from: "0xabc",
  nonce: "0x0",
  gas: "0x5208",
  value: "0x1",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0x2",
};
Deno.test("automine eligibility excludes nonce gaps, insufficient funds, fee caps and oversized gas", () => {
  assert(executable(tx, 0n, 3_000_000n, 80n, 30_000_000n));
  assert(!executable({ ...tx, nonce: "0x2" }, 0n, 3_000_000n, 80n, 30_000_000n));
  assert(!executable(tx, 0n, 1n, 80n, 30_000_000n));
  assert(!executable(tx, 0n, 3_000_000n, 101n, 30_000_000n));
  assert(!executable(tx, 0n, 3_000_000n, 80n, 20_000n));
});

Deno.test("disabling automine waits for an in-flight pool check and prevents another slot", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string[]>();
  let moves = 0;
  const time = new Timeline(0, 11_500, {
    move: () => {
      moves++;
      return Promise.resolve();
    },
  });
  class DelayedPool extends Automine {
    override candidates(): Promise<string[]> {
      entered.resolve();
      return release.promise;
    }
  }
  const miner = new DelayedPool("unused", time);
  await miner.set(true);
  await entered.promise;
  let disabled = false;
  const stopping = miner.set(false).then(() => {
    disabled = true;
  });
  await Promise.resolve();
  assert.equal(disabled, false);
  release.resolve(["executable"]);
  await stopping;
  assert.equal(moves, 0);
  await miner.stop();
});

Deno.test("a notification during an empty pool check rechecks newly arrived work", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string[]>();
  const mined = Promise.withResolvers<void>();
  let checks = 0;
  const time = new Timeline(0, 11_500, {
    move: (_at, phase) => {
      if (phase === 11_500) mined.resolve();
      return Promise.resolve();
    },
  });
  class ConcurrentPool extends Automine {
    override candidates(): Promise<string[]> {
      checks++;
      if (checks === 1) {
        entered.resolve();
        return release.promise;
      }
      return Promise.resolve(checks === 2 ? ["new-transaction"] : []);
    }
  }
  const miner = new ConcurrentPool("unused", time);
  await miner.set(true);
  await entered.promise;
  miner.notify();
  release.resolve([]);
  await mined.promise;
  await miner.set(false);
  assert.equal(time.slot, 1);
  await miner.stop();
});
