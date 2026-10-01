export interface Relay {
  port: number;
  finished: Promise<void>;
  close(): Promise<void>;
}

/** Forward bytes unchanged, including authentication, Host/Origin and streaming responses. */
export function tcpRelay(upstream: () => string, port: number, hostname = "0.0.0.0"): Relay {
  const listener = Deno.listen({ hostname, port });
  const connections = new Set<Deno.TcpConn>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  function closeConnection(connection: Deno.TcpConn) {
    connections.delete(connection);
    try {
      connection.close();
    } catch { /* already closed by a stream */ }
  }
  const finished = (async () => {
    try {
      for await (const incoming of listener) {
        connections.add(incoming);
        const task = (async () => {
          let outgoing: Deno.TcpConn | undefined;
          try {
            // Fast skips replace VC and its published port. Resolve on each new connection.
            const target = new URL(upstream());
            if (target.hostname !== "127.0.0.1") throw new Error("Relay upstream must be local");
            outgoing = await Deno.connect({ hostname: target.hostname, port: Number(target.port) });
            connections.add(outgoing);
            if (closed) return;
            await Promise.allSettled([
              incoming.readable.pipeTo(outgoing.writable),
              outgoing.readable.pipeTo(incoming.writable),
            ]);
          } finally {
            closeConnection(incoming);
            if (outgoing) closeConnection(outgoing);
          }
        })().catch((error) => {
          if (!closed) console.error("Client relay connection failed:", error);
        });
        pending.add(task);
        void task.then(() => pending.delete(task));
      }
    } catch (error) {
      if (!closed) throw error;
    }
  })();
  return {
    port: listener.addr.port,
    finished,
    async close() {
      if (!closed) {
        closed = true;
        listener.close();
        for (const connection of connections) closeConnection(connection);
      }
      await finished;
      await Promise.all(pending);
    },
  };
}
