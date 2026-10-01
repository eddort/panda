import { delay } from "../../../src/http.ts";
import type { AttestationReward } from "./warp_assertions.ts";

/** Read each closed epoch while its state is still retained, including the final completed batch. */
export async function captureWarpRewards(
  firstEpoch: number,
  headEpoch: () => Promise<number>,
  read: (epoch: number) => Promise<AttestationReward[]>,
  finished: () => boolean,
): Promise<{ epoch: number; rewards: AttestationReward[] }[]> {
  const samples = [];
  let next = firstEpoch;
  for (;;) {
    // Snapshot completion before reading head: if the warp finishes during this read, take one
    // more head snapshot so the last completed epoch cannot be missed.
    const done = finished();
    const last = await headEpoch() - 2;
    while (next <= last) {
      samples.push({ epoch: next, rewards: await read(next) });
      next++;
    }
    if (done) return samples;
    await delay(100);
  }
}
