import assert from "node:assert/strict";

for (
  const [name, file] of [
    ["real Pectra: time travel, pause, automine, finality and external indexer", "e2e"],
    ["real Pectra: deposit, activation and consolidation", "protocol"],
    ["real Pectra: signed voluntary exit and complete withdrawal", "withdrawal"],
    [
      "real Pectra: sequential raw-RPC and ethers contract deployments without manual blocks",
      "deploy",
    ],
  ]
) {
  Deno.test({
    name,
    ignore: Deno.env.get("ZAP_E2E") !== "1",
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--config=deno.runtime.json", "-A", `examples/${file}.ts`],
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      assert.equal(result.code, 0);
    },
  });
}
