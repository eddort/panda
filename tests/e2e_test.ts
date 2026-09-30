import assert from "node:assert/strict";
import { profileName, profiles } from "../src/profiles.ts";
const profile = profileName(Deno.env.get("PANDA_PROFILE") ?? "pectra");
const descriptions: Record<string, string> = {
  e2e: "time travel, pause, automine, finality and external indexer",
  warp: "large jumps finish in seconds and restore finality without slashable signatures",
  protocol: "deposit, activation and consolidation",
  withdrawal: "signed voluntary exit and complete withdrawal",
  deploy: "sequential RPC and ethers contract deployments",
  gloas: "separate payload envelope, PTC votes and phase barriers",
  baseline: "ordinary unmodified clients produce an agreed execution payload",
  lifecycle: "CLI up/down/reset, ownership and profile mismatch rejection",
};
for (const [scenario, file] of Object.entries(profiles[profile].tests)) {
  Deno.test({
    name: `real ${profile}: ${descriptions[scenario] ?? scenario}`,
    ignore: Deno.env.get("PANDA_E2E") !== "1",
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--config=deno.runtime.json",
          "-A",
          file,
        ],
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      assert.equal(result.code, 0);
    },
  });
}
