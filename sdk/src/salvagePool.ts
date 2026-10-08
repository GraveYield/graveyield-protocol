// SPDX-License-Identifier: Apache-2.0
//
// salvage_pool instruction builder — the most complex instruction in
// the GraveVault surface. It composes:
//
//   * 4 named Anchor accounts (config, eligibility_cert, pool_registry,
//     salvage_receipt) — both `init` PDA defences live here.
//   * 5 PDAs (lp_holder_pool_vault, protocol_treasury, vault_authority,
//     vault_sol_holding_account) — derived from the vault program ID
//     and the pool address.
//   * 4 token-program accounts (salvor_lp_token_account,
//     vault_base_token_account (WSOL), vault_memecoin_token_account,
//     lp_mint, memecoin_mint, wsol_mint).
//   * 3 program accounts (token_program, associated_token_program,
//     system_program).
//   * The salvor signer + pool + amm_program + jupiter_program.
//   * 13 Raydium V4 `remaining_accounts` (the OpenBook market + pool
//     internals) followed by N Jupiter route accounts.
//
// The salvor is responsible for supplying the Raydium V4
// remaining_accounts (from the pool's OpenBook market) and the Jupiter
// route (from Jupiter's quote API). The SDK builder accepts both as
// raw arrays so the salvor bot has full control over the route shape.
//
// This builder is intentionally separated from `instructions.ts`
// because its account count is high and its parameter shape (Vec<u8>
// for the Jupiter route data) needs the `vec` borsh helper.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { writer } from "./borsh.js";
import { VaultIx } from "./discriminators.js";
import {
  vaultProtocolConfigPda,
  poolRegistryPda,
  salvageReceiptPda,
  lpHolderPoolVaultPda,
  protocolTreasuryPda,
  vaultAuthorityPda,
  vaultSolHoldingPda,
  eligibilityCertPda,
} from "./pdas.js";
import {
  WSOL_MINT,
  RAYDIUM_V4_AMM_AUTHORITY,
  JUPITER_V6_PROGRAM_ID,
} from "./raydiumV4Constants.js";

/**
 * Inputs to `buildSalvagePoolIx`. The salvor computes these off-chain:
 *
 *   - `lpSnapshotMerkleRoot` from `snapshotLpHolders(...).tree.root()`
 *   - `lpTotalSupplyAtSnapshot` from the same snapshot's `totalSupply`
 *   - `minQuoteOutputLamports` from Jupiter's quote ± slippage tolerance
 *   - `salvorLpAmount` from the salvor's LP token account balance
 *   - `jupiterRouteData` from Jupiter v6's quote API (verbatim route bytes)
 *   - `jupiterRouteAccounts` (the N accounts the route references)
 *   - `raydiumV4RemainingAccounts` (13 OpenBook market + pool internals)
 *   - `maxSlippageBpsOverride` to tighten below the config default
 */
export interface SalvagePoolIxInput {
  vaultProgramId: PublicKey;
  scannerProgramId: PublicKey;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  salvor: PublicKey;

  /** Salvor's source LP token account (authority = salvor). */
  salvorLpTokenAccount: PublicKey;
  /** Pool's LP mint. */
  lpMint: PublicKey;
  /** Pool's memecoin (non-WSOL) mint. */
  memecoinMint: PublicKey;

  /** Off-chain LP-holder snapshot Merkle root — `SnapshotMerkleTree.root()`. */
  lpSnapshotMerkleRoot: Uint8Array;
  /** Total LP supply at snapshot — pinned against live lp_mint.supply on chain. */
  lpTotalSupplyAtSnapshot: number | bigint;
  /** Salvor LP amount to burn (must equal salvor_lp_token_account.amount). */
  salvorLpAmount: number | bigint;
  /** Slippage floor on the Jupiter swap leg (lamports of WSOL). */
  minQuoteOutputLamports: number | bigint;
  /** Optional per-tx slippage override (in bps). Tightens below config default. */
  maxSlippageBpsOverride?: number | null;

