import assert from "node:assert/strict";
import { captureWarpRewards } from "../bakes/shared/tests/warp_rewards.ts";

Deno.test("long honest warp captures each closed epoch before historical states are pruned", async () => {
  const epochs = [4, 6, 7, 8];
  let reads = 0;
  let head = 4;
  const captured: number[] = [];
  const result = await captureWarpRewards(4, () => {
    head = epochs[Math.min(reads++, epochs.length - 1)];
    return Promise.resolve(head);
  }, (epoch) => {
    if (epoch < head - 3) throw new Error(`pruned reward state for epoch ${epoch}`);
    assert(epoch <= head - 2, "epoch must already be closed");
    captured.push(epoch);
    return Promise.resolve([]);
  }, () => reads >= epochs.length);
  assert.deepEqual(captured, [4, 5, 6]);
  assert.deepEqual(result.map((r) => r.epoch), captured);
});

Deno.test("reward collection propagates missing evidence instead of claiming no penalties", async () => {
  await assert.rejects(
    captureWarpRewards(4, () => Promise.resolve(6), () => {
      throw new Error("reward endpoint failed");
    }, () => true),
    /reward endpoint failed/,
  );
});
