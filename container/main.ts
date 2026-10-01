import { Controller } from "../src/controller.ts";
import { Infrastructure } from "../src/docker.ts";
import { waitFor } from "../src/http.ts";
import { profileName, readBake } from "../src/profiles.ts";
import { releaseMetadata } from "../src/release.ts";
import { type Relay, tcpRelay } from "./relay.ts";

const release = JSON.parse(await Deno.readTextFile("release.json"));
const bake = await readBake(profileName(release.profile), release.bake);
if (
  JSON.stringify(releaseMetadata(bake, release.image, release.sourceCommit, release.lighthouse)) !==
    JSON.stringify(release)
) {
  throw new Error("Packaged release metadata does not match the bake");
}
const id = `ci-${crypto.randomUUID().slice(0, 8)}`;
const infra = new Infrastructure(id);
const abort = new AbortController();
const stop = () => abort.abort();
Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);
// Explicit dockerd arguments bypass the upstream entrypoint's default TCP listener.
const daemon = new Deno.Command("dockerd-entrypoint.sh", {
  args: [
    "dockerd",
    "--host=unix:///var/run/docker.sock",
    "--config-file=/opt/panda/container/daemon.json",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
let daemonExited = false;
const daemonExit = daemon.status.then((status) => {
  daemonExited = true;
  return status;
});
let controller: Controller | undefined;
const relays: Relay[] = [];
try {
  await waitFor("private Docker daemon", async () => {
    if (daemonExited || abort.signal.aborted) throw new Error("Docker startup interrupted");
    return await infra.docker.ping().then(() => true).catch(() => undefined);
  });
  for (const role of ["el", "cl", "genesis"] as const) {
    if (abort.signal.aborted) throw new Error("Image loading interrupted");
    if (!await infra.restoreImage(bake.images[role].id)) throw new Error(`Missing ${role} archive`);
  }
  await Deno.mkdir("/run/panda", { recursive: true });
  await Deno.writeTextFile("/run/panda/id", id, { mode: 0o600 });
  controller = await Controller.start({ id, profile: bake.profile, bake: bake.tag });
  const upstream = controller.serve(0);
  const initial = await controller.status();
  if (
    initial.slot !== 0 || initial.automine ||
    BigInt((initial.el as { number: string }).number) !== 0n
  ) {
    throw new Error("Service must expose fresh genesis");
  }
  relays.push(tcpRelay(() => upstream, 8545));
  relays.push(tcpRelay(() => controller!.manifest.beacon, 5052));
  relays.push(tcpRelay(() => controller!.manifest.vc, 5062));
  console.log(JSON.stringify({
    event: "ready",
    id,
    url: "http://127.0.0.1:8545",
    beacon: "http://127.0.0.1:5052",
    validator: "http://127.0.0.1:5062",
    ...release,
  }));
  if (!abort.signal.aborted) {
    await Promise.race([
      new Promise<void>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(), { once: true })
      ),
      daemonExit.then((status) => {
        throw new Error(`Private Docker exited: ${status.code}`);
      }),
      controller.server!.finished,
      ...relays.map((relay) => relay.finished),
    ]);
  }
} finally {
  stop();
  await Promise.allSettled(relays.map((relay) => relay.close()));
  try {
    await controller?.close();
  } finally {
    if (!daemonExited) daemon.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (!daemonExited) daemon.kill("SIGKILL");
    }, 30_000);
    await daemonExit;
    clearTimeout(timeout);
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
  }
}
