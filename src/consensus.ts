import { json, rpc, waitFor } from "./http.ts";
import { type Manifest, Network } from "./network.ts";
import { type TimeBackend, Timeline } from "./time.ts";
import type { EngineGate } from "./engine.ts";

export interface ClockState {
  nowMs: number;
  marks: Record<string, number>;
}
export interface ExecutionBlock {
  hash: string;
  number: string;
  timestamp: string;
  baseFeePerGas: string;
  gasLimit: string;
  transactions: string[];
  withdrawals?: { validatorIndex: string; amount: string; address: string }[];
}
export class Consensus implements TimeBackend {
  constructor(readonly manifest: Manifest, readonly engine?: EngineGate) {}
  async clock(endpoint: string, at?: number): Promise<ClockState> {
    return await json<ClockState>(
      at === undefined ? endpoint : `${endpoint}/advance/${at}`,
      at === undefined ? {} : { method: "POST" },
    );
  }
  async mark(endpoint: string, names: string[], slot: number): Promise<void> {
    await waitFor(`slot ${slot}: ${names.join(", ")}`, async () => {
      const state = await this.clock(endpoint);
      return names.every((name) => state.marks[name] === slot) ? true : undefined;
    });
  }
  async move(at: number, phase?: number): Promise<void> {
    if (this.engine) this.engine.nowMs = at;
    const m = this.manifest;
    const slot = Math.floor((at / 1000 - m.config.genesisTime) / 12);
    await this.clock(m.bnClock, at);
    if (phase === 0) await this.mark(m.bnClock, ["slot"], slot);
    await this.clock(m.vcClock, at);
    if (phase === 0) {
      await waitFor(`Beacon block at slot ${slot}`, async () => {
        const head = await json<{ data: { header: { message: { slot: string } } } }>(
          `${m.beacon}/eth/v1/beacon/headers/head`,
        );
        return Number(head.data.header.message.slot) === slot ? true : undefined;
      });
      await this.consistency(slot);
    } else if (phase === 4_000 || phase === 8_000) {
      const committees = await json<{ data: { index: string; validators: string[] }[] }>(
        `${m.beacon}/eth/v1/beacon/states/head/committees?slot=${slot}`,
      );
      const names = committees.data.filter((c) => c.validators.length > 0)
        .map((c) => `${phase === 4_000 ? "attestations" : "aggregates"}_${c.index}`);
      // This topology owns all genesis keys and the complete sync committee.
      if (phase === 4_000) names.push("sync_messages", "sync_expected_slot");
      else {
        const state = await this.clock(m.vcClock);
        if (state.marks.sync_expected_slot !== slot) throw new Error("Missing sync duty manifest");
        names.push(
          ...[0, 1, 2, 3].filter((i) => state.marks.sync_expected_mask & (1 << i)).map((i) =>
            `sync_aggregate_${i}`
          ),
        );
      }
      await this.mark(m.vcClock, names, slot);
    } else if (phase === 9_000) await this.mark(m.bnClock, ["state_advance"], slot);
    else if (phase === 11_500) await this.mark(m.bnClock, ["fork_choice"], slot);
  }
  async consistency(slot: number): Promise<ExecutionBlock> {
    const m = this.manifest;
    const block = await json<
      {
        execution_optimistic: boolean;
        data: {
          message: { body: { execution_payload: { block_hash: string; timestamp: string } } };
        };
      }
    >(`${m.beacon}/eth/v2/beacon/blocks/head`);
    const payload = block.data.message.body.execution_payload;
    if (
      block.execution_optimistic || Number(payload.timestamp) !== m.config.genesisTime + slot * 12
    ) throw new Error("Invalid CL execution status/timestamp");
    return await waitFor("EL/CL head agreement", async () => {
      const el = await rpc<ExecutionBlock>(m.el, "eth_getBlockByNumber", ["latest", false]);
      return el.hash === payload.block_hash &&
          Number(BigInt(el.timestamp)) === Number(payload.timestamp)
        ? el
        : undefined;
    });
  }
  async skip(at: number): Promise<void> {
    if (this.engine) this.engine.nowMs = at;
    await new Network(this.manifest.config).skipValidator(this.manifest, at);
  }
  static async connect(manifest: Manifest, engine?: EngineGate): Promise<Timeline> {
    if (manifest.config.mode !== "controlled") {
      throw new Error("Time control requires the Lighthouse fork");
    }
    const backend = new Consensus(manifest, engine);
    const bn = await backend.clock(manifest.bnClock);
    const vc = await backend.clock(manifest.vcClock);
    if (bn.nowMs !== vc.nowMs) throw new Error("BN/VC clock mismatch; reset required");
    return new Timeline(manifest.config.genesisTime * 1000, bn.nowMs, backend);
  }
}
