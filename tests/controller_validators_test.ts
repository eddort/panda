import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import { type Manifest, type Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

// HTTP adapter unit tests; these do not certify validator/signature behavior.
async function fixture(
  run: (f: {
    call: (method: string, params: unknown[]) => Promise<{ status: number; body: unknown }>;
    requests: { path: string; authorization: string | null; body: unknown }[];
  }) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  await Deno.mkdir(`${directory}/validator-keys/keys`, { recursive: true });
  await Deno.writeTextFile(`${directory}/validator-keys/keys/api-token.txt`, "unit-secret\n");
  const requests: { path: string; authorization: string | null; body: unknown }[] = [];
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (r) => {
    const text = await r.text();
    const path = new URL(r.url).pathname;
    requests.push({
      path,
      authorization: r.headers.get("authorization"),
      body: text ? JSON.parse(text) : null,
    });
    if (path === "/eth/v1/keystores") return Response.json({ data: [{ status: "imported" }] });
    if (path.endsWith("/voluntary_exit")) {
      return Response.json({
        data: { message: { epoch: "3", validator_index: "64" }, signature: "signed-by-keymanager" },
      });
    }
    if (path === "/eth/v1/beacon/pool/voluntary_exits") return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  });
  const endpoint = `http://127.0.0.1:${upstream.addr.port}`;
  const time = new Timeline(0, 11_500, { move: async () => {} });
  const controller = new Controller({} as Network, {
    config: configuration(),
    directory,
    vc: endpoint,
    beacon: endpoint,
    el: endpoint,
  } as Manifest, time);
  const url = controller.serve(0);
  try {
    await run({
      requests,
      call: async (method, params) => {
        const response = await fetch(`${url}/control`, {
          method: "POST",
          body: JSON.stringify({ method, params }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
    await upstream.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("control imports a validator using the private authenticated keymanager", async () => {
  await fixture(async ({ call, requests }) => {
    const keystore = JSON.stringify({ version: 4, pubkey: "ab".repeat(48) });
    const result = await call("importValidator", [keystore, "password"]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { result: null });
    assert.deepEqual(requests, [{
      path: "/eth/v1/keystores",
      authorization: "Bearer unit-secret",
      body: { keystores: [keystore], passwords: ["password"] },
    }]);
    assert.equal((await call("importValidator", ["{}", "password"])).status, 500);
    assert.equal(requests.length, 1);
  });
});

Deno.test("control forwards a signed exit to Beacon without forwarding the keymanager token", async () => {
  await fixture(async ({ call, requests }) => {
    const pubkey = `0x${"ab".repeat(48)}`;
    const result = await call("exitValidator", [pubkey]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { result: null });
    assert.equal(requests[0].path, `/eth/v1/validator/${pubkey}/voluntary_exit`);
    assert.equal(requests[0].authorization, "Bearer unit-secret");
    assert.deepEqual(requests[1], {
      path: "/eth/v1/beacon/pool/voluntary_exits",
      authorization: null,
      body: { message: { epoch: "3", validator_index: "64" }, signature: "signed-by-keymanager" },
    });
    const invalid = await call("exitValidator", ["../../other"]);
    assert.equal(invalid.status, 500);
    assert.match(JSON.stringify(invalid.body), /pubkey/);
    assert.equal(requests.length, 2);
  });
});
