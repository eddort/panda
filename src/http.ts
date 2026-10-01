export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function deadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let last: unknown;
  let pause = 10;
  while (performance.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await delay(Math.min(pause, Math.max(0, deadline - performance.now())));
    pause = Math.min(250, pause * 1.5);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last})` : ""}`);
}
export class HttpError extends Error {
  constructor(readonly status: number, url: string, body: string) {
    super(`${status} ${url}: ${body}`);
  }
}
export async function json<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(response.status, url, await response.text());
  return await response.json();
}
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await json<{ result: T; error?: { code: number; message: string } }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (response.error) {
    throw new Error(`${method}: ${response.error.message} (${response.error.code})`);
  }
  return response.result;
}
