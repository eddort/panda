import assert from "node:assert/strict";
import { warpScenario } from "../bakes/shared/tests/warp.ts";
import { scenariosFor } from "../src/verification.ts";

Deno.test("profile warp uses 1000 honest slots, retains long fast jumps and writes registered reports", () => {
  for (const profile of ["pectra", "gloas"] as const) {
    for (
      const [mode, slots, name] of [["honest", 1000, "warp"], ["fast", 8192, "warp-fast"]] as const
    ) {
      const scenario = warpScenario(mode);
      assert.equal(scenario.slots, slots);
      assert.equal(scenario.name, name);
      assert(scenariosFor({ profile }).includes(scenario.name));
    }
  }
  assert.deepEqual(warpScenario("honest", 8192), { slots: 8192, name: "warp-8192" });
  assert.deepEqual(warpScenario("fast", 64), { slots: 64, name: "warp-fast-64" });
  assert.throws(() => warpScenario("honest", 32), /more than one epoch/);
});
