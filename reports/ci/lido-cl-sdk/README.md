# Lido SDK consensus checks

Local verification on 2026-10-01 against the Lido consumer checkout based on
`c96c893ac67011681f4aa7caf4f7b9e25fa33aef`.

The consumer workflow uses the native Beacon API on port 5052. SDK startup verifies canonical,
non-optimistic CL genesis, controller/native head identity, genesis time, chain ID and Gloas
configuration. Proof captures verify the Gloas block/bid/envelope against canonical EL history.
Finalization waits confirm the Gloas checkpoint's execution parent against EL's finalized block.
Existing SSZ, EIP-4788, signature, contract-revert and fast-warp scenarios remain in place.

Executed:

- TDD red: all seven initial SDK regression groups failed against the old client (`red.log`).
- Focused green: eight SDK groups passed, including malformed/unavailable CL endpoints, optimistic
  or mismatched CL data, canonical payload mismatches and incorrect finalized execution
  (`green.log`).
- `yarn typecheck`: passed.
- `yarn eslint lib/panda/index.ts test/integration/panda/helpers/protocol.ts
  test/integration/panda/verifiers.integration.ts --max-warnings=0`:
  passed.
- Prettier checks for modified consumer files and actionlint for its workflow: passed.
- The regenerated consumer patch applies to a clean temporary index at the documented base.

The SDK regressions use local HTTP fixtures. No Docker, devnet, client compilation or real verifier
suite was run for this change, as requested. The updated 15-scenario integration suite remains to be
executed against real clients in CI. These results do not certify consensus compatibility or real
proof acceptance. Log files preserve command output with trailing whitespace removed.
