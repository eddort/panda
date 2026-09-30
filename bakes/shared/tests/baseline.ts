import assert from "node:assert/strict";
import { configuration } from "../../../src/config.ts";
import { executionAt } from "../../../src/consensus.ts";
import { rpc, waitFor } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { profileReport } from "./report.ts";
const config = configuration({
  id: `baseline-${crypto.randomUUID().slice(0, 8)}`,
  mode: "baseline",
  genesisTime: Math.floor(Date.now() / 1000) + 25,
});
const network = new Network(config);
const started = performance.now();
try {
  const m = await network.start();
  const agreed = await waitFor("ordinary EL/CL payload agreement", async () => {
    const el = await rpc<{ hash: string; number: string; timestamp: string }>(
      m.el,
      "eth_getBlockByNumber",
      ["latest", false],
    );
    if (BigInt(el.number) === 0n) return;
    const cl = await executionAt(m, "head");
    return cl.block_hash === el.hash ? { el, cl } : undefined;
  }, 120_000);
  assert.equal(Number(BigInt(agreed.el.timestamp)), Number(agreed.cl.timestamp));
  assert(Number(agreed.cl.timestamp) <= Date.now() / 1000);
  await profileReport({ ...config, bakeKey: m.bake.key }, "baseline", {
    event: "baseline-passed",
    elapsedMs: performance.now() - started,
    ...agreed,
  });
} finally {
  await network.stop();
}
