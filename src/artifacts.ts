import { dirname } from "node:path";
import type { Infrastructure } from "./docker.ts";
import type { BakedImage } from "./profiles.ts";

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporary, JSON.stringify(value, null, 2) + "\n");
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}
export class BuildLock {
  private constructor(readonly path: string) {}
  static async acquire(path: string): Promise<BuildLock> {
    await Deno.mkdir(dirname(path), { recursive: true });
    try {
      using file = await Deno.open(path, { createNew: true, write: true });
      await file.write(new TextEncoder().encode(String(Deno.pid)));
      return new BuildLock(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const pid = Number(await Deno.readTextFile(path));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Incomplete build lock: ${path}`);
      try {
        Deno.kill(pid, 0);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await Deno.remove(path);
        return await BuildLock.acquire(path);
      }
      throw new Error(`Build is owned by process ${pid}: ${path}`);
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await Deno.remove(this.path);
  }
}

export async function requireImage(infra: Infrastructure, image: BakedImage): Promise<string> {
  try {
    await infra.docker.getImage(image.id).inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    if (!image.digest) {
      if (!await infra.restoreImage(image.id)) {
        throw new Error(`Missing local bake image ${image.id}; rebuild this bake`);
      }
    } else {
      await infra.image(image.digest);
      const found = await infra.docker.getImage(image.digest).inspect();
      if (found.Id !== image.id) throw new Error(`Bake image/platform mismatch: ${image.ref}`);
    }
  }
  if (!image.digest) await infra.cacheImage(image.id);
  return image.id;
}
