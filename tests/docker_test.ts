import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { Network } from "../src/network.ts";

Deno.test({
  name: "partial startup rollback preserves another stand and is repeatable",
  ignore: Deno.env.get("ZAP_DOCKER_TEST") !== "1",
  fn: async () => {
    const id = `rollback-${crypto.randomUUID().slice(0, 8)}`;
    const infra = new Infrastructure(id);
    const foreign = new Infrastructure(`other-${crypto.randomUUID().slice(0, 8)}`);
    const collision = `zap-${id}-bn`;
    await foreign.docker.createVolume({ Name: collision, Labels: foreign.labels });
    try {
      await assert.rejects(new Network(configuration({ id })).start(), /Foreign volume/);
      await infra.cleanup();
      await infra.cleanup();
      assert.equal(
        (await infra.docker.listNetworks({ filters: { label: [`${LABEL}=${id}`] } })).length,
        0,
      );
      assert.equal(
        (await infra.docker.listVolumes({ filters: { label: [`${LABEL}=${id}`] } })).Volumes
          ?.length ?? 0,
        0,
      );
      assert.equal((await foreign.docker.getVolume(collision).inspect()).Labels[LABEL], foreign.id);
    } finally {
      await infra.cleanup();
      await foreign.cleanup();
    }
  },
});
