# Native warp evidence

`direct-sync-{red,green}.log` contains the behavioral regression before and after direct delivery.
The `fixture-build` logs are setup/compiler failures, not behavioral RED results. The immutable bake
also runs the extended test with one validator occupying all 512 sync positions, an actual slot
without elected aggregators, duplicate delivery and a corrupted signature.

`direct-sync-controller-*` and `direct-sync-head-change-*` cover incomplete BN completion, root
binding and a head change after execution agreement. Unit checks do not replace live EL/CL tests.

Live integration evidence is under `reports/profiles/<hardfork>/direct-sync/`. A standalone
`warp-economics.json` is not full profile verification; use that directory's `verification.json`.

## Independent Gloas consensus replay

`upstream-replay.rs` was installed as
`consensus/state_processing/src/bin/panda_replay.rs` in a clean checkout of Lighthouse commit
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`. The checkout had no tracked changes and none of the Panda
patches. Build command inside the pinned Rust builder:

```sh
cargo build --release --locked -p state_processing --bin panda_replay
```

The input directory contains the network `config.yaml`, `pre.ssz`, `post.ssz`, and each
`block-<slot>.ssz` / `envelope-<slot>.ssz`, captured from Beacon API with
`Accept: application/octet-stream`. The fixture starts after 128 ordinary controlled slots, then
records a 64-slot `advanceTime` from the `direct-sync` bake. Run:

```sh
panda_replay <fixture-directory>
```

`direct-sync-replay.json` records input, source and binary hashes and the exact bake key. Fixtures
and the Linux binary remain in ignored `.cache/warp-native/`; third-party sources are not committed.
The positive run verifies signatures and each intermediate state root, then compares the complete
post-state SSZ. The two negative fixtures copy the positive input and replace bytes 4–99 of the
first signed block or envelope with the next object's signature, preserving all other bytes. Both
are rejected by ordinary upstream signature verification; their nonzero exit is expected.

This is independent consensus replay over 64 slots. It does not independently re-execute the EVM,
cover every acceptance scenario or substitute for the real Geth checks in the integration suite.

## Metrics

The `metrics-*.txt` files are raw upstream Prometheus snapshots. The corresponding JSON records
Docker CPU counters, resource limits, bake identity and 32-slot elapsed time after 64 warm-up slots.
Snapshots are taken sequentially before/after the command, so their CPU windows are wider than the
timed command. Compare `honest-v3` with `direct-sync` under the same limits; one pair is not p95.
Full-range results belong to the profile's `warp.json`.
