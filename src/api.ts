import { type Config } from "./config.ts";
import { Controller } from "./controller.ts";
import { json, rpc, waitFor } from "./http.ts";
import type { WarpOptions } from "./time.ts";
export type { WarpMode, WarpOptions } from "./time.ts";

export class Devnet {
  private controller?: Controller;
  constructor(readonly url: string) {}
  static async start(config: Partial<Config> = {}): Promise<Devnet> {
    const controller = await Controller.start(config);
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }
  private async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return (await json<{ result: T }>(`${this.url}/control`, {
      method: "POST",
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(3_600_000),
    })).result;
  }
  status(): Promise<
    {
      id: string;
      profile: import("./profiles.ts").ProfileName;
      bake: string;
      bakeKey: string;
      now: number;
      slot: number;
      automine: boolean;
      automineError?: string;
      el: { hash: string; number: string; timestamp: string };
      finality: { data: { finalized: { epoch: string; root: string } } };
    }
  > {
    return this.call("status");
  }
  stepSlot(): Promise<void> {
    return this.call("stepSlot");
  }
  advanceSlots(count: number): Promise<void> {
    return this.call("advanceSlots", [count]);
  }
  advanceEpochs(count: number): Promise<void> {
    return this.call("advanceEpochs", [count]);
  }
  advanceTime(seconds: number, options?: WarpOptions): Promise<void> {
    return this.call("advanceTime", options === undefined ? [seconds] : [seconds, options]);
  }
  advanceTo(timestamp: number | Date, options?: WarpOptions): Promise<void> {
    const seconds = timestamp instanceof Date ? timestamp.getTime() / 1000 : timestamp;
    return this.call("advanceTo", options === undefined ? [seconds] : [seconds, options]);
  }
  skipSlots(count: number): Promise<void> {
    return this.call("skipSlots", [count]);
  }
  setAutomine(enabled: boolean): Promise<void> {
    return this.call("setAutomine", [enabled]);
  }
  rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return rpc(this.url, method, params);
  }
  async beacon<T = unknown>(path: string): Promise<T> {
    return await json(`${this.url}${path}`);
  }
  async advanceUntil(
    predicate: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number> {
    if (!Number.isSafeInteger(options.maxSlots) || options.maxSlots < 0) {
      throw new Error("maxSlots must be a non-negative integer");
    }
    const deadline = performance.now() + (options.timeoutMs ?? 300_000);
    for (let count = 0;; count++) {
      if (await predicate()) return count;
      if (count === options.maxSlots || performance.now() >= deadline) {
        throw new Error("advanceUntil limit reached");
      }
      await this.stepSlot();
    }
  }
  waitForService<T>(
    description: string,
    probe: () => Promise<T | undefined>,
    timeoutMs = 30_000,
  ): Promise<T> {
    return waitFor(description, probe, timeoutMs);
  }
  async close(): Promise<void> {
    await this.controller?.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
