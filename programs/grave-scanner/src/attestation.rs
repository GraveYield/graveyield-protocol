// SPDX-License-Identifier: Apache-2.0
//
// Last-swap attestation (ORACLE-002, Phase 1.2).
//
// Raydium V4's `AmmInfo` stores no last-swap timestamp, and on-chain state
// cannot prove the ABSENCE of swaps over a 90-day window (`SlotHashes`
// covers only ~512 slots). Criterion 1 therefore takes its timestamp from
// a signed attestation produced by the protocol activity indexer, which
// derives the true last-swap time from Raydium V4 transaction history.
//
// Evidence model (spec PROTOCOL_SPEC.md §5, decision D8):
//
//   1. The indexer signs a fixed 112-byte message with the protocol
//      activity oracle key (`ProtocolConfig.activity_oracle`).
//   2. The transaction carries an `ed25519_program` (precompile) verify
//      instruction immediately before the scanner instruction. The
//      runtime cryptographically verifies the signature BEFORE the
//      scanner handler runs.
//   3. The scanner handler validates the precompile's signature-verification
//      offsets: the signed message must be EXACTLY the 112-byte
//      attestation embedded in the scanner instruction data, and the
//      covered public key must equal the configured oracle.
//   4. The attestation binds (amm_program_id, pool_address), carries
//      `last_swap_unix_ts` and an `issued_slot`, and the slot must still
//      resolve in the `SlotHashes` sysvar with a matching hash — replay
//      of a stale attestation therefore dies within the ~512-slot window.
//
// Message layout (fixed, big-endian-free, no borsh — byte offsets are
// normative and mirrored by sdk/src/lastSwapAttestation.ts):
//
//   [  0.. 32)  amm_program_id   (32B)
//   [ 32.. 64)  pool_address     (32B)
//   [ 64.. 72)  last_swap_unix_ts (i64 LE)
//   [ 72.. 80)  issued_slot       (u64 LE)
//   [ 80..112)  slot_hash         (32B — SlotHashes hash of issued_slot)
//
// Scanner instruction data layout (Anchor: 8B discriminator + params):
//
//   [  0..  8)  Anchor discriminator
//   [  8.. 40)  params.amm_program_id
//   [ 40.. 72)  params.pool_address
//   [ 72..184)  params.msg (the 112-byte attestation — the exact bytes
//               covered by the precompile signature)
//
// Precompile instruction data layout (110 bytes):
//
//   [  0.. 14)  Ed25519SignatureOffsets header
//   [ 14.. 78)  Ed25519 signature (64B)
//   [ 78..110)  oracle public key (32B)

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as instructions_sysvar;

use crate::errors::GraveScannerError;

/// Ed25519 signature-verification native program (precompile).
///
/// Hardcoded as the canonical base58 address: solana-program 2.x moved
/// the `ed25519_program` module into a separate crate, and precompile
/// addresses are stable protocol constants.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Length of the canonical attestation message.
pub const ATTESTATION_MSG_LEN: usize = 112;

/// Ed25519SignatureOffsets header length (7 u16 fields).
pub const ED25519_HEADER_LEN: usize = 14;
/// Ed25519 signature length.
pub const ED25519_SIG_LEN: usize = 64;
/// Ed25519 public key length.
pub const ED25519_PK_LEN: usize = 32;

/// Signature-verification-offset instruction index sentinel meaning "the
/// instruction currently being executed by the runtime" (i.e. the
/// precompile instruction itself, where sig + pubkey live).
pub const CUR_INSTRUCTION_INDEX: u16 = 0xFFFF;

// Offsets into the SCANNER instruction data.
/// Start of `params.msg` = 8B discriminator + 32B amm + 32B pool.
pub const IX_DATA_MSG_OFFSET: usize = 8 + 32 + 32;
/// Minimum scanner instruction data length (disc + amm + pool + msg).
pub const IX_DATA_MIN_LEN: usize = IX_DATA_MSG_OFFSET + ATTESTATION_MSG_LEN;

