import { Infrastructure, LABEL } from "../../src/docker.ts";
import { readBake } from "../../src/profiles.ts";
import { requireImage } from "../../src/artifacts.ts";
const infra = new Infrastructure("warp-modes-preflight");
const running = await infra.docker.listContainers();
console.log(
  JSON.stringify({
    runningPanda: running.filter((c) => c.Labels[LABEL]).map((c) => ({
      id: c.Labels[LABEL],
      names: c.Names,
    })),
  }),
);
for (const [profile, tag] of [["gloas", "direct-sync"], ["pectra", "panda"]] as const) {
  const bake = await readBake(profile, tag);
  for (const image of [bake.images.cl, bake.images.el, bake.images.genesis]) {
    await requireImage(infra, image);
  }
  console.log(JSON.stringify({ profile, tag, key: bake.key, imagesReady: true }));
}
