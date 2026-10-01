import assert from "node:assert/strict";

/** Fixed-size SSZ bitvectors; preserves repeated positions of the same validator. */
export function assertFullBitvector(bits: string, size: number, duty: string): void {
  assert(Number.isSafeInteger(size) && size > 0 && size % 8 === 0);
  assert.equal(bits, `0x${"ff".repeat(size / 8)}`, `Missing ${duty} participation`);
}

export interface AttestationReward {
  validator_index: string;
  source: string;
  target: string;
  head: string;
  inactivity: string;
}

/** A closed epoch in this fixture has all 64 active keys and no pre-existing inactivity. */
export function assertFullParticipation(
  flags: (number | string)[],
  inactivity: string[],
  count: number,
): void {
  assert.equal(flags.length, count, "Missing participation records");
  assert.equal(inactivity.length, count, "Missing inactivity records");
  for (let index = 0; index < count; index++) {
    assert.equal(
      Number(flags[index]) & 7,
      7,
      `Validator ${index} missed source/target/head participation`,
    );
    assert.equal(BigInt(inactivity[index]), 0n, `Validator ${index} accumulated inactivity`);
  }
}

export function assertNoAttestationPenalties(rewards: AttestationReward[], count: number): void {
  assert.equal(rewards.length, count, "Missing reward records");
  assert.deepEqual(
    rewards.map((r) => Number(r.validator_index)).sort((a, b) => a - b),
    Array.from({ length: count }, (_, index) => index),
    "Missing or duplicate reward participant",
  );
  for (const reward of rewards) {
    for (const field of ["source", "target", "head"] as const) {
      assert(BigInt(reward[field]) >= 0n, `Validator ${reward.validator_index}: ${field} penalty`);
    }
    assert.equal(BigInt(reward.inactivity), 0n, "Inactivity penalty during honest warp");
  }
}

export interface SigningHistory {
  metadata: { genesis_validators_root: string };
  data: {
    pubkey: string;
    signed_blocks: { slot: string; signing_root?: string }[];
    signed_attestations: { source_epoch: string; target_epoch: string; signing_root?: string }[];
  }[];
}
export function assertSigningHistory(
  history: SigningHistory,
  before?: SigningHistory,
  resumedSlot?: number,
): void {
  assert(history.data.length > 0, "Empty signing history");
  if (before) {
    assert.equal(history.metadata.genesis_validators_root, before.metadata.genesis_validators_root);
  }
  const keys = new Set(history.data.map((v) => v.pubkey));
  assert.equal(keys.size, history.data.length);
  for (const previous of before?.data ?? []) {
    assert(keys.has(previous.pubkey), "Lost slashing-protection key");
  }
  for (const record of history.data) {
    const previous = before?.data.find((v) => v.pubkey === record.pubkey);
    const blocks = new Map<string, string | undefined>();
    // Check across exports too: Lighthouse can prune old entries between jumps.
    for (const block of [...previous?.signed_blocks ?? [], ...record.signed_blocks]) {
      if (blocks.has(block.slot)) {
        assert.equal(block.signing_root, blocks.get(block.slot), "Double proposal");
      }
      blocks.set(block.slot, block.signing_root);
    }
    const votes = [...previous?.signed_attestations ?? [], ...record.signed_attestations];
    for (const a of votes) {
      assert(BigInt(a.source_epoch) <= BigInt(a.target_epoch));
      for (const b of votes) {
        if (a.target_epoch === b.target_epoch) {
          assert.equal(a.source_epoch, b.source_epoch, "Double vote source");
          assert.equal(a.signing_root, b.signing_root, "Double vote root");
        }
        assert(
          !(BigInt(a.source_epoch) < BigInt(b.source_epoch) &&
            BigInt(b.target_epoch) < BigInt(a.target_epoch)),
          "Surround vote",
        );
      }
    }
    if (previous) {
      const max = (values: string[]) => values.reduce((n, v) => BigInt(v) > n ? BigInt(v) : n, -1n);
      assert(
        max(record.signed_blocks.map((b) => b.slot)) >=
          max(previous.signed_blocks.map((b) => b.slot)),
        "Lost proposal watermark",
      );
      assert(
        max(record.signed_attestations.map((v) => v.source_epoch)) >=
          max(previous.signed_attestations.map((v) => v.source_epoch)),
        "Lost source watermark",
      );
      assert(
        max(record.signed_attestations.map((v) => v.target_epoch)) >=
          max(previous.signed_attestations.map((v) => v.target_epoch)),
        "Lost target watermark",
      );
    }
    if (resumedSlot !== undefined) {
      assert(
        votes.some((v) => Number(v.target_epoch) * 32 >= resumedSlot),
        "Validator did not resume attesting",
      );
    }
  }
}