// Offsets into the PRECOMPILE instruction data (canonical 110-byte form).
pub const PRECOMPILE_SIG_OFFSET: usize = ED25519_HEADER_LEN;
pub const PRECOMPILE_PK_OFFSET: usize = ED25519_HEADER_LEN + ED25519_SIG_LEN;
pub const PRECOMPILE_MIN_LEN: usize = ED25519_HEADER_LEN + ED25519_SIG_LEN + ED25519_PK_LEN;

/// Extract the last-swap unix timestamp from a parsed attestation message.
pub fn message_last_swap_unix_ts(msg: &[u8; ATTESTATION_MSG_LEN]) -> i64 {
    i64::from_le_bytes(msg[64..72].try_into().expect("fixed 8-byte slice"))
}

/// Extract the issued slot from a parsed attestation message.
pub fn message_issued_slot(msg: &[u8; ATTESTATION_MSG_LEN]) -> u64 {
    u64::from_le_bytes(msg[72..80].try_into().expect("fixed 8-byte slice"))
}

/// Validate the `ed25519_program` verify instruction that immediately
/// precedes the scanner instruction.
///
/// Checks that the runtime-verified signature:
///   * uses exactly one signature,
///   * keeps sig + pubkey inside the precompile instruction data,
///   * covers the configured oracle public key,
///   * signs EXACTLY the attestation message at
///     `IX_DATA_MSG_OFFSET` inside the scanner instruction data.
///
/// The runtime guarantees the signature itself is valid by the time this
/// runs (the precompile executed earlier in the same transaction and
/// aborts the transaction on failure) — this function only validates the
/// offsets that determine WHAT was signed.
pub fn verify_ed25519_offsets(
    precompile_ix: &anchor_lang::solana_program::instruction::Instruction,
    scanner_ix_index: u16,
    scanner_ix_data: &[u8],
    oracle: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        precompile_ix.program_id,
        ED25519_PROGRAM_ID,
        GraveScannerError::AttestationMissing
    );

    let d = precompile_ix.data.as_slice();
    require!(
        d.len() >= ED25519_HEADER_LEN,
        GraveScannerError::InvalidAttestationOffsets
    );

    let sig_offset = u16::from_le_bytes([d[0], d[1]]) as usize;
    let sig_ix_index = u16::from_le_bytes([d[2], d[3]]);
    let msg_offset = u16::from_le_bytes([d[4], d[5]]) as usize;
    let msg_ix_index = u16::from_le_bytes([d[6], d[7]]);
    let num_signatures = u16::from_le_bytes([d[8], d[9]]);
    let pk_offset = u16::from_le_bytes([d[10], d[11]]) as usize;
    let pk_ix_index = u16::from_le_bytes([d[12], d[13]]);

    // Exactly one signature, sig + pubkey carried inside the precompile
    // instruction data, well-formed and in-bounds. Fail closed on every
    // other shape.
    require!(
        num_signatures == 1,
        GraveScannerError::InvalidAttestationOffsets
    );
    require!(
        sig_ix_index == CUR_INSTRUCTION_INDEX,
        GraveScannerError::InvalidAttestationOffsets
    );
    require!(
        sig_offset >= ED25519_HEADER_LEN
            && sig_offset
                .checked_add(ED25519_SIG_LEN)
                .is_some_and(|end| end <= d.len()),
        GraveScannerError::InvalidAttestationOffsets
    );
    require!(
        pk_ix_index == CUR_INSTRUCTION_INDEX,
        GraveScannerError::InvalidAttestationOffsets
    );
    require!(
        pk_offset >= ED25519_HEADER_LEN
            && pk_offset
                .checked_add(ED25519_PK_LEN)
                .is_some_and(|end| end <= d.len()),
        GraveScannerError::InvalidAttestationOffsets
    );

    // The covered public key MUST be the protocol activity oracle.
    require!(
        &d[pk_offset..pk_offset + ED25519_PK_LEN] == oracle.as_array(),
        GraveScannerError::AttestationOracleMismatch
    );

    // The signed message MUST be exactly the attestation embedded in the
    // scanner instruction data: message index = scanner instruction,
    // message offset = start of params.msg. Anything else means the bytes
    // in `params.msg` are not what the oracle signed.
    require!(
        msg_ix_index == scanner_ix_index,
        GraveScannerError::InvalidAttestationOffsets
    );
    require!(
        msg_offset == IX_DATA_MSG_OFFSET,
        GraveScannerError::InvalidAttestationOffsets
    );
    require!(
        scanner_ix_data.len() >= IX_DATA_MIN_LEN,
        GraveScannerError::InvalidAttestationOffsets
    );

    Ok(())
}

