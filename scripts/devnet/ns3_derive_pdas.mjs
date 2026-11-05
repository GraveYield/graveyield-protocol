// SPDX-License-Identifier: Apache-2.0
//
// ns3_derive_pdas.mjs — derive and print the canonical NS-3 PDAs from the
// program IDs plus the seed constants, for the pre-deployment derivation
// record (docs/DEVNET.md requirement: pre-deployment derivations must be
// byte-exact matches of the post-deployment readbacks).
//
// Usage:
//   node ns3_derive_pdas.mjs                 # human-readable table
//   node ns3_derive_pdas.mjs --json          # machine-readable manifest fragment
import { PublicKey } from "@solana/web3.js";
import { NS3, NS3_PDAS, configPdaWithBump, programDataPda } from "./ns3_identities.mjs";

const asJson = process.argv.includes("--json");

// Live re-derivation self-check: the pinned NS3_PDAS constants must be the
// honest ['protocol_config'] derivations of the NS-3 program IDs (bump 255).
// If the pinned values ever drift from the live derivation, fail loudly —
// the printed record must never silently diverge from the real derivation.
const [liveScannerPda, liveScannerBump] = configPdaWithBump(new PublicKey(NS3.scannerProgramId));
const [liveVaultPda, liveVaultBump] = configPdaWithBump(new PublicKey(NS3.vaultProgramId));
if (
  liveScannerPda.toBase58() !== NS3_PDAS.scannerConfigPda ||
  liveScannerBump !== NS3_PDAS.scannerConfigBump
) {
  throw new Error(
    `scanner ProtocolConfig PDA self-check failed: pinned ${NS3_PDAS.scannerConfigPda} ` +
      `!= live ${liveScannerPda.toBase58()} (bump ${liveScannerBump})`,
  );
}
if (
  liveVaultPda.toBase58() !== NS3_PDAS.vaultConfigPda ||
  liveVaultBump !== NS3_PDAS.vaultConfigBump
) {
  throw new Error(
    `vault ProtocolConfig PDA self-check failed: pinned ${NS3_PDAS.vaultConfigPda} ` +
      `!= live ${liveVaultPda.toBase58()} (bump ${liveVaultBump})`,
  );
}

// ProgramData addresses ARE derivable offline (loader-v3 convention:
// PDA([program_id], BPFLoaderUpgradeable) — verified against the
// anza-xyz/solana-sdk sources and the live NS-2 ProgramData accounts).
// They are printed here as DERIVED expectations; the on-chain program
// account's embedded pointer must equal them after deployment (asserted
// by verify_ns3_deployment.mjs section A).
const scannerProgramData = programDataPda(new PublicKey(NS3.scannerProgramId)).toBase58();
const vaultProgramData = programDataPda(new PublicKey(NS3.vaultProgramId)).toBase58();

const rows = [
  [
    "NS-3 GraveScanner program ID",
    NS3.scannerProgramId,
    "owner-provided (verify on chain: getAccountInfo owner/executable AFTER deploy)",
  ],
  [
    "NS-3 GraveVault program ID",
    NS3.vaultProgramId,
    "owner-provided (verify on chain AFTER deploy)",
  ],
  [
    "Scanner ProtocolConfig PDA",
    NS3_PDAS.scannerConfigPda,
    `locally derived: ['${"protocol_config"}'] under scanner ID, bump ${NS3_PDAS.scannerConfigBump}`,
  ],
  [
    "Vault ProtocolConfig PDA",
    NS3_PDAS.vaultConfigPda,
    `locally derived: ['${"protocol_config"}'] under vault ID, bump ${NS3_PDAS.vaultConfigBump}`,
  ],
  [
    "Deployer / fee payer / initial upgrade authority",
    NS3.deployer,
    "owner-provided public key; upgrade authority confirmed only AFTER deploy via ProgramData readback",
  ],
  [
    "Governance authority (ProtocolConfig)",
    NS3.governanceAuthority,
    "owner-provided; confirmed only AFTER init via config readback",
  ],
  [
    "Activity oracle signer",
    NS3.activityOracle,
    "owner-provided; confirmed only AFTER register-oracle via config readback",
  ],
  [
    "Launch-price oracle signer",
    NS3.launchPriceOracle,
    "owner-provided; confirmed only AFTER register-oracle via config readback",
  ],
  [
    "Scanner ProgramData",
    scannerProgramData,
    "derived offline: PDA([scanner program ID], BPFLoaderUpgradeable); post-deploy the program account's embedded pointer must equal this",
  ],
  [
    "Vault ProgramData",
    vaultProgramData,
    "derived offline: PDA([vault program ID], BPFLoaderUpgradeable); post-deploy the program account's embedded pointer must equal this",
  ],
];

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ns3: {
          ...NS3,
          ...NS3_PDAS,
          programData: {
            scanner: scannerProgramData,
            vault: vaultProgramData,
            note: "derived offline (loader-v3 get_program_data_address convention); on-chain pointer must match",
          },
          derivedOffline: ["scannerConfigPda", "vaultConfigPda", "programData"],
          requiresOnChainVerification: [
            "scannerProgramId",
            "vaultProgramId",
            "programData",
            "upgradeAuthority",
            "governanceAuthority",
            "activityOracle",
            "launchPriceOracle",
          ],
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log("NS-3 PDA derivation record (locally derived — no RPC executed)");
  console.log("=".repeat(72));
  for (const [k, v, src] of rows) {
    console.log(`${k}\n  ${v}\n  provenance: ${src}`);
  }
}
