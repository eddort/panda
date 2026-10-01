# Forking an external network in zap-net

Research dated September 29, 2026, with zap-net code at `9078f84`. Reviewed the current
architecture, local sources of pinned Geth and genesis-generator, Hardhat/EDR documentation, and
primary Ethereum sources. No fork prototype or external-RPC checks were run as part of this
research. The timelines below are engineering estimates for one developer familiar with Ethereum
clients.

**Conclusion:** forking contract state through an existing EVM runtime is relatively simple. A
lightweight RPC fork with real Geth, Lighthouse, signatures, and finality is a substantial client
extension. Existing time advancement is suitable for this mode; the main risk is EL state storage
and mutation. Using a prepared EL database is simpler, but requires much more disk space and data
preparation.

| Option                                                  | First prototype                        | Version with regressions  | Result                                                                            |
| ------------------------------------------------------- | -------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Separate EVM-only backend using Hardhat/EDR             | 2–4 working days                       | 1–2 weeks                 | Fork by URL, local changes, and timestamp control; without our real CL            |
| Shadow fork from prepared Geth state + a new local CL   | 3–5 working days                       | 2–4 weeks                 | Real clients, local validators, and time; a large initial database                |
| On-demand RPC state loading inside Geth + a local CL    | 1–2 weeks after feasibility validation | 6–12+ weeks               | The target lightweight mode; high uncertainty around trie/proofs and the provider |
| Continuing the original BeaconState with its validators | Separate research                      | No justified estimate yet | Requires resolving keys, validator state, and scheduling                          |

Estimates assume one preselected Ethereum L1 network and a compatible Pectra block, without
universal support for L2s, arbitrary hardforks, impersonation, or full EL/CL snapshot/revert. For
the database option, obtaining, downloading, and syncing it are separate. The lightweight option
first needs a 3–5 working day research phase; a negative result may require a different upstream API
or approach, not simply more time.

