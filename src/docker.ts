// @deno-types="@types/dockerode"
import Docker from "dockerode";
import { Writable } from "node:stream";

export const LABEL = "io.zap-net.id";
export const ROLE = "io.zap-net.role";
export function dockerClient(): Docker {
  const host = Deno.env.get("DOCKER_HOST");
  const explicit = Deno.env.get("ZAP_DOCKER_SOCKET");
  if (host && !host.startsWith("unix://") && !explicit) {
    throw new Error("Use a local Unix Docker socket (ZAP_DOCKER_SOCKET or DOCKER_HOST=unix://…)");
  }
  const desktop = `${Deno.env.get("HOME")}/.docker/run/docker.sock`;
  let fallback = "/var/run/docker.sock";
  try {
    if (Deno.statSync(desktop)) fallback = desktop;
  } catch { /* Linux default */ }
  return new Docker({ socketPath: explicit ?? host?.slice(7) ?? fallback });
}

export function missing(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 404;
}

export class Infrastructure {
  readonly docker: Docker;
  readonly labels: Record<string, string>;
  constructor(readonly id: string, docker = dockerClient()) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Invalid devnet id");
    this.docker = docker;
    this.labels = { [LABEL]: id };
  }
  async image(ref: string): Promise<void> {
    try {
      await this.docker.getImage(ref).inspect();
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const stream = await this.docker.pull(ref);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null) => error ? reject(error) : resolve(),
      );
    });
  }
  async network(): Promise<string> {
    const result = await this.docker.createNetwork({
      Name: `zap-${this.id}`,
      Labels: this.labels,
      Driver: "bridge",
    });
    return result.id;
  }
  async volume(role: string): Promise<string> {
    const name = `zap-${this.id}-${role}`;
    try {
      const existing = await this.docker.getVolume(name).inspect();
      if (existing.Labels?.[LABEL] !== this.id) throw new Error(`Foreign volume: ${name}`);
      return name;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await this.docker.createVolume({ Name: name, Labels: { ...this.labels, [ROLE]: role } });
    return name;
  }
  async container(role: string, options: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return await this.docker.createContainer({
      ...options,
      name: `zap-${this.id}-${role}`,
      Labels: { ...options.Labels, ...this.labels, [ROLE]: role },
    });
  }
  async logs(container: Docker.Container): Promise<string> {
    const data = await container.logs({ stdout: true, stderr: true, tail: 300 });
    const output: Uint8Array[] = [];
    const writer = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk);
        callback();
      },
    });
    // Docker returns multiplexed frames when Tty=false, including for non-streaming logs.
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    this.docker.modem.demuxStream(stream, writer, writer);
    stream.end(data);
    return output.map((x) => new TextDecoder().decode(x)).join("");
  }
  async exec(container: Docker.Container, cmd: string[]): Promise<string> {
    const instance = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await instance.start({ Detach: false });
    let output = "";
    const writer = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    this.docker.modem.demuxStream(stream, writer, writer);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const status = await instance.inspect();
    if (status.ExitCode !== 0) throw new Error(`exec failed (${status.ExitCode}): ${output}`);
    return output;
  }
  async cleanup(): Promise<void> {
    const filters = { label: [`${LABEL}=${this.id}`] };
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        if (!missing(error)) errors.push(error);
      }
    };
    for (const entry of await this.docker.listContainers({ all: true, filters })) {
      const container = this.docker.getContainer(entry.Id);
      if (entry.State === "running") await attempt(() => container.stop({ t: 5 }));
      await attempt(() => container.remove({ force: true, v: true }));
    }
    for (const entry of await this.docker.listNetworks({ filters })) {
      await attempt(() => this.docker.getNetwork(entry.Id).remove());
    }
    for (const entry of (await this.docker.listVolumes({ filters })).Volumes ?? []) {
      await attempt(() => this.docker.getVolume(entry.Name).remove());
    }
    if (errors.length) throw new AggregateError(errors, `Cleanup failed for ${this.id}`);
  }
}
