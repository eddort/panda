import { report as writeReport } from "./report.ts";
import assert from "node:assert/strict";
import {
  ContractFactory,
  Interface,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroAddress,
} from "ethers";
import { Devnet } from "../src/api.ts";
import { privateKey } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { deadline } from "../src/http.ts";

const abi = new Interface([
  "constructor(address predecessor)",
  "function context() view returns (address predecessor, uint256 timestamp)",
]);
// Real EVM fixture, assembled directly to keep this test compiler-independent.
// Constructor: CODECOPY the appended ABI address, MLOAD, SSTORE at slot 0,
// then CODECOPY/RETURN the runtime. Runtime: return (SLOAD(0), TIMESTAMP).
// Padding is unreachable after RETURN; 4 KiB deployments also exercise code-deposit gas.
function fixture(size: number) {
  const runtime = "6000546000524260205260406000f3".padEnd(size * 2, "0");
  const word = (value: number) => value.toString(16).padStart(4, "0");
  const init = `602061${word(29 + size)}60003960005160005561${word(size)}61001d60003961${
    word(size)
  }6000f3`;
  assert.equal(init.length / 2, 29);
  return { bytecode: `0x${init}${runtime}`, runtime: `0x${runtime}` };
}
interface Receipt {
  status: string;
  blockNumber: string;
  blockHash: string;
  contractAddress: string;
}
interface Deployment {
  mode: string;
  nonce: number;
  runtimeBytes: number;
  address: string;
  predecessor: string;
  hash: string;
  block: number;
  timestamp: number;
  sendToReceiptMs: number;
  receiptGapMs?: number;
}

const started = performance.now();
await using net = await Devnet.start({ id: `deploy-${crypto.randomUUID().slice(0, 8)}` });
const readyMs = performance.now() - started;
const initial = await net.status();
const infra = new Infrastructure(initial.id);
const docker = await infra.docker.info();
const otherContainers =
  (await infra.docker.listContainers()).filter((entry) => entry.Labels[LABEL] !== initial.id)
    .length;
