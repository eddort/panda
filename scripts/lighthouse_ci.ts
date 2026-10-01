import { atomicJson } from "../src/artifacts.ts";
import {
  type PublishedClients,
  validateClientBake,
  validatePublishedClients,
} from "../src/client_release.ts";
import { Infrastructure } from "../src/docker.ts";
import {
  assertLighthouseImage,
  clientBakeTag,
  lighthouseBuild,
  lighthouseTag,
} from "../src/lighthouse_build.ts";
import { canonical, profileName, profiles, readBake } from "../src/profiles.ts";
import { publishedDigest, registryAuth } from "../src/registry.ts";
import { lighthouseImage } from "../src/release.ts";
import { suiteHash } from "../src/verification.ts";

const [command, selection] = Deno.args;
if (Deno.args.length !== 2) {
  throw new Error("Usage: lighthouse_ci.ts matrix|resolve|publish <all|profile>");
}
const owner = Deno.env.get("GITHUB_REPOSITORY_OWNER")!;
const plan = async (profile: keyof typeof profiles) => {
  const build = await lighthouseBuild(profiles[profile], "linux/amd64");
  const tag = lighthouseTag(build);
  return {
    profile,
    tag,
    bake: await clientBakeTag(profiles[profile], build),
    image: lighthouseImage(owner, profile, tag),
    build,
  };
};
if (command === "matrix") {
  const selected = selection === "all"
    ? Object.keys(profiles).map(profileName)
    : [profileName(selection)];
  const include = await Promise.all(selected.map(plan));
  await Deno.writeTextFile(
    Deno.env.get("GITHUB_OUTPUT")!,
    `matrix=${JSON.stringify({ include })}\n`,
    { append: true },
  );
} else if (command === "resolve") {
  const selected = await plan(profileName(selection));
  const digest = await publishedDigest(selected.image);
  await Deno.writeTextFile(Deno.env.get("GITHUB_OUTPUT")!, `digest=${digest ?? ""}\n`, {
    append: true,
  });
  console.log(
    JSON.stringify({
      event: digest ? "reuse-lighthouse" : "build-lighthouse",
      ...selected,
      digest,
    }),
  );
} else if (command === "publish") {
  const selected = await plan(profileName(selection));
  const { profile, image, build } = selected;
  const bake = await readBake(profile, selected.bake);
  if (canonical(bake.lighthouse) !== canonical(build)) {
    throw new Error("Baked Lighthouse no longer matches the selected upstream/baker versions");
  }
  const report = JSON.parse(
    await Deno.readTextFile(`reports/profiles/${profile}/${bake.tag}/verification.json`),
  );
  if (
    !report.passed || report.status !== "passed" || report.bakeKey !== bake.key ||
    report.suiteHash !== await suiteHash(bake)
  ) {
    throw new Error("Publishing Lighthouse requires current successful profile verification");
  }
  validateClientBake(bake, profile);
  const infra = new Infrastructure(`bake-${build.key.slice(0, 24)}`);
  const info = await infra.docker.getImage(bake.images.cl.id).inspect();
  assertLighthouseImage(build, info);
  const sourceCommit = info.Config.Labels?.["org.opencontainers.image.revision"];
  if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("Missing original Lighthouse build source commit");
  }
  let digest = await publishedDigest(image);
  const reused = !!digest;
  if (digest) await infra.registryImage({ ...bake.images.cl, digest }, registryAuth());
  else digest = await infra.publishImage(bake.images.cl.id, image, registryAuth());
  const release: PublishedClients = {
    schema: 1,
    bake,
    lighthouse: { image, sourceCommit, digest, build },
  };
  validatePublishedClients(release, profile);
  const path = `.cache/client-releases/${profile}/clients.lock.json`;
  await atomicJson(path, release);
  console.log(
    JSON.stringify({
      event: reused ? "lighthouse-reused" : "lighthouse-published",
      image,
      digest,
      path,
    }),
  );
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary) {
    await Deno.writeTextFile(
      summary,
      `${
        reused ? "Reused" : "Published"
      } \`${digest}\`. Upstream: ${build.upstream.version} (${build.upstream.commit}); baker: ${build.baker.version} (${build.baker.hash}). The release-pr job will include this client lock in the release PR.\n`,
      { append: true },
    );
  }
} else {
  throw new Error("Usage: lighthouse_ci.ts matrix|resolve|publish <all|profile>");
}
