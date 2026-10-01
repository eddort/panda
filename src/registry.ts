import { assertMissingRevision } from "./release.ts";

export function registryAuth() {
  const username = Deno.env.get("GITHUB_ACTOR");
  const password = Deno.env.get("GHCR_TOKEN");
  if (!username || !password) throw new Error("GITHUB_ACTOR and GHCR_TOKEN are required");
  return { username, password, serveraddress: "ghcr.io" };
}

export function registryDigest(status: number, digest: string | null): string | undefined {
  if (status === 200) {
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Registry omitted the immutable manifest digest");
    }
    return digest;
  }
  assertMissingRevision(status);
  return undefined;
}

export async function publishedDigest(image: string): Promise<string | undefined> {
  const match = /^ghcr\.io\/([a-z0-9/-]+):([a-zA-Z0-9._-]+)$/.exec(image);
  if (!match) throw new Error("Expected a versioned GHCR image");
  const [, repository, revision] = match;
  const credentials = registryAuth();
  const auth = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull,push`,
    {
      headers: {
        authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!auth.ok) throw new Error(`Registry authentication failed: HTTP ${auth.status}`);
  const { token } = await auth.json();
  if (typeof token !== "string" || !token) throw new Error("Missing registry token");
  const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${revision}`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const digest = registryDigest(response.status, response.headers.get("docker-content-digest"));
  return digest ? `ghcr.io/${repository}@${digest}` : undefined;
}

export async function requireUnpublished(image: string): Promise<void> {
  if (await publishedDigest(image)) throw new Error(`Registry revision already exists: ${image}`);
  console.log(`Revision is available: ${image}`);
}
