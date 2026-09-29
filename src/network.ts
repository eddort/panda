import { account, type Config, configuration, images, mnemonic } from "./config.ts";
import { Infrastructure, LABEL, ROLE } from "./docker.ts";
import { EngineGate } from "./engine.ts";
import { deadline, json, rpc, waitFor } from "./http.ts";

export interface Manifest {
  config: Config;
  el: string;
  beacon: string;
  bnClock: string;
  vcClock: string;
  vc: string;
  directory: string;
}
export class Network {
  engine?: EngineGate;
  private lockOwned = false;
  readonly infra: Infrastructure;
  readonly directory: string;
  constructor(readonly config: Config) {
    this.infra = new Infrastructure(config.id);
    this.directory = `${Deno.cwd()}/.zap/${config.id}`;
  }
  async start(): Promise<Manifest> {
    await Deno.mkdir(this.directory, { recursive: true });
    const path = `${this.directory}/network.lock`;
    try {
      const lock = await Deno.open(path, { createNew: true, write: true });
      try {
        await lock.write(new TextEncoder().encode(String(Deno.pid)));
      } finally {
        lock.close();
      }
      this.lockOwned = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const pid = Number(await Deno.readTextFile(path));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Network lock is incomplete; retry");
      }
      try {
        Deno.kill(pid, 0);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await Deno.remove(path);
        return await this.start();
      }
      throw new Error(`Devnet ${this.config.id} is owned by live process ${pid}`);
    }
    try {
      return await this.startOwned();
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }
  private async releaseLock(): Promise<void> {
    if (this.lockOwned) {
      await Deno.remove(`${this.directory}/network.lock`);
      this.lockOwned = false;
    }
  }
  private async startOwned(): Promise<Manifest> {
    const filters = { label: [`${LABEL}=${this.config.id}`] };
    const [existing, networks, volumes] = await Promise.all([
      this.infra.docker.listContainers({ all: true, filters }),
      this.infra.docker.listNetworks({ filters }),
      this.infra.docker.listVolumes({ filters }),
    ]);
    if (existing.length || networks.length || volumes.Volumes?.length) {
      throw new Error(
        `Devnet ${this.config.id} already has resources; use down/reset or connect()`,
      );
    }
    await Deno.mkdir(this.directory, { recursive: true });
    const { config, infra, directory } = this;
    for (const name of ["metadata", "parsed", "jwt", "validator-keys", "manifest.json"]) {
      try {
        await Deno.remove(`${directory}/${name}`, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    let clientImage: string = config.mode === "controlled" ? images.controlled : images.lighthouse;
    // A missing local build is an actionable error; never fall back to ordinary wall clocks.
    if (config.mode === "controlled") await infra.docker.getImage(clientImage).inspect();
    for (
      const image of [
        images.geth,
        images.genesis,
        ...(config.mode === "baseline" ? [images.lighthouse] : []),
      ]
    ) await infra.image(image);
    clientImage = (await infra.docker.getImage(clientImage).inspect()).Id;
    const started = performance.now();
    try {
      const network = await infra.network();
      const data = await infra.volume("el");
      const beaconData = await infra.volume("bn");
      const env = [
        `CHAIN_ID=${config.chainId}`,
        `NUMBER_OF_VALIDATORS=${config.validators}`,
        `EL_AND_CL_MNEMONIC=${mnemonic}`,
        `CHURN_LIMIT_QUOTIENT=${config.churnLimitQuotient}`,
        `GENESIS_TIMESTAMP=${config.genesisTime}`,
        "GENESIS_DELAY=0",
        "ELECTRA_FORK_EPOCH=0",
        "SLOT_DURATION_IN_SECONDS=12",
        "WITHDRAWAL_TYPE=0x01",
        `WITHDRAWAL_ADDRESS=${account}`,
        `EL_PREMINE_ADDRS={"${account}":{"balance":"1000000ETH"}}`,
      ];
      const oneShot = async (role: string, options: Parameters<Infrastructure["container"]>[1]) => {
        const c = await infra.container(role, options);
        await c.start();
        const result = await deadline(c.wait(), 120_000, `${role} container`);
        const logs = await infra.logs(c);
        await Deno.writeTextFile(`${directory}/${role}.log`, logs);
        if (result.StatusCode !== 0) throw new Error(`${role} failed: ${logs}`);
        await c.remove({ v: true });
      };
      await oneShot("genesis", {
        Image: images.genesis,
        Env: env,
        Entrypoint: ["/bin/bash"],
        Cmd: [
          "-ec",
          '/work/entrypoint.sh all; eth2-val-tools keystores --insecure --source-min 0 --source-max "$NUMBER_OF_VALIDATORS" --source-mnemonic "$EL_AND_CL_MNEMONIC" --out-loc /data/validator-keys',
        ],
        HostConfig: { Binds: [`${directory}:/data`], NetworkMode: network },
      });
      await Deno.writeTextFile(`${directory}/metadata/bootstrap_nodes.txt`, "");
      await oneShot("init", {
        Image: images.geth,
        Cmd: ["--datadir=/el", "init", "/shared/metadata/genesis.json"],
        HostConfig: { Binds: [`${directory}:/shared:ro`, `${data}:/el`], NetworkMode: network },
      });
      const port = (value: string) => ({ [value]: [{ HostIp: "127.0.0.1", HostPort: "" }] });
      const start = async (role: string, options: Parameters<Infrastructure["container"]>[1]) => {
        const container = await infra.container(role, options);
        await container.start();
        const info = await container.inspect();
        return (p: number) =>
          `http://127.0.0.1:${info.NetworkSettings.Ports[`${p}/tcp`]?.[0]?.HostPort}`;
      };
      const el = await start("el", {
        Image: images.geth,
        Cmd: [
          "--datadir=/el",
          `--networkid=${config.chainId}`,
          "--http",
          "--http.addr=0.0.0.0",
          "--http.vhosts=*",
          "--http.api=eth,net,web3,txpool",
          "--authrpc.addr=0.0.0.0",
          "--authrpc.vhosts=*",
          "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
          "--nodiscover",
          "--maxpeers=0",
          "--syncmode=full",
          "--cache=64",
          "--verbosity=3",
          "--log.json",
        ],
        ExposedPorts: { "8545/tcp": {}, "8551/tcp": {} },
        HostConfig: {
          Binds: [`${directory}:/shared:ro`, `${data}:/el`],
          NetworkMode: network,
          PortBindings: { ...port("8545/tcp"), ...port("8551/tcp") },
          MemoryReservation: 128 * 1024 ** 2,
          NanoCpus: 2e9,
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["el"] } } },
      });
      await waitFor("Geth RPC", () => rpc(el(8545), "eth_chainId"));
      if (config.mode === "controlled") {
        this.engine = await EngineGate.start(
          infra,
          infra.docker.getContainer(`zap-${config.id}-el`),
          el(8551),
          config.genesisTime * 1000 + 11_500,
          await Deno.readTextFile(`${directory}/jwt/jwtsecret`),
        );
      }
      const clockEnv = config.mode === "controlled"
        ? [`ZAP_CLOCK_START_MS=${config.genesisTime * 1000 + 11_500}`, "ZAP_CLOCK_PORT=5059"]
        : [];
      const bn = await start("bn", {
        Image: clientImage,
        Entrypoint: ["lighthouse"],
        Env: clockEnv,
        Cmd: [
          "--testnet-dir=/shared/metadata",
          "beacon_node",
          "--datadir=/bn",
          `--execution-endpoint=${this.engine?.url ?? "http://el:8551"}`,
          "--execution-jwt=/shared/jwt/jwtsecret",
          "--http",
          "--http-address=0.0.0.0",
          "--http-allow-origin=*",
          "--disable-discovery",
          "--disable-upnp",
          "--target-peers=0",
          "--staking",
          "--disable-packet-filter",
          "--epochs-per-blob-prune=1",
        ],
        ExposedPorts: { "5052/tcp": {}, "5059/tcp": {} },
        HostConfig: {
          Binds: [`${directory}:/shared:ro`, `${beaconData}:/bn`],
          NetworkMode: network,
          PortBindings: { ...port("5052/tcp"), ...port("5059/tcp") },
          MemoryReservation: 512 * 1024 ** 2,
          NanoCpus: 2e9,
          ExtraHosts: Deno.build.os === "linux" ? ["host.docker.internal:host-gateway"] : undefined,
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["bn"] } } },
      });
      await waitFor("Beacon API", () => json(`${bn(5052)}/eth/v1/beacon/genesis`), 90_000);
      const vc = await start("vc", {
        Image: clientImage,
        Entrypoint: ["lighthouse"],
        Env: clockEnv,
        Cmd: [
          "--testnet-dir=/shared/metadata",
          "validator_client",
          "--validators-dir=/shared/validator-keys/keys",
          "--secrets-dir=/shared/validator-keys/secrets",
          "--beacon-nodes=http://bn:5052",
          "--init-slashing-protection",
          `--suggested-fee-recipient=${account}`,
          "--http",
          "--http-address=0.0.0.0",
          "--unencrypted-http-transport",
        ],
        ExposedPorts: { "5062/tcp": {}, "5059/tcp": {} },
        HostConfig: {
          Binds: [`${directory}:/shared`],
          NetworkMode: network,
          PortBindings: { ...port("5062/tcp"), ...port("5059/tcp") },
          MemoryReservation: 128 * 1024 ** 2,
          NanoCpus: 2e9,
        },
      });
      const manifest: Manifest = {
        config,
        directory,
        el: el(8545),
        beacon: bn(5052),
        bnClock: bn(5059),
        vcClock: vc(5059),
        vc: vc(5062),
      };
      if (config.mode === "controlled") {
        await waitFor("validator clock and services", async () => {
          const clock = await json<{ marks: Record<string, number> }>(vc(5059));
          return clock.marks.ready === 0 && clock.marks.indices === 0 ? clock : undefined;
        }, 90_000);
      }
      await Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
      console.log(
        JSON.stringify({
          event: "network-started",
          id: config.id,
          elapsedMs: performance.now() - started,
          ...manifest,
        }),
      );
      return manifest;
    } catch (error) {
      const errors = [error];
      try {
        await this.engine?.close();
      } catch (engine) {
        errors.push(engine);
      }
      try {
        await this.saveLogs();
      } catch (logs) {
        errors.push(logs);
      }
      try {
        await infra.cleanup();
      } catch (cleanup) {
        errors.push(cleanup);
      }
      throw errors.length === 1 ? error : new AggregateError(errors, "Startup failed");
    }
  }
  async saveLogs(): Promise<void> {
    await Deno.mkdir(this.directory, { recursive: true });
    const containers = await this.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.config.id}`] },
    });
    for (const c of containers) {
      await Deno.writeTextFile(
        `${this.directory}/${c.Labels[ROLE]}.log`,
        await this.infra.logs(this.infra.docker.getContainer(c.Id)),
      );
    }
  }
  async skipValidator(manifest: Manifest, nowMs: number): Promise<void> {
    const listed = await this.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.config.id}`, `${ROLE}=vc`] },
    });
    if (listed.length !== 1) throw new Error("Expected exactly one owned validator client");
    const old = this.infra.docker.getContainer(listed[0].Id);
    const info = await old.inspect();
    await old.stop({ t: 10 });
    await json(`${manifest.bnClock}/advance/${nowMs}`, { method: "POST" });
    await old.remove();
    const env = (info.Config.Env ?? []).filter((e) => !e.startsWith("ZAP_CLOCK_START_MS="));
    const replacement = await this.infra.container("vc", {
      Image: info.Image,
      Entrypoint: info.Config.Entrypoint,
      Cmd: info.Config.Cmd,
      Env: [...env, `ZAP_CLOCK_START_MS=${nowMs}`],
      ExposedPorts: info.Config.ExposedPorts,
      HostConfig: {
        ...info.HostConfig,
        PortBindings: Object.fromEntries(
          Object.keys(info.Config.ExposedPorts ?? {}).map((
            key,
          ) => [key, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
        ),
      },
    });
    await replacement.start();
    const ports = (await replacement.inspect()).NetworkSettings.Ports;
    manifest.vcClock = `http://127.0.0.1:${ports["5059/tcp"]![0].HostPort}`;
    manifest.vc = `http://127.0.0.1:${ports["5062/tcp"]![0].HostPort}`;
    await Deno.writeTextFile(`${this.directory}/manifest.json`, JSON.stringify(manifest, null, 2));
    await waitFor("validator restarted after skipped slots", async () => {
      const clock = await json<{ nowMs: number; marks: Record<string, number> }>(manifest.vcClock);
      return clock.nowMs === nowMs && clock.marks.ready === 0 && clock.marks.indices !== undefined
        ? true
        : undefined;
    }, 90_000);
  }
  async stop(): Promise<void> {
    if (!this.lockOwned) {
      try {
        const pid = Number(await Deno.readTextFile(`${this.directory}/network.lock`));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Network is starting; retry");
        Deno.kill(pid, 0);
        throw new Error(`Devnet is owned by live process ${pid}; use its controller to shut down`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    try {
      await this.saveLogs();
    } finally {
      try {
        await this.engine?.close();
      } finally {
        try {
          await this.infra.cleanup();
        } finally {
          await this.releaseLock();
        }
      }
    }
  }
  static async manifest(id = "local"): Promise<Manifest> {
    configuration({ id });
    return JSON.parse(await Deno.readTextFile(`.zap/${id}/manifest.json`));
  }
}
