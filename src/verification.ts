import { dirname, join, normalize } from "node:path";
import { type Bake, canonical, profiles, sha256 } from "./profiles.ts";

export function scenariosFor(bake: Pick<Bake, "profile">): string[] {
  return profiles[bake.profile].tests;
}

/** Fingerprint only this profile's runtime and executable suite. Client source
 * changes belong to a new bake key and do not invalidate an existing binary. */
export async function suiteHash(bake: Pick<Bake, "profile">, root = "."): Promise<string> {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    path = normalize(path);
    if (Object.hasOwn(files, path)) return;
    const source = await Deno.readTextFile(join(root, path));
    files[path] = await sha256(source);
    // All local modules use literal relative imports; include dynamic literal imports too.
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const dependency = normalize(join(dirname(path), match[1]));
      // Recipes pin future builds. Only consumed runtime defaults are relevant below.
      if (dependency.startsWith("profiles/")) continue;
      await visit(dependency);
    }
  }
  const recipe = JSON.parse(await Deno.readTextFile(join(root, `profiles/${bake.profile}.json`)));
  const scenarios: string[] = recipe.tests;
  for (
    const path of [
      "scripts/test_profile.ts",
      "tests/e2e_test.ts",
      "src/cli.ts",
      "src/controller.ts",
      "src/verification.ts",
      "scripts/deno",
      "deno.runtime.json",
      "deno.lock",
      ...scenarios.map((name) =>
        name === "lifecycle" ? "scripts/lifecycle_test.ts" : `examples/${name}.ts`
      ),
      ...(scenarios.includes("e2e") ? ["examples/indexer.ts"] : []),
    ]
  ) await visit(path);
  return await sha256(canonical({
    version: 2,
    profile: bake.profile,
    scenarios,
    defaults: { churnLimitQuotient: recipe.churnLimitQuotient },
    files,
  }));
}