**What "like Hardhat" means.** The initial state is pinned at a selected block. Account data, code,
and storage are loaded on access, then changes are stored locally. Pinning the block makes tests
reproducible and permits cache reuse. This is described in the
[Hardhat forking guide](https://v2.hardhat.org/hardhat-network/docs/guides/forking-other-networks)
and [current Hardhat 3 guide](https://hardhat.org/docs/guides/forking).

Hardhat uses EDR; its model does not require consensus or P2P. An ordinary contract fork test
therefore does not reproduce Beacon Chain operation, validator activation, or finality voting. See
the [EDR model explanation](https://hardhat.org/docs/explanations/edr-simulated-networks) and
[EDR implementation](https://github.com/NomicFoundation/edr).

**What already fits in zap-net.** In [network.ts](../src/network.ts), Docker lifecycle is separate
from slot execution; [time.ts](../src/time.ts) serializes time advancement;
[consensus.ts](../src/consensus.ts) checks agreement between real EL/CL clients;
[engine.ts](../src/engine.ts) controls payload preparation. These parts can be reused.

Currently, `Network.startOwned` always creates empty volumes, generates genesis, and runs
`geth init`. The initial 64 validators belong to our VC. The existing mode cannot attach a source
block or read missing storage from another node. The name `engine_forkchoiceUpdated` in the Engine
API refers to consensus branch selection; it does not enable forking from an external RPC.

**Why an RPC proxy alone is insufficient.** When executing a transaction, Geth reads storage through
`StateDB`, including nested calls and `delegatecall`. Forwarding external `eth_call` to mainnet does
not enable the next local transaction to execute against a mixture of initial and modified state.
This requires reading initial state inside the EL, local writes, and a correct new `stateRoot`.

The pinned Geth v1.15.11 code confirms this:
[Database/Trie](https://github.com/ethereum/go-ethereum/blob/v1.15.11/core/state/database.go),
[state readers](https://github.com/ethereum/go-ethereum/blob/v1.15.11/core/state/reader.go),
[StateDB](https://github.com/ethereum/go-ethereum/blob/v1.15.11/core/state/statedb.go). The local
checkout was verified: `36b2371c59cd91a9b1da062b3e382f05a6d8687e`. It has no ready RPC fallback in
this path. For the selected architecture, lazy loading must be added to Geth, or a compatible
execution backend must be developed.

**The hardest technical part is proofs and state writes.** An option to investigate: attach a
partially loaded trie to the source block's `stateRoot`, fetch code and proofs, verify them, store
retrieved nodes locally, and execute ordinary Geth state transitions.
[EIP-1186](https://eips.ethereum.org/EIPS/eip-1186) provides account/storage proofs against the
selected block's root. Local writes must take precedence, including explicit zero and deletion;
after writing zero, the old upstream value must not be substituted again.

However, a proof for one key does not guarantee all nodes needed to modify the trie are available.
In the `fullNode` deletion branch of `trie.go`, Geth may resolve the remaining sibling node to
collapse the branch. A comment in `state_object.go` explicitly describes this case for storage
deletion. Ordinary `eth_getProof(address, [slot], block)` may therefore be insufficient: access to
additional nodes must be demonstrated, or an additional source interface defined. This is a concrete
prototype risk, not a confirmed ready architecture. Sources:
[trie deletion](https://github.com/ethereum/go-ethereum/blob/v1.15.11/trie/trie.go),
[storage updates](https://github.com/ethereum/go-ethereum/blob/v1.15.11/core/state/state_object.go).

The provider's ability to return **historical proofs** must be checked separately. Historical
`eth_call` support does not establish that ability. For example, Geth documentation distinguishes
historical values from trie-node storage: historical proofs for path-based archives appeared in
v1.17.x with the appropriate `history.trienode` setting. See the
[archive-mode documentation](https://geth.ethereum.org/docs/fundamentals/archive).

**An existing path without Geth changes: shadow fork.** The pinned genesis-generator v4.0.0 contains
`SHADOW_FORK_RPC`, `SHADOW_FORK_FILE`, and forwarding of `--shadow-fork-block`/`--shadow-fork-rpc`
to `eth-beacon-genesis`. Verified commit: `f06b98c2cb789c6ac45fd0e6167173820dc095d2`, files
`entrypoint.sh:95` and `defaults/defaults.env:33`. The generator can bind a new CL genesis to the
selected EL header.

But this parameter does not download contract state into an empty Geth database. A consistent EL
snapshot/prepared database containing the selected block's state is required. This is the approach
described in the
[Ethereum shadow-fork guide](https://notes.ethereum.org/@parithosh/shadowfork-tutorial) and
[ethPandaOps article](https://ethpandaops.io/posts/kurtosis-deep-dive/). A full archive of all
history is unnecessary: accessible state at the selected point and the required chain data suffice.
Ordinary [Geth snap sync](https://geth.ethereum.org/docs/fundamentals/sync-modes) still downloads
network state; its cost differs from Hardhat's selective loading.

Work in zap: import a database copy into an owned volume, verify block hash/state root, preserve a
compatible EL genesis and fork schedule, generate a new CL, configure time, and check the first
payload and finality. Open the source database only for reading or copying. Account for completed
database writes, client format, and finalized/safe markers; transferring a single
`latest_block.json` is not transferring the database. Kurtosis is not required for this.

**Validators define the capability boundary.** An execution-state fork transfers contracts,
balances, and storage. It does not automatically transfer BeaconState: validator indices, BLS keys,
activation/exit epochs, pending queues, balances, and finality history.

With a new local CL, real deposit → activation, voluntary exit → withdrawal, and consolidation can
be preserved for local keys. This requires reconciling the real deposit-contract address, its
counters, and the boundary of old deposits with the new CL, network parameters, and existing system
queues. Zap currently defaults the deposit contract to `0x4242…4242`; that address cannot silently
be retained when connecting an arbitrary public network.

The EL needs standard EIP-4788/2935 and Pectra request processing; pinned `core/state_processor.go`
invokes deposit, withdrawal, and consolidation processing. Sources:
[state processor](https://github.com/ethereum/go-ethereum/blob/v1.15.11/core/state_processor.go),
[EIP-6110](https://eips.ethereum.org/EIPS/eip-6110),
[EIP-7251](https://eips.ethereum.org/EIPS/eip-7251).

Existing mainnet staking contracts may store references to validators and oracle results from the
source network. A new local CL does not automatically make these references consistent. In
particular, Lighthouse ignores a consolidation request if the source/target pubkey is absent from
its registry (`process_operations.rs`, `process_consolidation_request`). Transferring the original
BeaconState is insufficient: without the corresponding signing keys, we cannot simply continue
ordinary proposals and attestations. Replacing the key set creates an explicitly transformed state.
Current barriers also assume ownership of the entire validator set. This is a separate scope of
work.

**Time advancement is retained.** For a branch from block B, initial clocks must be selected
relative to `B.timestamp`, and the first descendant must have a valid timestamp. Using the current
2033 default without discussion would immediately age time-sensitive contracts. Ordinary
`advanceTime` and `advanceTo` must continue processing all intermediate slots; `skipSlots` remains a
separate operation. Switching to a fork must not silently change these semantics to a single EVM
timestamp jump.

Cold-cache speed will depend on upstream RPC, read count, limits, and proofs. The measured 8.85 s
for 20 local deployments cannot be carried over to the new mode. Separate cold- and warm-cache
measurements are needed. A pinned block hash/state root is mandatory: local writes must not mix with
a continually changing upstream `latest`.

**Compatibility with other Hardhat conveniences.** Full parity includes impersonation,
setBalance/setStorageAt, reset, and snapshot/revert. These operations do not automatically come with
state forking. Hardhat supports impersonation without a private key; standard Geth cannot sign a
valid transaction from another EOA without its key. Bypassing signature verification violates zap's
current requirement. For real EL/CL, start with controlled accounts and explicitly documented
initial fixtures; changing this boundary requires a separate decision.

EDR as a separate backend offers a quick route to contract forking, but changes the real-CL
requirement and must not replace existing validator e2e tests. Anvil also cannot be treated as a
ready drop-in Geth replacement for Lighthouse: at the time of review, the
[Engine API in Anvil request #5994](https://github.com/foundry-rs/foundry/issues/5994) was open.
This signals the need for a separate compatibility check, not proof that an adapter works.

**Proposed first phase: 3–5 working days.** Fix the semantics: external EL state, new local
validators, one supported hardfork, real signatures, and forward-only time. Prepare a small, fully
known state fixture and a remote source for it.

1. Reproduce storage reads, changes, and zeroing over a partial trie. Compare each new root with
   ordinary Geth holding the full initial state; include deletion with branch collapse.
2. Check the RPC provider: pinned block hash, code hash, absent account/slot, historical proofs,
   retrieval of missing sibling nodes, timeout/429, and no mixing of blocks.
3. Check Pectra system calls, `eth_call`/estimateGas/real send, proxy/delegatecall, revert, and
   rereading changed values after the next block.
4. If the first checks pass, bind the source EL header to local CL genesis, obtain a valid first
   payload, and check forward-time. Full validator e2e and finality are next-phase criteria;
   successful `eth_call` is no substitute.

After this, the 6–12+ week estimate can be confirmed or revised. If ordinary RPC cannot provide a
sufficient witness for correct updates, choose an extended data source or a shadow fork with a
prepared database. For users who only need contract forking, a separate EDR mode remains the shorter
path, but does not solve real staking e2e.

The MVP also needs a fork manifest without RPC secrets, a cache key based on chain/genesis/block
hash, disk limits, reproducible reset, separate local/upstream logs and receipts, `BLOCKHASH`
handling, a compatible chain ID, and test funding. Contracts bound to chain ID, EIP-712, and
historical Beacon roots require separate fixtures. The currently verified network is limited to
Prague/Electra; newer source blocks require a separate client update and revalidation of the
Lighthouse patch/EngineGate. Support for any network through a single URL is not yet substantiated.
