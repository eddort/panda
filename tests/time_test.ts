import assert from "node:assert/strict";
import { Timeline } from "../src/time.ts";

Deno.test("forward time executes phase barriers, exact dates and partial slots", async () => {
  const phases: [number, number | undefined][] = [];
  const time = new Timeline(0, 11_500, {
    move: (at, phase) => {
      phases.push([at, phase]);
      return Promise.resolve();
    },
  });
  await time.advanceTime(12);
  assert.equal(time.nowMs, 23_500);
  assert.deepEqual(phases.map((p) => p[1]), [0, 4000, 6000, 8000, 9000, 11500]);
  await time.advanceTo(24.25);
  assert.equal(time.nowMs, 24_250);
  assert.equal(time.slot, 2);
  await assert.rejects(time.advanceTo(24), /forward/);
  await time.advanceTime(0.75);
  assert.equal(time.nowMs, 25_000);
});
Deno.test("concurrent advances serialize and accumulate, rather than lose time", async () => {
  let active = 0;
  const time = new Timeline(0, 11_500, {
    async move() {
      assert.equal(++active, 1);
      await Promise.resolve();
      active--;
    },
  });
  await Promise.all(Array.from({ length: 20 }, () => time.stepSlot()));
  assert.equal(time.slot, 20);
  assert.equal(time.nowMs, 251_500);
});
Deno.test("a partially failed clock update faults subsequent mutations", async () => {
  let calls = 0;
  const time = new Timeline(0, 11_500, {
    move() {
      calls++;
      throw new Error("VC disconnected after BN advanced");
    },
  });
  await assert.rejects(time.stepSlot(), /disconnected/);
  await assert.rejects(time.stepSlot(), /reset required/);
  assert.equal(calls, 1);
});
Deno.test("advanceUntil is bounded, detects existing success and processes epochs", async () => {
  const time = new Timeline(0, 11_500, { move: () => Promise.resolve() });
  assert.equal(await time.advanceUntil(() => Promise.resolve(true), { maxSlots: 0 }), 0);
  await assert.rejects(time.advanceUntil(() => Promise.resolve(false), { maxSlots: 2 }), /limit/);
  assert.equal(time.slot, 2);
  await time.advanceEpochs(1);
  assert.equal(time.slot, 34);
});
Deno.test("skip has separate semantics and does not execute intervening duties", async () => {
  let moves = 0, skips = 0;
  const time = new Timeline(0, 11_500, {
    move: () => {
      moves++;
      return Promise.resolve();
    },
    skip: () => {
      skips++;
      return Promise.resolve();
    },
  });
  await time.skipSlots(8192);
  assert.equal(time.slot, 8192);
  assert.equal(moves, 0);
  assert.equal(skips, 1);
  await time.stepSlot();
  assert.equal(moves, 6);
});

Deno.test("shutdown interrupts a long advance at the next phase boundary", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let moves = 0;
  const time = new Timeline(0, 11_500, {
    async move() {
      moves++;
      entered.resolve();
      await release.promise;
    },
  });
  const advancing = time.advanceSlots(1000);
  await entered.promise;
  time.stop();
  release.resolve();
  await assert.rejects(advancing, /stopping/);
  assert.equal(moves, 1);
});
