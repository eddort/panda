import assert from "node:assert/strict";

Deno.test({
  name: "real Pectra: time travel, pause, automine, finality and external indexer",
  ignore: Deno.env.get("ZAP_E2E") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config=deno.runtime.json", "-A", "examples/e2e.ts"],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    assert.equal(result.code, 0);
  },
});
