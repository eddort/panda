import { configuration } from "../src/config.ts";
import { Network } from "../src/network.ts";
import { json, rpc, waitFor } from "../src/http.ts";

import { diskUsage, sampleResources } from "../src/profile.ts";

const network = new Network(
  configuration({
    id: "baseline",
    mode: "baseline",
    genesisTime: Math.floor(Date.now() / 1000) + 30,
  }),
);
const start = performance.now();
try {
  const m = await network.start();
  const readyMs = performance.now() - start;
  await waitFor("ordinary network first block", async () => {
    const block = await rpc<string>(m.el, "eth_blockNumber");
    return BigInt(block) > 0n ? block : undefined;
  }, 120_000);
  const firstBlockMs = performance.now() - start;
  const resources = await sampleResources("baseline", 24000);
  const report = {
    recordedAt: new Date().toISOString(),
    readyMs,
    firstBlockMs,
    resources,
    disk: await diskUsage("baseline"),
    event: "baseline-head",
    el: await rpc(m.el, "eth_getBlockByNumber", ["latest", false]),
    cl: await json(`${m.beacon}/eth/v1/beacon/headers/head`),
  };
  await Deno.mkdir("reports", { recursive: true });
  await Deno.writeTextFile("reports/baseline.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await network.stop();
}