/// Look up `target_slot` in raw `SlotHashes` sysvar data.
///
/// Sysvar layout: u64 LE entry count, then `(slot: u64 LE, hash: [u8;32])`
/// entries (40 bytes each). Returns `Ok(None)` when the slot is not
/// present (aged out of the ~512-entry window) or the sysvar is
/// malformed — both fail closed.
pub fn slot_hash_lookup(slot_hashes_data: &[u8], target_slot: u64) -> Option<[u8; 32]> {
    if slot_hashes_data.len() < 8 {
        return None;
    }
    let count = u64::from_le_bytes(
        slot_hashes_data[0..8]
            .try_into()
            .expect("fixed 8-byte slice"),
    );
    for i in 0..count {
        let base = 8usize.checked_add(i as usize * 40)?;
        if base + 40 > slot_hashes_data.len() {
            return None; // truncated sysvar — fail closed
        }
        let slot = u64::from_le_bytes(
            slot_hashes_data[base..base + 8]
                .try_into()
                .expect("fixed 8-byte slice"),
        );
        if slot == target_slot {
            return Some(
                slot_hashes_data[base + 8..base + 40]
                    .try_into()
                    .expect("fixed 32-byte slice"),
            );
        }
    }
    None
}

/// Validate the attestation message fields against the evaluation context.
///
/// Returns the attested last-swap unix timestamp on success. Checks:
///   * `amm_program_id` / `pool_address` binding to the instruction params,
///   * `0 < last_swap_unix_ts <= now` (no zero sentinel, no future time),
///   * `0 < issued_slot <= now_slot` and still resolvable in `SlotHashes`
///     with a byte-exact hash match.
pub fn verify_attestation_message(
    msg: &[u8; ATTESTATION_MSG_LEN],
    amm_program_id: &Pubkey,
    pool_address: &Pubkey,
    now_unix_ts: i64,
    now_slot: u64,
    slot_hashes_data: &[u8],
) -> Result<i64> {
    require!(
        &msg[0..32] == amm_program_id.as_ref() && &msg[32..64] == pool_address.as_ref(),
        GraveScannerError::AttestationBindingMismatch
    );

    let ts = message_last_swap_unix_ts(msg);
    require!(
        ts > 0 && ts <= now_unix_ts,
        GraveScannerError::AttestationTimestampInvalid
    );

    let issued_slot = message_issued_slot(msg);
    require!(
        issued_slot > 0 && issued_slot <= now_slot,
        GraveScannerError::AttestationSlotInvalid
    );

    let hash = slot_hash_lookup(slot_hashes_data, issued_slot);
    require!(hash.is_some(), GraveScannerError::AttestationStale);
    require!(
        hash == Some(msg[80..112].try_into().expect("fixed 32-byte slice")),
        GraveScannerError::AttestationSlotHashMismatch
    );

    Ok(ts)
}

