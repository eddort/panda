import { profiles, readBake } from "../src/profiles.ts";
import { suiteHash } from "../src/verification.ts";
for (const profile of Object.keys(profiles) as (keyof typeof profiles)[]) {
  let entries;
  try {
    entries = Array.from(Deno.readDirSync(`bakes/${profile}`));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) continue;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const bake = await readBake(profile, entry.name.slice(0, -5));
    let verifiedAt: string | undefined;
    let verified = false;
    try {
      const report = JSON.parse(
        await Deno.readTextFile(`reports/profiles/${profile}/${bake.tag}/verification.json`),
      );
      if (report.passed && report.bakeKey === bake.key) verifiedAt = report.finishedAt;
      verified = Boolean(verifiedAt && report.suiteHash === await suiteHash(bake));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    console.log(
      JSON.stringify({
        profile,
        tag: bake.tag,
        key: bake.key,
        platform: bake.images.cl.platform,
        cl: bake.source.cl,
        el: bake.source.el ?? bake.images.el.digest,
        verifiedAt,
        verified,
      }),
    );
  }
}
