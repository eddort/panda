import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { dockerClient, Infrastructure, LABEL } from "../src/docker.ts";

Deno.test("Docker reports an operation failure inside an HTTP-success progress stream", async () => {
  const docker = dockerClient();
  const failure = { error: "runtime disappeared", errorDetail: { message: "runtime disappeared" } };
  docker.getImage = () =>
    ({
      inspect: () => Promise.reject({ statusCode: 404 }),
    }) as unknown as ReturnType<typeof docker.getImage>;
  docker.pull = (() =>
    Promise.resolve(
      Readable.from([JSON.stringify(failure) + "\n"]),
    )) as unknown as typeof docker.pull;
  await assert.rejects(
    new Infrastructure("progress-failure", docker).image("test:missing"),
    /runtime disappeared/,
  );
});

Deno.test("publishing rejects a registry error even when an older RepoDigest is present", async () => {
  const docker = dockerClient();
  const id = `sha256:${"a".repeat(64)}`;
  docker.getImage = () =>
    ({
      inspect: () =>
        Promise.resolve({
          Id: id,
          Config: { Labels: { [LABEL]: "publish-failure" } },
          RepoDigests: [`example.test/client@sha256:${"b".repeat(64)}`],
        }),
      tag: () => Promise.resolve(),
      push: () =>
        Promise.resolve(Readable.from([
          JSON.stringify({ errorDetail: { message: "registry denied publication" } }) + "\n",
        ])),
    }) as unknown as ReturnType<typeof docker.getImage>;
  await assert.rejects(
    new Infrastructure("publish-failure", docker).publishImage(id, "example.test/client:v1", {}),
    /registry denied publication/,
  );
});
