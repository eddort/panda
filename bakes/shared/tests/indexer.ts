// Deliberately a separate process, like an external test service.
const rpc = Deno.args[0];
let processed = { number: "0x0", hash: "0x" };
let stopped = false;
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}` })),
}, () => Response.json(processed));
const stop = () => {
  stopped = true;
  server.shutdown();
};
Deno.addSignalListener("SIGTERM", stop);
while (!stopped) {
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json();
    if (body.result) processed = { number: body.result.number, hash: body.result.hash };
  } catch { /* An indexer retries transient RPC outages using real time. */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
await server.finished;
