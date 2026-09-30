//! Equivalent PTC rejection sampling: cache candidate balances and consume all 16
//! random u16 values from each SHA-256 digest before hashing the next counter.
use ethereum_hashing::hash_fixed;

pub fn order(indices: &[usize], seed: &[u8], rounds: u8, shuffle: bool) -> Option<Vec<usize>> {
    if shuffle {
        if seed.len() != 32 { return None; }
        swap_or_not_shuffle::shuffle_list(indices.to_vec(), rounds, seed, false)
    } else {
        Some(indices.to_vec())
    }
}

pub fn select(candidates: &[(usize, u64)], seed: &[u8], size: usize) -> Option<Vec<usize>> {
    if candidates.is_empty() { return None; }
    let mut preimage = seed.to_vec();
    preimage.extend_from_slice(&[0; 8]);
    let mut counter = 0u64;
    let mut candidate = 0usize;
    let mut selected = Vec::with_capacity(size);
    while selected.len() < size {
        preimage.get_mut(seed.len()..)?.copy_from_slice(&counter.to_le_bytes());
        let random = hash_fixed(&preimage);
        for bytes in random.chunks_exact(2) {
            let (index, threshold) = *candidates.get(candidate)?;
            let value = u16::from_le_bytes([bytes[0], bytes[1]]) as u64;
            if value <= threshold {
                selected.push(index);
                if selected.len() == size { break; }
            }
            candidate += 1;
            if candidate == candidates.len() { candidate = 0; }
        }
        counter = counter.checked_add(1)?;
    }
    Some(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Intentionally retains upstream's per-candidate hash and multiplication.
    fn reference(indices: &[usize], balances: &[u64], seed: &[u8], size: usize, max: u64, shuffle: bool) -> Vec<usize> {
        let mut output = Vec::new();
        let mut i = 0usize;
        while output.len() < size {
            let position = if shuffle { swap_or_not_shuffle::compute_shuffled_index(i % indices.len(), indices.len(), seed, 90).unwrap() } else { i % indices.len() };
            let index = indices[position];
            let mut preimage = seed.to_vec();
            preimage.extend_from_slice(&((i / 16) as u64).to_le_bytes());
            let digest = hash_fixed(&preimage);
            let offset = (i % 16) * 2;
            let random = u16::from_le_bytes([digest[offset], digest[offset + 1]]) as u64;
            if balances[index] * 65535 >= max * random { output.push(index); }
            i += 1;
        }
        output
    }

    #[test]
    fn identical_to_upstream_with_rejections_repeats_and_non_divisible_committees() {
        let max = 2_048_000_000_000u64;
        for seed_byte in [0, 1, 71, 255] {
            let seed = [seed_byte; 32];
            for balances in [vec![32_000_000_000; 7], vec![0, 1_000_000_000, 31_000_000_000, 32_000_000_000, 63_000_000_000, 2_047_000_000_000, max]] {
                for indices in [vec![0, 1], vec![6, 4, 2], vec![3, 6, 1, 5, 0, 4, 2]] {
                    let candidates: Vec<_> = indices.iter().map(|&i| (i, balances[i] * 65535 / max)).collect();
                    for size in [0, 1, 17, 512] {
                        assert_eq!(select(&candidates, &seed, size).unwrap(), reference(&indices, &balances, &seed, size, max, false));
                    }
                }
            }
        }
    }

    #[test]
    fn batched_shuffling_and_selection_match_individual_upstream_shuffles() {
        let max = 2_048_000_000_000u64;
        for seed_byte in [0, 77, 255] {
            let seed = [seed_byte; 32];
            for length in [2, 7, 64, 256] {
                let indices: Vec<_> = (0..length).rev().collect();
                let balances: Vec<_> = (0..length).map(|i| if i % 3 == 0 { max } else { 32_000_000_000 }).collect();
                let ordered = order(&indices, &seed, 90, true).unwrap();
                for i in 0..length {
                    assert_eq!(ordered[i], indices[swap_or_not_shuffle::compute_shuffled_index(i, length, &seed, 90).unwrap()]);
                }
                let candidates: Vec<_> = ordered.iter().map(|&i| (i, balances[i] * 65535 / max)).collect();
                for size in [1, 32, 512] {
                    assert_eq!(select(&candidates, &seed, size).unwrap(), reference(&indices, &balances, &seed, size, max, true));
                }
            }
        }
    }
}