/// Bundled inputs for the on-chain attestation verification path.
pub struct AttestationRef<'a> {
    /// The 112-byte attestation embedded in the instruction params.
    pub msg: &'a [u8; ATTESTATION_MSG_LEN],
    /// AMM program the evaluation is submitted for.
    pub amm_program_id: &'a Pubkey,
    /// Pool the evaluation is submitted for.
    pub pool_address: &'a Pubkey,
    /// Configured activity oracle (`ProtocolConfig.activity_oracle`).
    pub oracle: &'a Pubkey,
}

/// Full on-chain verification path used by both `evaluate_pool_phase_1`
/// and `evaluate_pool_phase_2`.
///
/// * Locates the `ed25519_program` verify instruction that immediately
///   precedes this instruction (via the instructions sysvar) and validates
///   that its runtime-verified signature covers exactly the 112-byte
///   attestation embedded in this instruction's data, using `oracle` as
///   the public key.
/// * Validates the attested fields and anchors `issued_slot` to the
///   caller-supplied (address-constrained) SlotHashes sysvar account.
///
/// Returns the attested last-swap unix timestamp. Every failure mode is a
/// revert — there is no fallback to caller-supplied values.
pub fn verify_last_swap_attestation(
    instruction_sysvar: &UncheckedAccount,
    slot_hashes: &UncheckedAccount,
    att: AttestationRef<'_>,
    now_unix_ts: i64,
    now_slot: u64,
) -> Result<i64> {
    let sysvar_info = instruction_sysvar.to_account_info();
    let current_index = instructions_sysvar::load_current_index_checked(&sysvar_info)
        .map_err(|_| GraveScannerError::AttestationMissing)?;
    require!(current_index >= 1, GraveScannerError::AttestationMissing);

    let scanner_ix =
        instructions_sysvar::load_instruction_at_checked(current_index as usize, &sysvar_info)
            .map_err(|_| GraveScannerError::AttestationMissing)?;
    let precompile_ix = instructions_sysvar::load_instruction_at_checked(
        (current_index - 1) as usize,
        &sysvar_info,
    )
    .map_err(|_| GraveScannerError::AttestationMissing)?;

    verify_ed25519_offsets(&precompile_ix, current_index, &scanner_ix.data, att.oracle)?;

    let slot_hashes_data = slot_hashes
        .try_borrow_data()
        .map_err(|_| GraveScannerError::AttestationMissing)?;
    verify_attestation_message(
        att.msg,
        att.amm_program_id,
        att.pool_address,
        now_unix_ts,
        now_slot,
        &slot_hashes_data,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::Instruction;

    /// Canonical 110-byte precompile instruction data: header + sig + pk.
    fn build_precompile_data(sig: &[u8; 64], pk: &[u8; 32], msg_ix_index: u16) -> Vec<u8> {
        let mut d = Vec::with_capacity(PRECOMPILE_MIN_LEN);
        d.extend_from_slice(&(PRECOMPILE_SIG_OFFSET as u16).to_le_bytes());
        d.extend_from_slice(&CUR_INSTRUCTION_INDEX.to_le_bytes()); // sig ix
        d.extend_from_slice(&(IX_DATA_MSG_OFFSET as u16).to_le_bytes());
        d.extend_from_slice(&msg_ix_index.to_le_bytes()); // msg ix
        d.extend_from_slice(&1u16.to_le_bytes()); // num signatures
        d.extend_from_slice(&(PRECOMPILE_PK_OFFSET as u16).to_le_bytes());
        d.extend_from_slice(&CUR_INSTRUCTION_INDEX.to_le_bytes()); // pk ix
        d.extend_from_slice(sig);
        d.extend_from_slice(pk);
        d
    }

    /// Canonical scanner instruction data: disc + amm + pool + msg.
    fn build_scanner_data(amm: &Pubkey, pool: &Pubkey, msg: &[u8; 112]) -> Vec<u8> {
        let mut d = Vec::with_capacity(IX_DATA_MIN_LEN);
        d.extend_from_slice(&[0u8; 8]); // anchor discriminator placeholder
        d.extend_from_slice(amm.as_ref());
        d.extend_from_slice(pool.as_ref());
        d.extend_from_slice(msg);
        d
    }

    fn build_msg(amm: &Pubkey, pool: &Pubkey, ts: i64, slot: u64, hash: &[u8; 32]) -> [u8; 112] {
        let mut m = [0u8; 112];
        m[0..32].copy_from_slice(amm.as_ref());
        m[32..64].copy_from_slice(pool.as_ref());
        m[64..72].copy_from_slice(&ts.to_le_bytes());
        m[72..80].copy_from_slice(&slot.to_le_bytes());
        m[80..112].copy_from_slice(hash);
        m
    }

    /// Raw SlotHashes sysvar bytes with two entries.
    fn build_slot_hashes(entries: &[(u64, [u8; 32])]) -> Vec<u8> {
        let mut d = Vec::with_capacity(8 + entries.len() * 40);
        d.extend_from_slice(&(entries.len() as u64).to_le_bytes());
        for (slot, hash) in entries {
            d.extend_from_slice(&slot.to_le_bytes());
            d.extend_from_slice(hash);
        }
        d
    }

    fn ok_ed25519_ix(oracle: &[u8; 32], scanner_ix_index: u16) -> Instruction {
        Instruction {
            program_id: ED25519_PROGRAM_ID,
            accounts: vec![],
            data: build_precompile_data(&[7u8; 64], oracle, scanner_ix_index),
        }
    }

    // ---------------------------------------------------------------
    // Roadmap 1.2 acceptance tests:
    //   * stale pool            -> attestation accepted, C1-satisfying ts
    //   * recently active pool  -> attestation accepted, C1-failing ts
    //   * manipulated timestamp -> every forgery vector rejected
    // ---------------------------------------------------------------

    #[test]
    fn stale_pool_attestation_accepted_with_old_timestamp() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let slot: u64 = 30_000_000;
        let mut hash = [0u8; 32];
        hash[0] = 0xAB;
        // 100 days old — comfortably past the 90-day inactivity window.
        let now_ts: i64 = 1_800_000_000;
        let ts = now_ts - 100 * 24 * 60 * 60;

        let msg = build_msg(&amm, &pool, ts, slot, &hash);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        let ix = ok_ed25519_ix(oracle.as_array(), 1);
        assert!(verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).is_ok());

        let hashes = build_slot_hashes(&[(29_999_000, [1u8; 32]), (slot, hash)]);
        let out =
            verify_attestation_message(&msg, &amm, &pool, now_ts, slot + 10, &hashes).unwrap();
        assert_eq!(out, ts);
    }

    #[test]
    fn recently_active_pool_attestation_accepted_with_fresh_timestamp() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let slot: u64 = 30_000_000;
        let hash = [9u8; 32];
        // Swapped 60 seconds ago — fails the 90-day C1 threshold.
        let now_ts: i64 = 1_800_000_000;
        let ts = now_ts - 60;

        let msg = build_msg(&amm, &pool, ts, slot, &hash);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        let ix = ok_ed25519_ix(oracle.as_array(), 1);
        assert!(verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).is_ok());

        let hashes = build_slot_hashes(&[(slot, hash)]);
        let out = verify_attestation_message(&msg, &amm, &pool, now_ts, slot, &hashes).unwrap();
        assert_eq!(out, ts);
    }

    #[test]
    fn manipulated_timestamp_fails_offset_validation_wrong_oracle() {
        let oracle = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        // Sig covers the ATTACKER's key, not the configured oracle.
        let ix = ok_ed25519_ix(attacker.as_array(), 1);
        let err = verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).unwrap_err();
        assert_eq!(err, GraveScannerError::AttestationOracleMismatch.into());
    }

    #[test]
    fn manipulated_timestamp_fails_when_signed_message_is_not_params_msg() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        // msg_offset moved off the canonical 72 — the runtime would sign
        // different bytes than the ones carried in params.msg.
        let mut bad_header = build_precompile_data(&[7u8; 64], oracle.as_array(), 1);
        bad_header[4..6].copy_from_slice(&40u16.to_le_bytes()); // msg_offset
        let ix = Instruction {
            program_id: ED25519_PROGRAM_ID,
            accounts: vec![],
            data: bad_header,
        };
        let err = verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).unwrap_err();
        assert_eq!(err, GraveScannerError::InvalidAttestationOffsets.into());
    }

    #[test]
    fn manipulated_timestamp_fails_on_binding_mismatch() {
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let other_pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let hashes = build_slot_hashes(&[(30_000_000, [0u8; 32])]);
        // Attestation binds `pool`, but is submitted for `other_pool`.
        let err =
            verify_attestation_message(&msg, &amm, &other_pool, 1_800_000_000, 30_000_100, &hashes)
                .unwrap_err();
        assert_eq!(err, GraveScannerError::AttestationBindingMismatch.into());
    }

    #[test]
    fn manipulated_timestamp_rejects_zero_and_future_timestamps() {
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let now: i64 = 1_800_000_000;
        let hashes = build_slot_hashes(&[(30_000_000, [0u8; 32])]);

        // Zero sentinel (the old V4 adapter value) — rejected.
        let zero = build_msg(&amm, &pool, 0, 30_000_000, &[0u8; 32]);
        assert_eq!(
            verify_attestation_message(&zero, &amm, &pool, now, 30_000_100, &hashes).unwrap_err(),
            GraveScannerError::AttestationTimestampInvalid.into()
        );

        // Future timestamp — rejected.
        let future = build_msg(&amm, &pool, now + 1, 30_000_000, &[0u8; 32]);
        assert_eq!(
            verify_attestation_message(&future, &amm, &pool, now, 30_000_100, &hashes).unwrap_err(),
            GraveScannerError::AttestationTimestampInvalid.into()
        );
    }

    #[test]
    fn manipulated_timestamp_rejects_future_and_zero_issued_slots() {
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let now: i64 = 1_800_000_000;
        let now_slot: u64 = 30_000_100;
        let hashes = build_slot_hashes(&[(30_000_000, [0u8; 32])]);

        let future_slot = build_msg(&amm, &pool, 1_700_000_000, now_slot + 1, &[0u8; 32]);
        assert_eq!(
            verify_attestation_message(&future_slot, &amm, &pool, now, now_slot, &hashes)
                .unwrap_err(),
            GraveScannerError::AttestationSlotInvalid.into()
        );

        let zero_slot = build_msg(&amm, &pool, 1_700_000_000, 0, &[0u8; 32]);
        assert_eq!(
            verify_attestation_message(&zero_slot, &amm, &pool, now, now_slot, &hashes)
                .unwrap_err(),
            GraveScannerError::AttestationSlotInvalid.into()
        );
    }

    #[test]
    fn stale_attestation_rejected_once_slot_ages_out_of_window() {
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let hash = [3u8; 32];
        // Attestation claims slot 30_000_000; SlotHashes now only covers
        // 30_010_000+ — the replay died with the window.
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &hash);
        let hashes = build_slot_hashes(&[(30_010_000, hash), (30_010_500, [4u8; 32])]);
        assert_eq!(
            verify_attestation_message(&msg, &amm, &pool, 1_800_000_000, 30_010_500, &hashes)
                .unwrap_err(),
            GraveScannerError::AttestationStale.into()
        );
    }

    #[test]
    fn slot_hash_mismatch_rejected() {
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        // Message carries hash X for its slot; chain has hash Y.
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[1u8; 32]);
        let hashes = build_slot_hashes(&[(30_000_000, [2u8; 32])]);
        assert_eq!(
            verify_attestation_message(&msg, &amm, &pool, 1_800_000_000, 30_000_100, &hashes)
                .unwrap_err(),
            GraveScannerError::AttestationSlotHashMismatch.into()
        );
    }

    #[test]
    fn non_ed25519_preceding_instruction_is_missing_attestation() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        let not_precompile = Instruction {
            program_id: Pubkey::new_unique(),
            accounts: vec![],
            data: build_precompile_data(&[7u8; 64], oracle.as_array(), 1),
        };
        assert_eq!(
            verify_ed25519_offsets(&not_precompile, 1, &scanner_data, &oracle).unwrap_err(),
            GraveScannerError::AttestationMissing.into()
        );
    }

    #[test]
    fn multi_signature_precompile_rejected() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        let mut d = build_precompile_data(&[7u8; 64], oracle.as_array(), 1);
        d[8..10].copy_from_slice(&2u16.to_le_bytes()); // num_signatures = 2
        let ix = Instruction {
            program_id: ED25519_PROGRAM_ID,
            accounts: vec![],
            data: d,
        };
        assert_eq!(
            verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).unwrap_err(),
            GraveScannerError::InvalidAttestationOffsets.into()
        );
    }

    #[test]
    fn message_pointing_at_another_instruction_rejected() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let scanner_data = build_scanner_data(&amm, &pool, &msg);
        // Signed message claims instruction #2 but scanner runs at #1.
        let ix = ok_ed25519_ix(oracle.as_array(), 2);
        assert_eq!(
            verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).unwrap_err(),
            GraveScannerError::InvalidAttestationOffsets.into()
        );
    }

    #[test]
    fn truncated_scanner_instruction_data_rejected() {
        let oracle = Pubkey::new_unique();
        let amm = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let msg = build_msg(&amm, &pool, 1_700_000_000, 30_000_000, &[0u8; 32]);
        let mut scanner_data = build_scanner_data(&amm, &pool, &msg);
        scanner_data.truncate(IX_DATA_MIN_LEN - 1);
        let ix = ok_ed25519_ix(oracle.as_array(), 1);
        assert_eq!(
            verify_ed25519_offsets(&ix, 1, &scanner_data, &oracle).unwrap_err(),
            GraveScannerError::InvalidAttestationOffsets.into()
        );
    }

    #[test]
    fn slot_hashes_lookup_finds_entry_and_fails_closed_on_malformed_data() {
        let hash = [5u8; 32];
        let entries = [(100u64, hash), (200u64, [6u8; 32])];
        let data = build_slot_hashes(&entries);
        assert_eq!(slot_hash_lookup(&data, 100), Some(hash));
        assert_eq!(slot_hash_lookup(&data, 200), Some([6u8; 32]));
        assert_eq!(slot_hash_lookup(&data, 300), None);

        // Malformed / truncated sysvar data — fail closed.
        assert_eq!(slot_hash_lookup(&[], 100), None);
        assert_eq!(slot_hash_lookup(&[1, 0, 0], 100), None);
        let mut truncated = build_slot_hashes(&entries);
        truncated.truncate(8 + 40 + 20); // second entry cut in half
        assert_eq!(slot_hash_lookup(&truncated, 200), None);
    }

    #[test]
    fn canonical_layout_constants_are_stable() {
        // The offsets are a wire format shared with sdk/src/lastSwapAttestation.ts.
        assert_eq!(ATTESTATION_MSG_LEN, 112);
        assert_eq!(IX_DATA_MSG_OFFSET, 72);
        assert_eq!(IX_DATA_MIN_LEN, 184);
        assert_eq!(PRECOMPILE_SIG_OFFSET, 14);
        assert_eq!(PRECOMPILE_PK_OFFSET, 78);
        assert_eq!(PRECOMPILE_MIN_LEN, 110);
        assert_eq!(ED25519_HEADER_LEN, 14);
        assert_eq!(CUR_INSTRUCTION_INDEX, 0xFFFF);
    }
}
