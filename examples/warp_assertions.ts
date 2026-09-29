import assert from "node:assert/strict";

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
