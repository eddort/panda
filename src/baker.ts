import { atomicJson, BuildLock, requireImage } from "./artifacts.ts";
export { atomicJson, BuildLock, requireImage } from "./artifacts.ts";
import { dirname, resolve } from "node:path";
import { Infrastructure } from "./docker.ts";
import {
  type Bake,
  type BakedImage,
  bakePath,
  bakeTag,
  canonical,
  type ProfileName,
  profiles,
  readBake,
  type Recipe,
  sha256,
  sourceHashes,
} from "./profiles.ts";

export async function git(
  args: string[],
  cwd = Deno.cwd(),
  env?: Record<string, string>,
): Promise<string> {
  const result = await new Deno.Command("git", { args, cwd, env, stdout: "piped", stderr: "piped" })
    .output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
export async function pinImage(infra: Infrastructure, ref: string): Promise<BakedImage> {
  await infra.image(ref);
  const image = await infra.docker.getImage(ref).inspect();
  if (!image.RepoDigests?.length) await infra.cacheImage(image.Id);
  return {
    ref,
    id: image.Id,
    digest: image.RepoDigests?.[0],
    platform: `${image.Os}/${image.Architecture}`,
  };
}
async function checkout(
  repository: string,
  ref: string,
): Promise<{ root: string; commit: string }> {
  const repositoryKey = (await sha256(repository)).slice(0, 16);
  const mirror = resolve(`.cache/baker/repos/${repositoryKey}`);
  await using _lock = await BuildLock.acquire(`${mirror}.lock`);
  await Deno.mkdir(mirror, { recursive: true });
  try {
    await Deno.stat(`${mirror}/HEAD`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await git(["init", "--bare", mirror]);
  }
  await git(["fetch", "--depth=1", repository, ref], mirror);
  const commit = await git(["rev-parse", "FETCH_HEAD^{commit}"], mirror);
  await git(["update-ref", `refs/heads/source-${commit}`, commit], mirror);
  const root = resolve(`.cache/baker/sources/${repositoryKey}/${commit}`);
  try {
    await Deno.stat(`${root}/.git`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.mkdir(dirname(root), { recursive: true });
    await git(["clone", "--no-checkout", mirror, root]);
    await git(["checkout", "--detach", commit], root);
  }
  if (
    await git(["rev-parse", "HEAD"], root) !== commit || await git(["status", "--porcelain"], root)
  ) {
    throw new Error(`Source cache changed: ${root}`);
  }
  await git(["submodule", "update", "--init", "--recursive"], root);
  return { root, commit };
}

async function prepareCl(
  recipe: Recipe,
  source: { root: string; commit: string },
  key: string,
  inputs: Record<string, string>,
): Promise<string> {
  const root = resolve(`.cache/baker/patched/${key}`);
  try {
    await Deno.stat(`${root}/.git`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.mkdir(dirname(root), { recursive: true });
    await git(["clone", "--no-checkout", source.root, root]);
    await git(["checkout", "--detach", source.commit], root);
  }
  if (await git(["rev-parse", "HEAD"], root) !== source.commit) {
    throw new Error(`Patched source cache changed HEAD: ${root}`);
  }
  const patch = resolve(`.cache/baker/inputs/${key}/client.patch`);
  await Deno.writeTextFile(patch, inputs[recipe.patch]);
  try {
    await git(["apply", "--reverse", "--check", patch], root);
  } catch {
    await git(["apply", "--check", patch], root);
    await git(["apply", patch], root);
  }
  // Compare the worktree with precisely HEAD + patch using a disposable index.
  const index = await Deno.makeTempFile({ dir: resolve(".cache/baker"), prefix: "index-" });
  await Deno.remove(index);
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(["read-tree", "HEAD"], root, env);
    await git(["apply", "--cached", patch], root, env);
    if (await git(["diff", "--no-ext-diff", "--name-only"], root, env)) {
      throw new Error(`Patched source cache contains unexpected edits: ${root}`);
    }
  } finally {
    await Deno.remove(index).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  await Deno.writeTextFile(
    `${root}/common/slot_clock/src/controlled.rs`,
    inputs[recipe.clockSource],
  );
  await Deno.mkdir(`${root}/common/slot_clock/tests`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/common/slot_clock/tests/controlled.rs`,
    inputs[recipe.clockTest],
  );
  return root;
}

/** Freeze native test/build inputs with the artifact, independently of later edits. */
export async function snapshotSources(
  hashes: Record<string, string>,
  directory: string,
): Promise<Record<string, string>> {
  const path = `${directory}/sources.json`;
  try {
    const inputs: Record<string, string> = JSON.parse(await Deno.readTextFile(path));
    for (const [file, hash] of Object.entries(hashes)) {
      if (typeof inputs[file] !== "string" || await sha256(inputs[file]) !== hash) {
        throw new Error(`Archived source does not match bake: ${file}`);
      }
    }
    return inputs;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const inputs: Record<string, string> = {};
  for (const [file, expected] of Object.entries(hashes)) {
    const candidates: (() => Promise<string>)[] = [() => Deno.readTextFile(file)];
    // Older manifests may predate source snapshots. Recover only an exact hash
    // match from the checkout/index; never silently test newer client code.
    if (!file.startsWith("/")) {
      for (const ref of [`:${file}`, `HEAD:${file}`]) {
        candidates.push(async () => {
          const result = await new Deno.Command("git", {
            args: ["show", ref],
            stdout: "piped",
            stderr: "null",
          }).output();
          if (!result.success) throw new Error("Source not in Git");
          return new TextDecoder().decode(result.stdout);
        });
      }
    }
    for (const read of candidates) {
      try {
        const source = await read();
        if (await sha256(source) === expected) {
          inputs[file] = source;
          break;
        }
      } catch { /* Try the next exact source copy. */ }
    }
    if (!Object.hasOwn(inputs, file)) {
      throw new Error(`Missing archived native source for this bake: ${file}`);
    }
  }
  await atomicJson(path, inputs);
  return inputs;
}

async function compile(
  infra: Infrastructure,
  kind: "cl" | "el",
  source: string,
  builder: BakedImage,
  runtime: BakedImage,
  key: string,
  clockOnly = false,
  nativeTests: NonNullable<Recipe["nativeTests"]> = [],
): Promise<BakedImage> {
  const output = resolve(`.cache/baker/output/${key}/${kind}`);
  await Deno.mkdir(output, { recursive: true });
  // Rust/Go caches survive source and patch revisions; Cargo/Go still validate their inputs.
  const cacheId = `bake-cache-${builder.id.slice(7, 23)}`;
  await using _cacheLock = await BuildLock.acquire(`.cache/baker/locks/${cacheId}-${kind}.lock`);
  const cacheInfra = new Infrastructure(cacheId);
  const cache = await cacheInfra.volume(`${kind}-cache`);
  const target = await cacheInfra.volume(`${kind}-target`);
  const cl = kind === "cl";
  const name = cl ? "lighthouse" : "geth";
  for (const test of nativeTests) {
    if (![test.package, test.target].every((s) => /^[a-zA-Z0-9_-]+$/.test(s))) {
      throw new Error("Invalid native test target");
    }
  }
  const container = await infra.container(kind, {
    Image: builder.id,
    WorkingDir: "/source",
    Env: cl
      ? ["CARGO_TARGET_DIR=/target", "CARGO_BUILD_JOBS=2", "CARGO_NET_GIT_FETCH_WITH_CLI=true"]
      : [
        "GOMODCACHE=/cache",
        "GOCACHE=/target",
        // Test-vector submodules are checked on the host and are not compiled into Geth.
        // Avoid recursively reading their host-created Git metadata for Go's VCS stamp.
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=diff.ignoreSubmodules",
        "GIT_CONFIG_VALUE_0=all",
      ],
    Cmd: [
      "sh",
      "-ec",
      cl
        ? "apt-get update && apt-get install -y --no-install-recommends cmake libclang-dev protobuf-compiler && cargo test --release --locked -p slot_clock --test controlled" +
          nativeTests.map((t) =>
            ` && cargo test --release --locked -p ${t.package} --test ${t.target}`
          ).join("") +
          (clockOnly
            ? ""
            : " && cargo build --release --locked --bin lighthouse --features portable && cp /target/release/lighthouse /output/lighthouse")
        : "go build -trimpath -o /output/geth ./cmd/geth",
    ],
    HostConfig: {
      Binds: [
        `${source}:/source`,
        `${output}:/output`,
        `${cache}:${cl ? "/usr/local/cargo" : "/cache"}`,
        `${target}:/target`,
      ],
      NanoCpus: 4e9,
    },
  });
  try {
    await container.start();
    const stream = await container.logs({ follow: true, stdout: true, stderr: true });
    const process = await import("node:process");
    infra.docker.modem.demuxStream(stream, process.stdout, process.stderr);
    const status = await container.wait();
    if (status.StatusCode) throw new Error(`${kind} compilation failed: ${status.StatusCode}`);
  } finally {
    await container.remove({ force: true });
  }
  if (clockOnly) return builder;
  await Deno.writeTextFile(
    `${output}/Dockerfile`,
    `FROM ${runtime.id}\nRUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*\nCOPY ${name} /usr/local/bin/${name}\nENTRYPOINT ["${name}"]\n`,
  );
  const tag = `zap-${name}:bake-${key.slice(0, 24)}`;
  const stream = await infra.docker.buildImage({ context: output, src: ["Dockerfile", name] }, {
    t: tag,
  });
  await new Promise<void>((resolve, reject) =>
    infra.docker.modem.followProgress(
      stream,
      (error: Error | null) => error ? reject(error) : resolve(),
    )
  );
  return await pinImage(infra, tag);
}

export interface BakeOptions {
  tag?: string;
  replace?: boolean;
  importCl?: string;
  clRef?: string;
  patch?: string;
  elImage?: string;
  elRef?: string;
  genesisImage?: string;
  baselineImage?: string;
  rustImage?: string;
  goImage?: string;
}
export async function bake(profile: ProfileName, options: BakeOptions = {}): Promise<Bake> {
  const tag = bakeTag(options.tag ?? "default");
  await using _tagLock = await BuildLock.acquire(`.cache/baker/locks/${profile}-${tag}.lock`);
  const path = bakePath(profile, tag);
  try {
    const old = await readBake(profile, tag);
    if (!options.replace) {
      if (
        Object.entries(options).some(([name, value]) =>
          name !== "tag" && value !== undefined && value !== false
        )
      ) {
        throw new Error(
          `Bake ${profile}:${tag} already exists; choose another tag or use --replace`,
        );
      }
      const infra = new Infrastructure(`bake-${old.key.slice(0, 24)}`);
      for (const image of Object.values(old.images)) await requireImage(infra, image);
      console.log(JSON.stringify({ event: "bake-reused", profile, tag, key: old.key }));
      return old;
    }
    // Keep the previous manifest until the complete replacement is ready.
    console.log(JSON.stringify({ event: "replacing-bake", previous: old.key }));
  } catch (error) {
    if (!String(error).includes("is missing. Run:")) throw error;
  }
  const recipe: Recipe = {
    ...profiles[profile],
    clRef: options.clRef ?? profiles[profile].clRef,
    patch: options.patch ?? profiles[profile].patch,
    elImage: options.elImage ?? profiles[profile].elImage,
    genesisImage: options.genesisImage ?? profiles[profile].genesisImage,
    baselineImage: options.baselineImage ?? profiles[profile].baselineImage,
    rust: options.rustImage ?? profiles[profile].rust,
    goBuilder: options.goImage ?? profiles[profile].goBuilder,
  };
  if (options.elImage && options.elRef) throw new Error("Choose --el-image or --el-ref");
  const hashes = await sourceHashes(recipe);
  const setup = new Infrastructure(`bake-${profile}-${(await sha256(tag)).slice(0, 8)}`);
  const runtime = await pinImage(setup, recipe.runtime);
  const rust = await pinImage(setup, recipe.rust);
  const genesis = await pinImage(setup, recipe.genesisImage);
  const baseline = await pinImage(setup, recipe.baselineImage);
  const clSource = options.importCl ? undefined : await checkout(recipe.clRepository, recipe.clRef);
  const importedCl = options.importCl ? await pinImage(setup, options.importCl) : undefined;
  const elSource = options.elRef ? await checkout(recipe.elRepository, options.elRef) : undefined;
  const go = elSource ? await pinImage(setup, recipe.goBuilder) : undefined;
  const importedEl = elSource ? undefined : await pinImage(setup, recipe.elImage);
  const source = {
    cl: clSource?.commit ?? recipe.clRef,
    el: elSource?.commit,
    importedCl: importedCl?.id,
  };
  const builders = { runtime, rust, ...(go ? { go } : {}) };
  const key = await sha256(
    canonical({
      recipe,
      hashes,
      source,
      builders,
      genesis,
      baseline,
      importedEl,
      importedCl,
      recipeRevision: 2,
      elBuildRevision: elSource ? 2 : undefined,
    }),
  );
  await using _buildLock = await BuildLock.acquire(`.cache/baker/locks/${key}.lock`);
  const inputs = await snapshotSources(hashes, `.cache/baker/inputs/${key}`);
  const infra = new Infrastructure(`bake-${key.slice(0, 24)}`);
  const artifactPath = `.cache/baker/artifacts/${key}.json`;
  try {
    const cached: Bake = JSON.parse(await Deno.readTextFile(artifactPath));
    if (cached.key !== key) throw new Error("Build cache identity mismatch");
    for (const image of Object.values(cached.images)) await requireImage(infra, image);
    const result = { ...cached, tag };
    await atomicJson(path, result);
    console.log(JSON.stringify({ event: "artifact-reused", key }));
    return result;
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) &&
      !String(error).includes("Missing local bake image")
    ) throw error;
  }
  const cl = importedCl ??
    await compile(
      infra,
      "cl",
      await prepareCl(recipe, clSource!, key, inputs),
      rust,
      runtime,
      key,
      false,
      recipe.nativeTests,
    );
  const el = importedEl ?? await compile(infra, "el", elSource!.root, go!, runtime, key);
  const platforms = new Set(
    [cl, el, genesis, baseline, runtime, rust, ...(go ? [go] : [])].map((x) => x.platform),
  );
  if (platforms.size !== 1) {
    throw new Error(`Mismatched bake platforms: ${[...platforms].join(", ")}`);
  }
  if (canonical(await sourceHashes(recipe)) !== canonical(hashes)) {
    throw new Error("Patch or clock sources changed during the build; previous tag was preserved");
  }
  for (const image of [cl, el, genesis, baseline]) await requireImage(infra, image);
  const result: Bake = {
    schema: 1,
    profile,
    tag,
    key,
    createdAt: new Date().toISOString(),
    recipe,
    source,
    hashes,
    images: { cl, el, genesis, baseline },
    builders,
  };
  await atomicJson(artifactPath, result);
  await atomicJson(path, result);
  return await readBake(profile, tag);
}

export async function testClock(profile: ProfileName, tag = "default"): Promise<void> {
  const selected = await readBake(profile, tag);
  await using _lock = await BuildLock.acquire(`.cache/baker/locks/${selected.key}.lock`);
  const inputs = await snapshotSources(selected.hashes, `.cache/baker/inputs/${selected.key}`);
  const source = await checkout(selected.recipe.clRepository, selected.source.cl);
  const root = await prepareCl(selected.recipe, source, selected.key, inputs);
  const infra = new Infrastructure(`bake-${selected.key.slice(0, 24)}`);
  await requireImage(infra, selected.builders.rust);
  await compile(
    infra,
    "cl",
    root,
    selected.builders.rust,
    selected.builders.runtime,
    selected.key,
    true,
    selected.recipe.nativeTests,
  );
}