  /** Jupiter v6 route instruction data (verbatim from Jupiter's quote API). */
  jupiterRouteData: Uint8Array;
  /** Number of Jupiter route accounts (first N entries in `jupiterRouteAccounts`). */
  jupiterRouteAccountsLen: number;
  /** The Raydium V4 13 remaining_accounts (OpenBook market + pool internals). */
  raydiumV4RemainingAccounts: ReadonlyArray<AccountMeta>;
  /** The Jupiter route accounts (N entries — `jupiterRouteAccountsLen` of these are used). */
  jupiterRouteAccounts: ReadonlyArray<AccountMeta>;
}

/**
 * Build the salvage_pool instruction. The salvor assembles this with the
 * (phase_2 evaluate) instruction for the certify-and-salvage bundle —
 * see `certifyAndSalvage.ts`.
 *
 * The `eligibility_cert` PDA is the GraveScanner cert PDA (derived under
 * the SCANNER program ID, not the vault — `seeds::program = grave_scanner::ID`
 * in the on-chain `Accounts` struct).
 */
export function buildSalvagePoolIx(opts: SalvagePoolIxInput): TransactionInstruction {
  if (opts.lpSnapshotMerkleRoot.length !== 32) {
    throw new Error(`lpSnapshotMerkleRoot must be 32 bytes (got ${opts.lpSnapshotMerkleRoot.length})`);
  }
  if (opts.raydiumV4RemainingAccounts.length !== 13) {
    throw new Error(
      `raydiumV4RemainingAccounts must have exactly 13 entries (got ${opts.raydiumV4RemainingAccounts.length})`,
    );
  }
  // borsh payload: disc(8) + amm(32) + pool(32) + root(32) + supply(8) + min_out(8) +
  // salvor_lp_amount(8) + vec<u8>(4 + n) + option<u16>(1 + 2) + jupiter_route_accounts_len(1)
  const routeDataLen = opts.jupiterRouteData.length;
  const dataSize =
    8 + 32 + 32 + 32 + 8 + 8 + 8 + (4 + routeDataLen) + (opts.maxSlippageBpsOverride != null ? 3 : 1) + 1;
  const w = writer(dataSize)
    .bytes(VaultIx.salvagePool)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(opts.lpSnapshotMerkleRoot)
    .u64(opts.lpTotalSupplyAtSnapshot)
    .u64(opts.minQuoteOutputLamports)
    .u64(opts.salvorLpAmount)
    .vec(Array.from(opts.jupiterRouteData), (ww, b) => ww.u8(b))
    .option(opts.maxSlippageBpsOverride ?? null, (ww, v) => ww.u16(v))
    .u8(opts.jupiterRouteAccountsLen);
  const dataBytes = w.done();

  // --- Derive all the PDAs ---
  const vaultAuthority = vaultAuthorityPda(opts.vaultProgramId);
  const protocolTreasury = protocolTreasuryPda(opts.vaultProgramId);
  const eligibilityCert = eligibilityCertPda(opts.scannerProgramId, opts.ammProgramId, opts.poolAddress);
  const vaultBaseTokenAccount = getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthority, true);
  const vaultMemecoinTokenAccount = getAssociatedTokenAddressSync(opts.memecoinMint, vaultAuthority, true);

  // --- Named Anchor accounts (order matters — see `Accounts` struct in salvage_pool.rs) ---
  const keys: AccountMeta[] = [
    { pubkey: vaultProtocolConfigPda(opts.vaultProgramId), isSigner: false, isWritable: false },
    { pubkey: eligibilityCert, isSigner: false, isWritable: false },
    { pubkey: poolRegistryPda(opts.vaultProgramId, opts.poolAddress), isSigner: false, isWritable: true },
    { pubkey: salvageReceiptPda(opts.vaultProgramId, opts.poolAddress), isSigner: false, isWritable: true },
    { pubkey: lpHolderPoolVaultPda(opts.vaultProgramId, opts.poolAddress), isSigner: false, isWritable: true },
    { pubkey: protocolTreasury, isSigner: false, isWritable: true },
    { pubkey: opts.salvor, isSigner: true, isWritable: true },
    { pubkey: opts.poolAddress, isSigner: false, isWritable: true },
    { pubkey: opts.ammProgramId, isSigner: false, isWritable: false },
    { pubkey: JUPITER_V6_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultAuthority, isSigner: false, isWritable: true },
    { pubkey: vaultSolHoldingPda(opts.vaultProgramId, opts.poolAddress), isSigner: false, isWritable: true },
    { pubkey: opts.salvorLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: vaultBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: vaultMemecoinTokenAccount, isSigner: false, isWritable: true },
    { pubkey: opts.lpMint, isSigner: false, isWritable: true },
    { pubkey: opts.memecoinMint, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  // --- remaining_accounts: 13 Raydium V4 accounts + N Jupiter route accounts ---
  for (const m of opts.raydiumV4RemainingAccounts) {
    keys.push({ ...m });
  }
  for (let i = 0; i < opts.jupiterRouteAccountsLen; i++) {
    const m = opts.jupiterRouteAccounts[i];
    if (!m) throw new Error(`jupiterRouteAccounts[${i}] missing — needed ${opts.jupiterRouteAccountsLen}`);
    keys.push({ ...m });
  }

  return new TransactionInstruction({
    programId: opts.vaultProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}

/** Helper: produce the 13 Raydium V4 remaining_accounts in the canonical order (ra_idx). */
export function raydiumV4RemainingAccounts(
  pool: {
    coinVault: PublicKey;
    pcVault: PublicKey;
  },
  openBook: {
    ammOpenOrders: PublicKey;
    ammTargetOrders: PublicKey;
    marketProgram: PublicKey;
    market: PublicKey;
    marketCoinVault: PublicKey;
    marketPcVault: PublicKey;
    marketVaultSigner: PublicKey;
    marketEventQueue: PublicKey;
    marketBids: PublicKey;
    marketAsks: PublicKey;
  },
): AccountMeta[] {
  // ra_idx (see programs/grave-vault/src/cpi/raydium_v4.rs):
  //   0: AMM_AUTHORITY     = RAYDIUM_V4_AMM_AUTHORITY (read-only PDA)
  //   1: AMM_OPEN_ORDERS   = openBook.ammOpenOrders (writable)
  //   2: AMM_TARGET_ORDERS = openBook.ammTargetOrders (writable)
  //   3: AMM_COIN_VAULT    = pool.coinVault (writable — reserve balance changes)
  //   4: AMM_PC_VAULT      = pool.pcVault (writable — reserve balance changes)
  //   5: MARKET_PROGRAM    = openBook.marketProgram (read-only program)
  //   6: MARKET            = openBook.market (writable)
  //   7: MARKET_COIN_VAULT = openBook.marketCoinVault (writable)
  //   8: MARKET_PC_VAULT   = openBook.marketPcVault (writable)
  //   9: MARKET_VAULT_SIGNER = openBook.marketVaultSigner (read-only PDA)
  //  10: MARKET_EVENT_QUEUE = openBook.marketEventQueue (writable)
  //  11: MARKET_BIDS        = openBook.marketBids (writable)
  //  12: MARKET_ASKS        = openBook.marketAsks (writable)
  return [
    { pubkey: RAYDIUM_V4_AMM_AUTHORITY, isSigner: false, isWritable: false }, // AMM_AUTHORITY
    { pubkey: openBook.ammOpenOrders, isSigner: false, isWritable: true },
    { pubkey: openBook.ammTargetOrders, isSigner: false, isWritable: true },
    { pubkey: pool.coinVault, isSigner: false, isWritable: true },
    { pubkey: pool.pcVault, isSigner: false, isWritable: true },
    { pubkey: openBook.marketProgram, isSigner: false, isWritable: false },
    { pubkey: openBook.market, isSigner: false, isWritable: true },
    { pubkey: openBook.marketCoinVault, isSigner: false, isWritable: true },
    { pubkey: openBook.marketPcVault, isSigner: false, isWritable: true },
    { pubkey: openBook.marketVaultSigner, isSigner: false, isWritable: false },
    { pubkey: openBook.marketEventQueue, isSigner: false, isWritable: true },
    { pubkey: openBook.marketBids, isSigner: false, isWritable: true },
    { pubkey: openBook.marketAsks, isSigner: false, isWritable: true },
  ];
}
