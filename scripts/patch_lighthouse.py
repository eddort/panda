"""Maintainer helper: create a minimal, checked patch against Lighthouse v7.1.0."""
from pathlib import Path
import shutil

root = Path('.cache/upstream/lighthouse')

def edit(path, old, new, count=1):
    file = root / path
    text = file.read_text()
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f'{path}: expected {count} occurrences, found {actual}: {old}')
    file.write_text(text.replace(old, new))

edit('common/slot_clock/Cargo.toml', '[dependencies]', '[dependencies]\ntokio = { workspace = true, features = ["time"] }')
edit('common/slot_clock/src/lib.rs', 'pub use crate::system_time_slot_clock::SystemTimeSlotClock;', 'pub use crate::system_time_slot_clock::SystemTimeSlotClock;\npub mod controlled;')
shutil.copyfile('clients/controlled_clock.rs', root / 'common/slot_clock/src/controlled.rs')
p = 'common/slot_clock/src/system_time_slot_clock.rs'
edit(p, 'use std::time::{Duration, SystemTime, UNIX_EPOCH};', 'use std::time::Duration;\n#[cfg(test)]\nuse std::time::{SystemTime, UNIX_EPOCH};')
edit(p, 'SystemTime::now().duration_since(UNIX_EPOCH).ok()', 'crate::controlled::now()', 6)

# These sleeps are protocol schedules. No blanket replacement of runtime/network timers.
for p in ['beacon_node/timer/src/lib.rs', 'beacon_node/beacon_chain/src/proposer_prep_service.rs']:
    edit(p, 'use tokio::time::sleep;', 'use slot_clock::controlled::sleep;')
for p in ['validator_client/validator_services/src/attestation_service.rs', 'validator_client/validator_services/src/sync_committee_service.rs']:
    edit(p, 'use tokio::time::{sleep, sleep_until, Duration, Instant};', 'use slot_clock::controlled::{sleep, sleep_until, instant_now};\nuse tokio::time::{Duration, Instant};')
    file = root / p
    file.write_text(file.read_text().replace('Instant::now()', 'instant_now()'))
edit('beacon_node/beacon_chain/src/state_advance_timer.rs', 'use tokio::time::{sleep, sleep_until, Instant};', 'use slot_clock::controlled::{sleep, sleep_until, instant_now};')
p = root / 'beacon_node/beacon_chain/src/state_advance_timer.rs'
p.write_text(p.read_text().replace('Instant::now()', 'instant_now()'))
edit('validator_client/validator_services/src/duties_service.rs', 'use tokio::{sync::mpsc::Sender, time::sleep};', 'use tokio::sync::mpsc::Sender;\nuse slot_clock::controlled::sleep;')
edit('validator_client/validator_services/src/preparation_service.rs', 'use tokio::time::{sleep, Duration};', 'use slot_clock::controlled::sleep;\nuse tokio::time::Duration;')
# Status polling follows the slot, while each HTTP request keeps its real timeout.
p = root / 'validator_client/beacon_node_fallback/src/lib.rs'
p.write_text(p.read_text().replace('sleep(sleep_time).await', 'slot_clock::controlled::sleep(sleep_time).await'))

# Completion watermarks used by the controller's phase barriers.
edit('beacon_node/timer/src/lib.rs', 'beacon_chain.per_slot_task().await;', 'beacon_chain.per_slot_task().await;\n            if let Ok(slot) = beacon_chain.slot() { slot_clock::controlled::mark("slot", slot.as_u64()); }')
edit('validator_client/validator_services/src/attestation_service.rs', 'drop(attestations_timer);', 'drop(attestations_timer);\n        slot_clock::controlled::mark(&format!("attestations_{}", committee_index), slot.as_u64());')
edit('validator_client/validator_services/src/attestation_service.rs', '            })?;\n        }\n\n        Ok(())\n    }\n\n    /// Performs the first step', '            })?;\n        }\n\n        slot_clock::controlled::mark(&format!("aggregates_{}", committee_index), slot.as_u64());\n        Ok(())\n    }\n\n    /// Performs the first step')
edit('validator_client/validator_services/src/sync_committee_service.rs', '        info!(\n            count = committee_signatures.len(),', '        slot_clock::controlled::mark("sync_messages", slot.as_u64());\n        info!(\n            count = committee_signatures.len(),')
edit('validator_client/validator_services/src/sync_committee_service.rs', '        info!(\n            subnet = %subnet_id,', '        slot_clock::controlled::mark(&format!("sync_aggregate_{}", subnet_id), slot.as_u64());\n        info!(\n            subnet = %subnet_id,')
edit('validator_client/validator_services/src/sync_committee_service.rs', '        let aggregators = slot_duties.aggregators;', '        let aggregators = slot_duties.aggregators;\n        let mask = aggregators.keys().fold(0u64, |mask, subnet| { let index: u64 = (*subnet).into(); mask | (1 << index) });\n        slot_clock::controlled::mark("sync_expected_mask", mask);\n        slot_clock::controlled::mark("sync_expected_slot", slot.as_u64());')
edit('beacon_node/beacon_chain/src/state_advance_timer.rs', '                    is_running.unlock();', '                    is_running.unlock();\n                    slot_clock::controlled::mark("state_advance", current_slot.as_u64());')
edit('beacon_node/beacon_chain/src/state_advance_timer.rs', '                        // Signal block proposal for the next slot', '                        slot_clock::controlled::mark("fork_choice", next_slot.as_u64() - 1);\n                        // Signal block proposal for the next slot')
edit('validator_client/src/lib.rs', '    let now = SystemTime::now()\n        .duration_since(UNIX_EPOCH)\n        .map_err(|e| format!("Unable to read system time: {:?}", e))?;', '    let now = slot_clock::controlled::now().ok_or("Unable to read protocol time")?;')
edit('validator_client/src/lib.rs', '        Ok(())\n    }\n}\n\nasync fn init_from_beacon_node', '        slot_clock::controlled::mark("ready", 0);\n        Ok(())\n    }\n}\n\nasync fn init_from_beacon_node')
edit('validator_client/validator_services/src/duties_service.rs', '                poll_validator_indices(&duties_service).await;', '                poll_validator_indices(&duties_service).await;\n                if let Some(slot) = duties_service.slot_clock.now() { slot_clock::controlled::mark("indices", slot.as_u64()); }')

p = root / 'Cargo.lock'
s = p.read_text()
start = s.index('name = "slot_clock"')
end = s.index('[[package]]', start)
section = s[start:end].replace(' "types",', ' "tokio",\n "types",')
p.write_text(s[:start] + section + s[end:])
