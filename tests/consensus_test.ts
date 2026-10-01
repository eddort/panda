import assert from "node:assert/strict";
import { Consensus, type ExecutionBlock } from "../src/consensus.ts";
import type { Manifest } from "../src/network.ts";

async function clockFixture(
  nativeWait: boolean,
  response: (path: string) => Response,
  test: (consensus: Consensus, endpoint: string, paths: string[]) => Promise<void>,
) {
  const paths: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return response(path);
  });
  try {
    const manifest = { bake: { recipe: { clockWait: nativeWait } } } as unknown as Manifest;
    await test(new Consensus(manifest), `http://127.0.0.1:${server.addr.port}`, paths);
  } finally {
    await server.shutdown();
  }
}

Deno.test("native completion barrier replaces mark polling", async () => {
  await clockFixture(
    true,
    () => Response.json({ nowMs: 123, marks: { proposal: 7, execution: 7 } }),
    async (consensus, endpoint, paths) => {
      await consensus.mark(endpoint, ["proposal", "execution"], 7);
      assert.deepEqual(paths, ["/wait/7/30000/proposal,execution"]);
    },
  );
});

Deno.test("legacy bakes keep their existing mark protocol", async () => {
  await clockFixture(
    false,
    () => Response.json({ nowMs: 123, marks: { proposal: 7 } }),
    async (consensus, endpoint, paths) => {
      await consensus.mark(endpoint, ["proposal"], 7);
      assert.deepEqual(paths, ["/"]);
    },
  );
});

Deno.test("native barrier must confirm every requested completion at the exact slot", async () => {
  for (const marks of [{ proposal: 7 }, { proposal: 7, execution: 8 }]) {
    await clockFixture(
      true,
      (path) =>
        Response.json({
          nowMs: 123,
          marks: path === "/" ? { proposal: 7, execution: 7 } : marks,
        }),
      async (consensus, endpoint) => {
        await assert.rejects(consensus.mark(endpoint, ["proposal", "execution"], 7));
      },
    );
  }
});

Deno.test("native barrier timeout is a failure, not a polling fallback", async () => {
  await clockFixture(
    true,
    (path) =>
      path === "/"
        ? Response.json({ nowMs: 123, marks: { proposal: 7 } })
        : new Response("unfinished phase", { status: 408 }),
    async (consensus, endpoint, paths) => {
      await assert.rejects(consensus.mark(endpoint, ["proposal"], 7));
      assert.equal(paths.length, 1);
    },
  );
});

Deno.test("direct sync requires BN coverage for the current root, independently of VC success", async () => {
  const root = `0x${"12".repeat(32)}`;
  for (const scenario of ["complete", "missing", "changed head"]) {
    let headers = 0;
    const paths: string[] = [];
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/committees")) return Response.json({ data: [] });
      if (path.endsWith("/headers/head")) {
        const currentRoot = scenario === "changed head" && headers++ > 0
          ? `0x${"34".repeat(32)}`
          : root;
        return Response.json({ data: { root: currentRoot, header: { message: { slot: "7" } } } });
      }
      if (path === "/bn/wait/7/30000/slot") return Response.json({ marks: { slot: 7 } });
      if (path.startsWith("/bn/wait/")) {
        // A complete set for another root at this very same slot is insufficient.
        return Response.json({
          marks: {
            [
              `sync_contributions_${
                scenario === "missing" ? "0xdead" : path.split("sync_contributions_")[1]
              }`
            ]: 7,
          },
        });
      }
      return Response.json({ marks: { attestations: 7, sync_messages: 7 } });
    });
    const endpoint = `http://127.0.0.1:${server.addr.port}`;
    try {
      const manifest = {
        config: { profile: "gloas", genesisTime: 0 },
        bake: { recipe: { clockWait: true, directSync: true, attestationMs: 3000 } },
        beacon: endpoint,
        bnClock: `${endpoint}/bn`,
        vcClock: `${endpoint}/vc`,
      } as unknown as Manifest;
      const consensus = new Consensus(manifest);
      // Execution for the phase-0 head is valid; a later head has not been checked.
      consensus.consistency = () =>
        Promise.resolve({ hash: "valid-phase-0-execution" } as ExecutionBlock);
      await consensus.move(7 * 12000, 0);
      const advancing = consensus.move(7 * 12000 + 3000, 3000);
      if (scenario === "complete") await advancing;
      else await assert.rejects(advancing, /Incomplete native barrier|head changed/i);
      if (scenario !== "changed head") {
        assert(paths.includes(`/bn/wait/7/30000/sync_contributions_${root}`));
      }
    } finally {
      await server.shutdown();
    }
  }
});
