import assert from "node:assert/strict";
import {
  assertFullBitvector,
  assertFullParticipation,
  assertNoAttestationPenalties,
  assertSigningHistory,
  type AttestationReward,
  type SigningHistory,
} from "../bakes/shared/tests/warp_assertions.ts";

Deno.test("warp economics rejects missing duty flags, inactivity, negative rewards and lost participants", () => {
  assertFullBitvector(`0x${"ff".repeat(64)}`, 512, "sync");
  assert.throws(() => assertFullBitvector(`0xfe${"ff".repeat(63)}`, 512, "sync"), /Missing/);
  assert.throws(() => assertFullBitvector(`0x${"ff".repeat(63)}`, 512, "PTC"), /Missing/);
  assertFullParticipation([7, 7], ["0", "0"], 2);
  for (const bit of [1, 2, 4]) {
    assert.throws(() => assertFullParticipation([7 ^ bit, 7], ["0", "0"], 2), /missed/);
  }
  assert.throws(() => assertFullParticipation([7, 7], ["0", "1"], 2), /inactivity/);
  assert.throws(() => assertFullParticipation([7], ["0", "0"], 2), /Missing/);
  const clean = (): AttestationReward[] =>
    [0, 1].map((index) => ({
      validator_index: String(index),
      source: "10",
      target: "20",
      head: "5",
      inactivity: "0",
    }));
  assertNoAttestationPenalties(clean(), 2);
  for (const field of ["source", "target", "head", "inactivity"] as const) {
    const bad = clean();
    bad[0][field] = "-1";
    assert.throws(() => assertNoAttestationPenalties(bad, 2), /penalty/);
  }
  assert.throws(() => assertNoAttestationPenalties(clean().slice(1), 2), /Missing/);
  const duplicate = clean();
  duplicate[1].validator_index = "0";
  assert.throws(() => assertNoAttestationPenalties(duplicate, 2), /participant/);
});
Deno.test("warp history checks reject double proposals, double votes, surround votes and lost keys", () => {
  const clean = (): SigningHistory => ({
    metadata: { genesis_validators_root: "root" },
    data: [{
      pubkey: "key",
      signed_blocks: [{ slot: "1", signing_root: "a" }],
      signed_attestations: [{ source_epoch: "1", target_epoch: "2", signing_root: "b" }, {
        source_epoch: "2",
        target_epoch: "260",
        signing_root: "c",
      }],
    }],
  });
  assertSigningHistory(clean(), clean(), 8192);
  const proposal = clean();
  proposal.data[0].signed_blocks.push({ slot: "1", signing_root: "different" });
  assert.throws(() => assertSigningHistory(proposal), /Double proposal/);
  const doubleVote = clean();
  doubleVote.data[0].signed_attestations.push({
    source_epoch: "1",
    target_epoch: "2",
    signing_root: "different",
  });
  assert.throws(() => assertSigningHistory(doubleVote), /Double vote/);
  const rewritten = clean();
  rewritten.data[0].signed_blocks[0].signing_root = "changed after restart";
  assert.throws(() => assertSigningHistory(rewritten, clean()), /Double proposal/);
  const rewrittenVote = clean();
  rewrittenVote.data[0].signed_attestations[0].signing_root = "changed after restart";
  assert.throws(() => assertSigningHistory(rewrittenVote, clean()), /Double vote/);
  const surround = clean();
  surround.data[0].signed_attestations.push({
    source_epoch: "3",
    target_epoch: "4",
    signing_root: "inner",
  });
  assert.throws(() => assertSigningHistory(surround), /Surround vote/);
  const lost = clean();
  lost.data[0].pubkey = "other";
  assert.throws(() => assertSigningHistory(lost, clean()), /Lost slashing-protection key/);
});
