import { Infrastructure, LABEL, ROLE } from "./docker.ts";
import { delay, json } from "./http.ts";

interface Stats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus: number };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; total_inactive_file?: number };
  };
}
export async function sampleResources(id: string, durationMs = 2_000, controller?: string) {
  const infra = new Infrastructure(id);
  const entries = await infra.docker.listContainers({
    filters: { label: [`${LABEL}=${id}`] },
    size: true,
  });
  const read = () =>
    Promise.all(
      entries.map(async (entry) =>
        await infra.docker.getContainer(entry.Id).stats({ stream: false }) as unknown as Stats
      ),
    );
  const before = await read();
  const processStats = async () =>
    controller
      ? (await json<{
        result: {
          cpu: { user: number; system: number };
          memory: { rss: number; heapUsed: number };
        };
      }>(`${controller}/control`, {
        method: "POST",
        body: JSON.stringify({ method: "resources" }),
      })).result
      : undefined;
  const processBefore = await processStats();
  const start = performance.now();
  await delay(durationMs);
  const after = await read();
  const processAfter = await processStats();
  const elapsedMs = performance.now() - start;
  return {
    id,
    elapsedMs,
    controller: processBefore && processAfter
      ? {
        cpuPercent: (processAfter.cpu.user + processAfter.cpu.system - processBefore.cpu.user -
          processBefore.cpu.system) / (elapsedMs * 1000) * 100,
        memoryBytes: processAfter.memory.rss,
        heapBytes: processAfter.memory.heapUsed,
      }
      : undefined,
    components: entries.map((entry, i) => {
      const current = after[i];
      const cpuDelta = current.cpu_stats.cpu_usage.total_usage -
        before[i].cpu_stats.cpu_usage.total_usage;
      const systemDelta = current.cpu_stats.system_cpu_usage - before[i].cpu_stats.system_cpu_usage;
      const cache = current.memory_stats.stats?.inactive_file ??
        current.memory_stats.stats?.total_inactive_file ?? 0;
      const raw = current.memory_stats.usage ?? 0;
      return {
        role: entry.Labels[ROLE],
        cpuPercent: systemDelta > 0
          ? cpuDelta / systemDelta * current.cpu_stats.online_cpus * 100
          : 0,
        memoryBytes: Math.max(0, raw - cache),
        rawMemoryBytes: raw,
        memoryLimit: current.memory_stats.limit,
        writableLayerBytes: (entry as typeof entry & { SizeRw?: number }).SizeRw,
      };
    }),
  };
}

export async function diskUsage(id: string) {
  const infra = new Infrastructure(id);
  const containers = await infra.docker.listContainers({ filters: { label: [`${LABEL}=${id}`] } });
  return await Promise.all(containers.map(async (entry) => {
    const role = entry.Labels[ROLE];
    const path = role === "el" ? "/el" : role === "bn" ? "/bn" : "/shared/validator-keys";
    const output = await infra.exec(infra.docker.getContainer(entry.Id), ["du", "-sk", path]);
    return { role, path, allocatedBytes: Number(output.trim().split(/\s+/)[0]) * 1024 };
  }));
}
