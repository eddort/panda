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
  private recovering = false;
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
    }, this.recovering ? 600_000 : 30_000);
  }
  async move(at: number, phase?: number): Promise<void> {
    if (this.engine) this.engine.nowMs = at;
    const m = this.manifest;
    const profile = m.bake.recipe;
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
      }, this.recovering ? 600_000 : 30_000);
      await waitFor(`execution agreement at slot ${slot}`, () => this.consistency(slot));
    } else if (phase === profile.attestationMs || phase === profile.aggregateMs) {
      const committees = await json<{ data: { index: string; validators: string[] }[] }>(
        `${m.beacon}/eth/v1/beacon/states/head/committees?slot=${slot}`,
      );
      const names = phase === profile.attestationMs && m.config.profile === "gloas"
        ? ["attestations"]
        : committees.data.filter((c) => c.validators.length > 0)
          .map((c) =>
            `${phase === profile.attestationMs ? "attestations" : "aggregates"}_${c.index}`
          );
      // This topology owns all genesis keys and the complete sync committee.
      if (phase === profile.attestationMs) names.push("sync_messages");
      else {
        await this.mark(m.vcClock, ["sync_expected_slot"], slot);
        const state = await this.clock(m.vcClock);
        if (state.marks.sync_expected_slot !== slot) throw new Error("Missing sync duty manifest");
        names.push(
          ...[0, 1, 2, 3].filter((i) => state.marks.sync_expected_mask & (1 << i)).map((i) =>
            `sync_aggregate_${i}`
          ),
        );
      }
      await this.mark(m.vcClock, names, slot);
    } else if (phase === 9_000) {
      if (m.config.profile === "gloas") await this.mark(m.vcClock, ["payload_attestations"], slot);
      await this.mark(m.bnClock, ["state_advance"], slot);
    } else if (phase === 11_500) {
      await this.mark(m.bnClock, ["fork_choice"], slot);
      this.recovering = false;
    }
  }
  async consistency(slot: number): Promise<ExecutionBlock> {
    const m = this.manifest;
    const payload = await executionAt(m, "head");
    if (
      Number(payload.timestamp) !== m.config.genesisTime + slot * 12
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
    this.recovering = !this.manifest.bake.recipe.preparedSkip;
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
    return new Timeline(
      manifest.config.genesisTime * 1000,
      bn.nowMs,
      backend,
      manifest.bake.recipe.phases,
    );
  }
}

/** Read execution data through the selected hardfork's Beacon API representation. */
export async function executionAt(
  m: Manifest,
  id: string,
): Promise<{ block_hash: string; timestamp: string }> {
  const block = await json<{
    execution_optimistic: boolean;
    data: {
      message: {
        slot: string;
        body: {
          execution_payload?: { block_hash: string; timestamp: string };
          signed_execution_payload_bid?: { message: { block_hash: string } };
        };
      };
    };
  }>(`${m.beacon}/eth/v2/beacon/blocks/${id}`);
  if (block.execution_optimistic) throw new Error("Optimistic CL execution state");
  if (m.config.profile === "pectra") {
    if (!block.data.message.body.execution_payload) throw new Error("Missing Pectra payload");
    return block.data.message.body.execution_payload;
  }
  const envelope = await json<
    {
      data: {
        message: { payload: { slot_number: string; block_hash: string; timestamp: string } };
      };
    }
  >(
    `${m.beacon}/eth/v1/beacon/execution_payload_envelopes/${id}`,
  );
  const payload = envelope.data.message.payload;
  if (
    payload.slot_number !== block.data.message.slot ||
    payload.block_hash !== block.data.message.body.signed_execution_payload_bid?.message.block_hash
  ) {
    throw new Error("Gloas bid/envelope mismatch");
  }
  return payload;
}

/** Gloas checkpoints commit the execution parent, before the checkpoint block's envelope. */
export async function finalizedExecutionHash(m: Manifest): Promise<string> {
  if (m.config.profile === "pectra") return (await executionAt(m, "finalized")).block_hash;
  const block = await json<{
    execution_optimistic: boolean;
    data: {
      message: {
        body: { signed_execution_payload_bid: { message: { parent_block_hash: string } } };
      };
    };
  }>(`${m.beacon}/eth/v2/beacon/blocks/finalized`);
  if (block.execution_optimistic) throw new Error("Optimistic finalized checkpoint");
  return block.data.message.body.signed_execution_payload_bid.message.parent_block_hash;
}
