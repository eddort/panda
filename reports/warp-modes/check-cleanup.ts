import assert from "node:assert/strict";
import { Infrastructure, LABEL } from "../../src/docker.ts";

const { testNetworkIds } = JSON.parse(
  await Deno.readTextFile(new URL("./results.json", import.meta.url)),
) as { testNetworkIds: string[] };
const infra = new Infrastructure("warp-modes-cleanup-check");
const results = [];
for (const id of testNetworkIds) {
  const containers = await infra.docker.listContainers({
    all: true,
    filters: { label: [`${LABEL}=${id}`] },
  });
  results.push({ id, remainingContainers: containers.length });
}
console.log(JSON.stringify({ results, readOnly: true }));
assert(results.every((r) => r.remainingContainers === 0), "Test containers remain");
