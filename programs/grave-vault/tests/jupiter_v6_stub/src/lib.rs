// SPDX-License-Identifier: Apache-2.0
//
// jupiter_v6_stub — TEST-ONLY Jupiter v6 stand-in for the Phase 3 fork
// harness (programs/grave-vault/tests/jupiter_conversion_fork.rs).
//
// WHY A STUB (and why that is sound): the vault's Jupiter CPI treats the
// aggregator as an opaque program — `cpi/jupiter.rs` forwards the salvor's
// route data and route accounts VERBATIM, marks `vault_authority` as the
// signer, and enforces every security property with vault-owned pre- and
// post-conditions (route-account vetting, the slippage ceiling on the
// floor, the swap-leg output floor). The vault assumes NOTHING about route
// internals, so the harness contract only needs a callee that (a) lives at
// the pinned Jupiter v6 program id, (b) executes a REAL swap through REAL
// deployed AMM bytecode, and (c) can fail deterministically. This stub does
// exactly that: it CPIs a genuine Raydium V4 `swapBaseIn` (tag 11) against
// the same byte-for-byte mainnet pool state the withdraw leg uses, signed
// through the CPI signer-privilege chain (the vault signed
// `vault_authority`; signer privilege propagates into nested CPIs).
//
// It is NEVER deployed anywhere; it exists only inside the in-process VM.
// The account contract below mirrors a single-hop Jupiter route layout
// (6-account route prefix + the Raydium V4 program + the 18 swapBaseIn
// accounts, with the standard aggregator duplicates).
//
// Error codes (test-local; the vault maps any callee failure to
// `JupiterSwapFailed` 7016):
//   6001 wrong route data length
//   6002 wrong route discriminator
//   6003 simulated aggregator failure (fail_mode = 1)
//   6004 wrong account count
//   6005 missing user_transfer_authority signature
//   6006 simulated aggregator slippage failure (delta < min_out)

// Solana macro hygiene: the entrypoint! expansion emits cfg tags the
// consuming crate must declare (mirrors grave-vault/src/lib.rs).
#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    hash::hash,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// The REAL Jupiter v6 mainnet program id — the vault address-pins this
// constant, so the stub must deploy under it for the CPI to resolve.
solana_program::declare_id!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Raydium V4 `SwapBaseIn` instruction tag; data =
/// [tag u8][amount_in u64 LE][min_amount_out u64 LE] = 17 bytes.
/// NOTE: in the deployed program tag 9 = SwapBaseIn and tag 11 =
/// SwapBaseOut (raydium-amm instruction.rs unpack) — verified empirically
/// by this harness against the real mainnet ELF.
const V4_SWAP_BASE_IN_TAG: u8 = 9;

/// SPL token account `amount` field offset (165-byte classic layout).
const TA_AMOUNT: usize = 64;

entrypoint!(process_instruction);

fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // ---- route data: [disc 8][in_amount u64][min_out u64][fail_mode u8]
    if data.len() != 25 {
        msg!("jupiter_v6_stub: bad route data length {}", data.len());
        return Err(ProgramError::Custom(6001));
    }
    let expected_disc = hash(b"global:route");
    if data[..8] != expected_disc.to_bytes()[..8] {
        msg!("jupiter_v6_stub: wrong route discriminator");
        return Err(ProgramError::Custom(6002));
    }
    let in_amount = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let min_out = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let fail_mode = data[24];
    if fail_mode == 1 {
        msg!("jupiter_v6_stub: simulated aggregator failure");
        return Err(ProgramError::Custom(6003));
    }

    // ---- account contract (25 accounts):
    //   0  token_program                          (readonly)
    //   1  user_transfer_authority                (SIGNER — vault_authority)
    //   2  user_source_token_account              (mut)
    //   3  user_destination_token_account         (mut)
    //   4  destination_token_account              (mut, unused)
    //   5  destination_mint                       (readonly, unused)
    //   6  raydium_v4_program                     (readonly — CPI callee)
    //   7..25 = Raydium V4 swapBaseIn accounts in the V4 wire order:
    //     7  token_program (duplicate)            (readonly)
    //     8  amm                                  (mut)
    //     9  amm_authority                        (readonly)
    //    10  amm_open_orders                      (mut)
    //    11  amm_target_orders                    (mut)
    //    12  coin_vault                           (mut)
    //    13  pc_vault                             (mut)
    //    14  market_program                       (readonly)
    //    15  market                               (mut)
    //    16  market_bids                          (mut)
    //    17  market_asks                          (mut)
    //    18  market_event_queue                   (mut)
    //    19  market_coin_vault                    (mut)
    //    20  market_pc_vault                      (mut)
    //    21  market_vault_signer                  (readonly)
    //    22  user_source_token_account (dup)      (mut)
    //    23  user_destination_token_account (dup) (mut)
    //    24  user_owner (= user_transfer_authority, SIGNER, readonly)
    if accounts.len() != 25 {
        msg!("jupiter_v6_stub: wrong account count {}", accounts.len());
        return Err(ProgramError::Custom(6004));
    }
    if !accounts[1].is_signer {
        msg!("jupiter_v6_stub: user_transfer_authority did not sign");
        return Err(ProgramError::Custom(
            6005, // missing user_transfer_authority signature
        ));
    }

    // Snapshot the destination balance BEFORE the swap for the
    // aggregator-style min-out check.
    let dest_pre: u64 = {
        let d = accounts[3].try_borrow_data()?;
        u64::from_le_bytes(d[TA_AMOUNT..TA_AMOUNT + 8].try_into().unwrap())
    };

    // ---- CPI: real Raydium V4 swapBaseIn against real mainnet state.
    // The signer privilege for `user_owner` (== `vault_authority`, signed by
    // the vault's invoke_signed) propagates down the CPI chain — the stub
    // holds no seeds and needs none.
    let mut data_v4 = Vec::with_capacity(17);
    data_v4.push(V4_SWAP_BASE_IN_TAG);
    data_v4.extend_from_slice(&in_amount.to_le_bytes());
    data_v4.extend_from_slice(&min_out.to_le_bytes());
    let ix =
        Instruction::new_with_bytes(*accounts[6].key, &data_v4, v4_swap_metas(&accounts[7..25]));
    // invoke() resolves accounts by key; the list must contain every meta
    // account, the callee program (index 6), and no duplicates issues.
    let mut infos: Vec<AccountInfo> = Vec::with_capacity(20);
    infos.push(accounts[6].clone());
    for a in &accounts[7..25] {
        infos.push(a.clone());
    }
    msg!("jupiter_v6_stub: swapping {} into V4 swapBaseIn", in_amount);
    invoke(&ix, &infos)?;

    // ---- aggregator-style min-out enforcement on the actual delta.
    let dest_post: u64 = {
        let d = accounts[3].try_borrow_data()?;
        u64::from_le_bytes(d[TA_AMOUNT..TA_AMOUNT + 8].try_into().unwrap())
    };
    let delta = dest_post.saturating_sub(dest_pre);
    if delta < min_out {
        msg!(
            "jupiter_v6_stub: output {} below min_out {}",
            delta,
            min_out
        );
        return Err(ProgramError::Custom(6006)); // output below min_out
    }
    msg!("jupiter_v6_stub: swap delivered {}", delta);
    Ok(())
}

/// Build the V4 swapBaseIn CPI metas for stub accounts 7..25 (18 entries),
/// in wire order with the writability documented in the contract comment.
/// `user_owner` (last) is declared a SIGNER: the vault signed
/// `vault_authority` in its own invoke_signed, and signer privilege
/// propagates into nested CPIs as long as the meta declares it.
fn v4_swap_metas(v4_accounts: &[AccountInfo]) -> Vec<AccountMeta> {
    let writable = [
        false, // 0  token_program (dup)
        true,  // 1  amm
        false, // 2  amm_authority
        true,  // 3  amm_open_orders
        true,  // 4  amm_target_orders
        true,  // 5  coin_vault
        true,  // 6  pc_vault
        false, // 7  market_program
        true,  // 8  market
        true,  // 9  market_bids
        true,  // 10 market_asks
        true,  // 11 market_event_queue
        true,  // 12 market_coin_vault
        true,  // 13 market_pc_vault
        false, // 14 market_vault_signer
        true,  // 15 user_source (dup)
        true,  // 16 user_destination (dup)
        false, // 17 user_owner (SIGNER via privilege propagation, readonly)
    ];
    assert_eq!(v4_accounts.len(), writable.len());
    v4_accounts
        .iter()
        .zip(writable.iter())
        .enumerate()
        .map(|(i, (a, w))| {
            let is_signer = i == 17; // user_owner only
            if *w {
                AccountMeta::new(*a.key, is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, is_signer)
            }
        })
        .collect()
}
