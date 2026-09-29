import pectra from "../profiles/pectra.json" with { type: "json" };
import gloas from "../profiles/gloas.json" with { type: "json" };

export const profiles = { pectra, gloas };
export type ProfileName = keyof typeof profiles;
export type Recipe = typeof pectra & {
  sourceFiles?: string[];
  nativeTests?: { package: string; target: string }[];
  preparedSkip?: boolean;
};
export function profileName(value: string): ProfileName {
  if (!Object.hasOwn(profiles, value)) throw new Error(`Unknown hardfork profile: ${value}`);
  return value as ProfileName;
}
export function bakeTag(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error(`Invalid bake tag: ${value}`);
  return value;
}
export interface BakedImage {
  ref: string;
  id: string;
  digest?: string;
  platform: string;
}
export interface Bake {
  schema: 1;
  profile: ProfileName;
  tag: string;
  key: string;
  createdAt: string;
  recipe: Recipe;
  source: { cl: string; el?: string; importedCl?: string };
  hashes: Record<string, string>;
  images: { el: BakedImage; cl: BakedImage; genesis: BakedImage; baseline: BakedImage };
  builders: Record<string, BakedImage>;
}
export function bakePath(profile: ProfileName, tag: string): string {
  return `bakes/${profileName(profile)}/${bakeTag(tag)}.json`;
}
export async function readBake(profile: ProfileName, tag = "default"): Promise<Bake> {
  let bake: Bake;
  try {
    bake = JSON.parse(await Deno.readTextFile(bakePath(profile, tag)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Bake ${profile}:${tag} is missing. Run: deno task bake ${profile} --tag ${tag}`,
      );
    }
    throw error;
  }
  if (
    bake.schema !== 1 || bake.profile !== profile || bake.tag !== tag ||
    bake.recipe.name !== profile || !/^[a-f0-9]{64}$/.test(bake.key)
  ) {
    throw new Error(`Invalid bake manifest: ${profile}:${tag}`);
  }
  for (const role of ["el", "cl", "genesis", "baseline"] as const) {
    const image = bake.images[role];
    if (!image) throw new Error(`Missing bake image: ${role}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.id) || !image.platform.startsWith("linux/")) {
      throw new Error("Bake requires immutable Linux image identities");
    }
  }
  if (new Set(Object.values(bake.images).map((image) => image.platform)).size !== 1) {
    throw new Error("Bake images must use the same platform");
  }
  if (
    bake.recipe.slotMs !== 12000 || bake.recipe.slotsPerEpoch !== 32 || bake.recipe.tailMs !== 11500
  ) {
    throw new Error("This controller requires the mainnet 12-second slot schedule");
  }
  return bake;
}
export async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function sourceHashes(recipe: Recipe): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (
    const path of [recipe.patch, recipe.clockSource, recipe.clockTest, ...recipe.sourceFiles ?? []]
  ) {
    result[path] = await sha256(await Deno.readFile(path));
  }
  return result;
}
/** Canonical object keys make build identities independent of JSON formatting/key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) =>
        a.localeCompare(b)
      )
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}
