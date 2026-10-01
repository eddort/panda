import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { dockerClient, Infrastructure } from "../src/docker.ts";

Deno.test("Docker reports an operation failure inside an HTTP-success progress stream", async () => {
  const docker = dockerClient();
  const failure = { error: "runtime disappeared", errorDetail: { message: "runtime disappeared" } };
  docker.getImage = () =>
    ({
      inspect: () => Promise.reject({ statusCode: 404 }),
    }) as ReturnType<typeof docker.getImage>;
  docker.pull = (() =>
    Promise.resolve(
      Readable.from([JSON.stringify(failure) + "\n"]),
    )) as unknown as typeof docker.pull;
  await assert.rejects(
    new Infrastructure("progress-failure", docker).image("test:missing"),
    /runtime disappeared/,
  );
});
