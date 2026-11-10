// SPDX-License-Identifier: Apache-2.0
//
// ns3_identities.mjs — the single NS-3 identity constant module.
//
// Owner-generated, owner-held NS-3 identities (DR-002; provided by the
// owner, verified as canonical base58 ed25519 public keys). These are
// PUBLIC keys only — no private key material exists in this repository,
// and none may ever be committed, requested, or handled by tooling here.
//
// Deployment status: PENDING. These identities are assigned but NOT yet
// deployed or initialized on devnet. Until the owner executes the NS-3
// deployment (docs/DEVNET.md NS-3 record) nothing on chain answers at
// these addresses.
//
// Sources of truth:
//   - programs/grave-scanner/src/lib.rs  declare_id!
//   - programs/grave-vault/src/lib.rs    declare_id!
//   - Anchor.toml [programs.*]
//   - scripts/devnet/deploy_devnet.sh    EXPECTED_*
//   - scripts/devnet/protocol_admin.mjs  SCANNER_/VAULT_PROGRAM_ID
//   - sdk/src/client.ts                  DEVNET_*_PROGRAM_ID
//   - indexer/src/config.ts, ops/src/config.ts
// Consistency of ALL of the above is asserted by test/ns3_sync.test.mjs.
import { PublicKey } from "@solana/web3.js";

export const NS3 = {
  /** Deployer / fee payer / initial upgrade authority for both programs. */
  deployer: "cfJKAzSpYhoKheLWzx7miTHp6HCt46E3oeU3CBo4831",
  /** GraveScanner program ID (owner-held program keypair — NOT an authority). */
  scannerProgramId: "EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL",
  /** GraveVault program ID (owner-held program keypair — NOT an authority). */
  vaultProgramId: "7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya",
  /** Initial and permanent ProtocolConfig authority for both NS-3 programs. */
  governanceAuthority: "BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5",
  /** Dedicated GraveScanner activity (C1) oracle signer. */
  activityOracle: "2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o",
  /** Dedicated GraveScanner launch-price (C2) oracle signer. */
  launchPriceOracle: "97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee",
};

/**
 * Pinned Solana Devnet genesis hash — THE single cluster-identity anchor
 * for every GraveYield devnet tool (moved here from
 * verify_ns3_deployment.mjs so the deployment script, the administration
 * CLI, and the acceptance verifier can never silently drift apart).
 *
 * Independently verified on 2026-11-06 from three sources: (1) live
 * `getGenesisHash` on https://api.devnet.solana.com; (2) the official
 * Anza cluster documentation, whose devnet validator example pins
 * `--expected-genesis-hash` to this exact value (docs.anza.xyz —
 * "Available Solana Clusters"); (3) an independent chain-config
 * reference cross-check. A devnet genesis reset would change the live
 * value — that failure mode is deliberate: the pin is re-verified by a
 * human and re-pinned consciously, never silently.
 *
 * This is deliberately a SIBLING export, not a member of the NS3 object:
 * every NS3 member is a public key (asserted by test/ns3_sync.test.mjs),
 * while a genesis hash is a cluster identity, not an authority.
 */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Seeds — must mirror the constants.rs files of both programs (asserted by ns3_sync test). */
export const PROTOCOL_CONFIG_SEED = "protocol_config";

/**
 * Byte-exact synchronous PDA derivation — mirrors sdk/src/web3compat.ts and
 * scripts/devnet/protocol_admin.mjs (hash preimage
 * `seeds || bump || program_id || "ProgramDerivedAddress"`, on-curve
 * rejection, bump searched 255→0).
 */
export function findProgramAddressSync(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const digest = createSha256(
      Buffer.concat([
        ...seeds,
        Buffer.from([bump]),
        programId.toBytes(),
        Buffer.from("ProgramDerivedAddress", "utf8"),
      ]),
    );
    if (!PublicKey.isOnCurve(digest)) {
      return [new PublicKey(digest), bump];
    }
  }
  throw new Error("unable to find program address: no off-curve bump found");
}

import { createHash } from "node:crypto";
function createSha256(buf) {
  return createHash("sha256").update(buf).digest();
}

/** ['protocol_config'] PDA under a program ID — [pda, bump]. */
export function configPdaWithBump(programId) {
  return findProgramAddressSync([Buffer.from(PROTOCOL_CONFIG_SEED, "utf8")], programId);
}

export function configPda(programId) {
  return configPdaWithBump(programId)[0];
}

/** The locally derived NS-3 ProtocolConfig PDAs (bump 255). */
export const NS3_PDAS = (() => {
  const [scanner, scannerBump] = configPdaWithBump(new PublicKey(NS3.scannerProgramId));
  const [vault, vaultBump] = configPdaWithBump(new PublicKey(NS3.vaultProgramId));
  return {
    scannerConfigPda: scanner.toBase58(),
    scannerConfigBump: scannerBump,
    vaultConfigPda: vault.toBase58(),
    vaultConfigBump: vaultBump,
  };
})();

/**
 * ProgramData ADDRESSES ARE derivable offline (corrected 2026-11-05): the
 * BPF upgradeable loader convention — implemented by the deployment CLI
 * via `solana_loader_v3_interface::get_program_data_address` — is
 * PDA([program_id], BPFLoaderUpgradeable). Verified against the
 * anza-xyz/solana-sdk loader-v3-interface sources AND live on-chain:
 * both NS-2 ProgramData accounts equal this derivation at bump 255.
 * The acceptance verifier re-derives the address instead of trusting
 * any recorded value.
 */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

/** The loader-derived ProgramData address of an upgradeable program. */
export function programDataPda(programId) {
  return findProgramAddressSync(
    [programId.toBytes()],
    new PublicKey(BPF_LOADER_UPGRADEABLE_PROGRAM_ID),
  )[0];
}