// Default ethers receipt polling can add seconds after a block is already available.
// These settings affect the test client only; the RPC still returns tx hashes immediately.
const provider = new JsonRpcProvider(net.url, 1337, {
  staticNetwork: true,
  pollingInterval: 25,
  cacheTimeout: -1,
  batchMaxCount: 1,
});
const wallet = new Wallet(privateKey);
const signer = new NonceManager(wallet.connect(provider));
const receipt = (hash: string) => net.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
const deployments: Deployment[] = [];
const modes: { mode: string; count: number; elapsedMs: number }[] = [];
let previousAddress = ZeroAddress;
let previousBlock = Number(BigInt(initial.el.number));
let previousTimestamp = Number(BigInt(initial.el.timestamp));
let previousReceiptAt: number | undefined;
await net.setAutomine(true);
try {
  for (const mode of ["raw-rpc", "ethers-factory"]) {
    const phaseStarted = performance.now();
    for (let i = 0; i < 10; i++) {
      const nonce = deployments.length;
      const runtimeBytes = i % 2 === 0 ? 15 : 4096;
      const { bytecode, runtime } = fixture(runtimeBytes);
      const factory = new ContractFactory(abi, bytecode, signer);
      const sentAt = performance.now();
      let hash: string;
      let mined: Receipt;
      if (mode === "raw-rpc") {
        const signed = await wallet.signTransaction({
          ...await factory.getDeployTransaction(previousAddress),
          type: 2,
          chainId: 1337,
          nonce,
          gasLimit: initial.profile === "gloas" ? 12_000_000n : 2_000_000n,
          maxFeePerGas: 10_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
        mined = await net.waitForService(
          `deployment ${nonce} receipt`,
          async () => (await receipt(hash)) ?? undefined,
          30_000,
        );
      } else {
        // Use normal deploy/receipt APIs and gas estimation, rather than manual block commands.
        const contract = await deadline(factory.deploy(previousAddress), 30_000, "ethers deploy");
        hash = contract.deploymentTransaction()!.hash;
        await deadline(contract.waitForDeployment(), 30_000, "ethers deployment receipt");
        const found = await receipt(hash);
        assert(found);
        mined = found;
        assert.equal(
          (await contract.getAddress()).toLowerCase(),
          mined.contractAddress.toLowerCase(),
        );
      }
      const receivedAt = performance.now();
      assert.equal(mined.status, "0x1", `deployment ${nonce} reverted`);
      assert(mined.contractAddress);
      const block = await net.rpc<{ hash: string; timestamp: string; transactions: string[] }>(
        "eth_getBlockByNumber",
        [mined.blockNumber, false],
      );
      const blockNumber = Number(BigInt(mined.blockNumber));
      const timestamp = Number(BigInt(block.timestamp));
      assert.equal(blockNumber, previousBlock + 1, "an empty/intermediate block was produced");
      assert.equal(timestamp, previousTimestamp + 12, "protocol slot length changed");
      assert.equal(block.hash, mined.blockHash);
      assert.deepEqual(block.transactions, [hash]);
      assert.equal(
        await net.rpc("eth_getCode", [mined.contractAddress, mined.blockNumber]),
        runtime,
      );
      const result = await net.rpc<string>("eth_call", [
        { to: mined.contractAddress, data: abi.encodeFunctionData("context") },
        mined.blockNumber,
      ]);
      const [parent, contractTime] = abi.decodeFunctionResult("context", result);
      assert.equal(
        parent.toLowerCase(),
        previousAddress.toLowerCase(),
        "constructor lost predecessor",
      );
      assert.equal(contractTime, BigInt(timestamp));
      deployments.push({
        mode,
        nonce,
        runtimeBytes,
        address: mined.contractAddress,
        predecessor: previousAddress,
        hash,
        block: blockNumber,
        timestamp,
        sendToReceiptMs: receivedAt - sentAt,
        receiptGapMs: previousReceiptAt === undefined ? undefined : receivedAt - previousReceiptAt,
      });
      previousAddress = mined.contractAddress;
      previousBlock = blockNumber;
      previousTimestamp = timestamp;
      previousReceiptAt = receivedAt;
      // No stepSlot, advance*, sleep or scheduled interval between transactions.
    }
    modes.push({ mode, count: 10, elapsedMs: performance.now() - phaseStarted });
  }
  await net.setAutomine(false); // Finish the last block's real consensus duties.
  const final = await net.status();
  assert.equal(final.automineError, undefined);
  assert.equal(final.slot, initial.slot + deployments.length);
  assert.equal(Number(BigInt(final.el.number)), previousBlock);
  const latencies = deployments.map((d) => d.sendToReceiptMs).sort((a, b) => a - b);
  const maxReceiptMs = latencies.at(-1)!;
  // A regression to wall-clock slots (12 s) must fail; allow host/CI scheduling variance.
  assert(
    maxReceiptMs < 6000,
    `Receipt waited ${maxReceiptMs.toFixed(0)} ms; expected accelerated blocks`,
  );
  for (const mode of modes) assert(mode.elapsedMs < mode.count * 3000, `${mode.mode} stalled`);
  const report = {
    event: "sequential-deploy-passed",
    recordedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    readyMs,
    environment: {
      host: Deno.build.target,
      engine: docker.ServerVersion,
      dockerCpus: docker.NCPU,
      dockerMemoryBytes: docker.MemTotal,
      otherRunningContainers: otherContainers,
    },
    provider: { pollingInterval: 25, cacheTimeout: -1, batchMaxCount: 1 },
    count: deployments.length,
    modes,
    medianReceiptMs: (latencies[Math.floor((latencies.length - 1) / 2)] +
      latencies[Math.floor(latencies.length / 2)]) / 2,
    p95ReceiptMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
    maxReceiptMs,
    maxReceiptGapMs: Math.max(...deployments.map((d) => d.receiptGapMs ?? 0)),
    protocolSeconds: previousTimestamp - Number(BigInt(initial.el.timestamp)),
    manualAdvanceCalls: 0,
    deployments,
  };
  await writeReport(net, "deploy", report);
} finally {
  provider.destroy();
}
