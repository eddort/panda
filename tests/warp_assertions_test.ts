import assert from "node:assert/strict";
import { assertSigningHistory, type SigningHistory } from "../examples/warp_assertions.ts";
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
