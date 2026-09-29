import assert from "node:assert/strict";
import { Devnet } from "../src/api.ts";
import { type ClockState, executionAt } from "../src/consensus.ts";
import { Network } from "../src/network.ts";
import { delay, json } from "../src/http.ts";
import { report } from "./report.ts";
const start = performance.now();
await using net = await Devnet.start({
  profile: "gloas",
  id: `gloas-${crypto.randomUUID().slice(0, 8)}`,
});
const initial = await net.status();
const m = await Network.manifest(initial.id);
const spec = await net.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec");
assert.equal(spec.data.GLOAS_FORK_EPOCH, "0");
assert.equal(spec.data.SLOT_DURATION_MS, "12000");
await net.advanceSlots(3);
const block = await net.beacon<{
  version: string;
  data: {
    message: {
      body: {
        execution_payload?: unknown;
        signed_execution_payload_bid: { message: { block_hash: string } };
        payload_attestations: { aggregation_bits: string; data: { payload_present: boolean } }[];
      };
    };
  };
}>("/eth/v2/beacon/blocks/head");
assert.equal(block.version, "gloas");
assert.equal(block.data.message.body.execution_payload, undefined);
assert(
  block.data.message.body.payload_attestations.some((x) =>
    x.data.payload_present && BigInt(x.aggregation_bits) > 0n
  ),
  "No actual PTC vote for a present payload",
);
const payload = await executionAt(m, "head");
assert.equal(payload.block_hash, (await net.status()).el.hash);
assert.equal(
  payload.block_hash,
  block.data.message.body.signed_execution_payload_bid.message.block_hash,
);
const clocks = { bn: await json<ClockState>(m.bnClock), vc: await json<ClockState>(m.vcClock) };
assert.equal(clocks.bn.nowMs, clocks.vc.nowMs);
for (const mark of ["attestations", "sync_messages", "payload_attestations"]) {
  assert.equal(clocks.vc.marks[mark], 3);
}
assert.equal(clocks.bn.marks.fork_choice, 3);
const paused = await net.status();
await delay(1500);
assert.equal((await net.status()).el.hash, paused.el.hash);
await net.advanceTo(new Date((paused.now + 12) * 1000));
assert.equal((await net.status()).slot, 4);
await report(net, "gloas", {
  event: "gloas-passed",
  elapsedMs: performance.now() - start,
  clocks,
  block: block.data.message.body,
  status: await net.status(),
});
