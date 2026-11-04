// SPDX-License-Identifier: Apache-2.0
//
// register-oracle instruction tests (NS-3 review, protocol PR finding A).
//
// The instruction builder under test lives in ../protocol_admin.mjs and
// manually constructs the borsh encoding of GraveScanner
// `update_protocol_config` (the repo is IDL-free by design — `anchor
// build` is CI-only and no IDL file is committed). Per the review, the
// builder must NOT be tested against itself, so this suite derives the
// EXPECTED encoding INDEPENDENTLY from two normative sources:
//
//   1. The Anchor wire conventions (sha256("global:<snake_name>")[0..8]
//      discriminator; borsh Option<T> = 0x00 | 0x01 + LE value).
//   2. The canonical Rust definition, byte-for-byte the source of truth:
//        programs/grave-scanner/src/instructions/update_protocol_config.rs
//          struct UpdateProtocolConfigParams {
//            inactivity_seconds:        Option<u64>,
//            price_collapse_bps:        Option<u16>,
//            min_tvl_lamports:          Option<u64>,
//            anchor_staleness_seconds:  Option<u64>,
//            lp_burn_dust_threshold:    Option<u64>,
//            cert_ttl_seconds:          Option<i64>,
//            activity_oracle:           Option<Pubkey>,
//            launch_price_oracle:       Option<Pubkey>,
//          }
//          #[derive(Accounts)] UpdateProtocolConfig<'info> {
//            #[account(mut, seeds = [ProtocolConfig::SEED], bump, has_one = authority)]
//            protocol_config: Account<ProtocolConfig>,
//            authority: Signer,
//          }
//
// If the Rust struct ever reorders or retypes a field, the independent
// encoder below must be updated IN THE SAME COMMIT — that is the drift
// alarm working as intended.
//
// Keypairs in this file are EPHEMERAL TEST-ONLY keys generated in memory
// (`Keypair.generate()`); none of them is an owner key and nothing is
// persisted, printed, or submitted. No RPC connection is opened and no
// transaction is sent — signing/verification are local operations.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  buildScannerUpdateProtocolConfigIx,
  configPda,
  assembleOracleUpdateTransaction,
} from "../protocol_admin.mjs";
import { NS3, NS3_PDAS } from "../ns3_identities.mjs";

// ------------------------------------------------- independent encoder
// Derived here from the Anchor conventions + the Rust struct above — the
// same sources the builder claims to mirror. This is the test ORACLE.

const UPDATE_DISC = createHash("sha256")
  .update("global:update_protocol_config")
  .digest()
  .subarray(0, 8);

function optU64(v) {
  if (v === null) return Buffer.from([0x00]);
  const b = Buffer.alloc(9);
  b[0] = 0x01;
  b.writeBigUInt64LE(BigInt(v), 1);
  return b;
}
function optI64(v) {
  if (v === null) return Buffer.from([0x00]);
  const b = Buffer.alloc(9);
  b[0] = 0x01;
  b.writeBigInt64LE(BigInt(v), 1);
  return b;
}
function optU16(v) {
  if (v === null) return Buffer.from([0x00]);
  const b = Buffer.alloc(3);
  b[0] = 0x01;
  b.writeUInt16LE(v, 1);
  return b;
}
function optPk(pk) {
  if (pk === null) return Buffer.from([0x00]);
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(pk.toBytes())]);
}
/** Independent full-params encoder, field order locked by the Rust struct. */
function expectedData(p) {
  return Buffer.concat([
    UPDATE_DISC,
    optU64(p.inactivitySeconds),
    optU16(p.priceCollapseBps),
    optU64(p.minTvlLamports),
    optU64(p.anchorStalenessSeconds),
    optU64(p.lpBurnDustThreshold),
    optI64(p.certTtlSeconds),
    optPk(p.activityOracle),
    optPk(p.launchPriceOracle),
  ]);
}

const NONE_ALL = {
  inactivitySeconds: null,
  priceCollapseBps: null,
  minTvlLamports: null,
  anchorStalenessSeconds: null,
  lpBurnDustThreshold: null,
  certTtlSeconds: null,
  activityOracle: null,
  launchPriceOracle: null,
};

const SCANNER_ID = new PublicKey(NS3.scannerProgramId);

/** web3.js 3.x made every Keypair constructor async (kit-backed) — forget
 *  the await and `.publicKey` is `undefined`, which silently activates the
 *  builder's `= null` defaults. All keypairs below are awaited + ephemeral. */
async function ephemeralKeypair() {
  return Keypair.generate();
}

/** Byte equality for the Uint8Array forms web3.js 3.x uses for ix.data. */
function bytesEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Offline signature check (web3.js 3.x removed Transaction.verify): each
 *  required signer carries a 64-byte ed25519 signature over the serialized
 *  message, verified with tweetnacl. Fully local — no RPC, no submission. */
async function assertTxSignaturesValid(tx, expectedSigners) {
  assert.equal(tx.signatures.length, expectedSigners.length, "exactly the expected signer set");
  const msg = new Uint8Array(tx.serializeMessage());
  for (let i = 0; i < expectedSigners.length; i++) {
    const sig = tx.signatures[i];
    assert.ok(
      sig.publicKey.equals(expectedSigners[i].publicKey),
      `signer[${i}] is the expected key`,
    );
    assert.equal(sig.signature?.length, 64, "64-byte ed25519 signature present");
    assert.ok(
      nacl.sign.detached.verify(msg, new Uint8Array(sig.signature), sig.publicKey.toBytes()),
      `signature[${i}] cryptographically verifies over the serialized message`,
    );
  }
}

describe("register-oracle instruction (independent encoding oracle)", () => {
  test("1. discriminator is sha256('global:update_protocol_config')[0..8]", async () => {
    const authority = (await ephemeralKeypair()).publicKey;
    const ix = buildScannerUpdateProtocolConfigIx({ programId: SCANNER_ID, authority });
    assert.equal(ix.programId.toBase58(), NS3.scannerProgramId);
    assert.deepEqual(
      Buffer.from(ix.data.subarray(0, 8)),
      UPDATE_DISC,
      "8-byte Anchor global discriminator for update_protocol_config",
    );
  });

  test("2. serialized data length + layout match the independent encoding", async () => {
    const authority = (await ephemeralKeypair()).publicKey;
    // Oracle-only update (the register-oracle shape): 8 + 6 + 33 + 33 = 80.
    const activity = (await ephemeralKeypair()).publicKey;
    const launch = (await ephemeralKeypair()).publicKey;
    const oracleOnly = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority,
      activityOracle: activity,
      launchPriceOracle: launch,
    });
    assert.equal(oracleOnly.data.length, 80, "8 disc + 6 scalar Nones + 2×(1 tag + 32 bytes)");
    assert.deepEqual(
      Buffer.from(oracleOnly.data),
      expectedData({ ...NONE_ALL, activityOracle: activity, launchPriceOracle: launch }),
      "byte-exact against the independent encoder",
    );

    // All-None: 8 + 8 = 16 bytes.
    const allNone = buildScannerUpdateProtocolConfigIx({ programId: SCANNER_ID, authority });
    assert.equal(allNone.data.length, 16);
    assert.deepEqual(Buffer.from(allNone.data), expectedData(NONE_ALL));

    // Scalar Some values pin the LE encodings (u64/u16/i64) and lengths.
    const scalars = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority,
      inactivitySeconds: 7_776_000, // 90 d
      priceCollapseBps: 9_900,
      certTtlSeconds: -1, // i64 sign survives the wire
    });
    assert.equal(
      scalars.data.length,
      8 + (9 + 3 + 9) + 5,
      "u64 + u16 + i64 Some (9/3/9 bytes) + 5 Nones",
    );
    assert.deepEqual(
      Buffer.from(scalars.data),
      expectedData({
        ...NONE_ALL,
        inactivitySeconds: 7_776_000,
        priceCollapseBps: 9_900,
        certTtlSeconds: -1,
      }),
    );
  });

  test("3. both oracle public keys are encoded in the correct order", async () => {
    const authority = (await ephemeralKeypair()).publicKey;
    const activity = (await ephemeralKeypair()).publicKey;
    const launch = (await ephemeralKeypair()).publicKey;
    const ix = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority,
      activityOracle: activity,
      launchPriceOracle: launch,
    });
    // Field order from the Rust struct: activity_oracle BEFORE launch_price_oracle.
    const ACTIVITY_TAG = 14; // 8 disc + 6 one-byte Nones
    const LAUNCH_TAG = 47; // + 1 tag + 32 bytes
    assert.equal(ix.data[ACTIVITY_TAG], 0x01, "activity Option tag = Some");
    assert.equal(ix.data[LAUNCH_TAG], 0x01, "launch Option tag = Some");
    assert.deepEqual(
      Buffer.from(ix.data.subarray(ACTIVITY_TAG + 1, ACTIVITY_TAG + 33)),
      Buffer.from(activity.toBytes()),
      "first Pubkey payload is the ACTIVITY oracle",
    );
    assert.deepEqual(
      Buffer.from(ix.data.subarray(LAUNCH_TAG + 1, LAUNCH_TAG + 33)),
      Buffer.from(launch.toBytes()),
      "second Pubkey payload is the LAUNCH-PRICE oracle",
    );
    // Order sensitivity: swapping the two keys must swap the payloads —
    // a reversed field order in the builder would be caught here.
    const swapped = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority,
      activityOracle: launch,
      launchPriceOracle: activity,
    });
    assert.deepEqual(
      Buffer.from(swapped.data.subarray(ACTIVITY_TAG + 1, ACTIVITY_TAG + 33)),
      Buffer.from(launch.toBytes()),
    );
    assert.deepEqual(
      Buffer.from(swapped.data.subarray(LAUNCH_TAG + 1, LAUNCH_TAG + 33)),
      Buffer.from(activity.toBytes()),
    );
    assert.ok(!bytesEqual(swapped.data, ix.data), "swapped oracles produce different bytes");
  });

  test("4. account metas: [config PDA (mut, non-signer), authority (signer)]", async () => {
    const authority = (await ephemeralKeypair()).publicKey;
    const ix = buildScannerUpdateProtocolConfigIx({ programId: SCANNER_ID, authority });
    assert.equal(ix.keys.length, 2, "exactly protocol_config + authority (Rust Accounts struct)");
    assert.ok(
      ix.keys[0].pubkey.equals(configPda(SCANNER_ID)),
      "meta[0] is the ['protocol_config'] PDA",
    );
    assert.equal(ix.keys[0].isWritable, true, "protocol_config is mut");
    assert.equal(ix.keys[0].isSigner, false, "PDA is not a signer");
    assert.ok(ix.keys[1].pubkey.equals(authority), "meta[1] is the authority");
    assert.equal(ix.keys[1].isSigner, true, "authority is the Signer");
    assert.equal(ix.keys[1].isWritable, false, "authority account is not mut");
    // The PDA must equal the repo-pinned NS-3 derivation (cross-checks the
    // two independent implementations: protocol_admin helper vs pinned NS3_PDAS).
    assert.equal(configPda(SCANNER_ID).toBase58(), NS3_PDAS.scannerConfigPda);
  });

  test("5. the governance authority is the instruction signer (has_one = authority)", async () => {
    const governance = (await ephemeralKeypair()).publicKey; // EPHEMERAL test key
    const ix = buildScannerUpdateProtocolConfigIx({ programId: SCANNER_ID, authority: governance });
    const signers = ix.keys.filter((k) => k.isSigner);
    assert.equal(signers.length, 1, "exactly ONE instruction-level signer");
    assert.ok(signers[0].pubkey.equals(governance), "the signer is the governance authority");
  });

  test("6. the deployer is independently represented as the transaction fee payer", async () => {
    const deployer = await ephemeralKeypair(); // EPHEMERAL test key (fee payer role)
    const governance = await ephemeralKeypair(); // EPHEMERAL test key (authority role)
    const ix = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority: governance.publicKey,
      activityOracle: (await ephemeralKeypair()).publicKey,
      launchPriceOracle: (await ephemeralKeypair()).publicKey,
    });
    const { tx, instructionSignerCount } = assembleOracleUpdateTransaction({
      instruction: ix,
      authorityPubkey: governance.publicKey,
      feePayerPubkey: deployer.publicKey,
    });
    assert.ok(tx.feePayer.equals(deployer.publicKey), "deployer is the transaction fee payer");
    assert.ok(
      !tx.feePayer.equals(governance.publicKey),
      "fee payer ≠ config authority (role separation)",
    );
    assert.equal(instructionSignerCount, 2, "fee payer + authority both sign the TRANSACTION");
    // Offline signature round-trip: the assembled transaction is fully
    // signable by [feePayer, authority] and the signatures verify locally —
    // no RPC, no submission.
    tx.recentBlockhash = "11111111111111111111111111111111"; // deterministic test blockhash
    await tx.sign(deployer, governance);
    await assertTxSignaturesValid(tx, [deployer, governance]);
  });

  test("7. neither oracle keypair is required to sign the configuration update", async () => {
    const deployer = await ephemeralKeypair();
    const governance = await ephemeralKeypair();
    const activity = await ephemeralKeypair();
    const launch = await ephemeralKeypair();
    const ix = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority: governance.publicKey,
      activityOracle: activity.publicKey,
      launchPriceOracle: launch.publicKey,
    });
    for (const meta of ix.keys) {
      assert.ok(!meta.pubkey.equals(activity.publicKey), "activity oracle is NOT an account");
      assert.ok(!meta.pubkey.equals(launch.publicKey), "launch-price oracle is NOT an account");
    }
    // The oracles appear ONLY as borsh payload bytes, never as accounts —
    // so the transaction's complete required signer set is just fee payer
    // + authority, and their signatures verify with the oracle keypairs
    // never loaded.
    const { tx } = assembleOracleUpdateTransaction({
      instruction: ix,
      authorityPubkey: governance.publicKey,
      feePayerPubkey: deployer.publicKey,
    });
    tx.recentBlockhash = "11111111111111111111111111111111";
    await tx.sign(deployer, governance); // oracle keypairs NOT loaded, NOT signing
    await assertTxSignaturesValid(tx, [deployer, governance]);
  });

  test("8. activity and launch-price oracle values are updatable independently", async () => {
    const authority = (await ephemeralKeypair()).publicKey;
    const activity = (await ephemeralKeypair()).publicKey;
    const launch = (await ephemeralKeypair()).publicKey;
    // Only activity: launch stays None.
    const onlyActivity = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority,
      activityOracle: activity,
    });
    assert.equal(onlyActivity.data.length, 8 + 6 + 33 + 1);
    assert.deepEqual(
      Buffer.from(onlyActivity.data),
      expectedData({ ...NONE_ALL, activityOracle: activity }),
    );
    assert.equal(onlyActivity.data[47], 0x00, "launch_price_oracle Option = None");
    // Only launch: activity stays None.
    const onlyLaunch = buildScannerUpdateProtocolConfigIx({
      programId: SCANNER_ID,
      authority,
      launchPriceOracle: launch,
    });
    assert.equal(onlyLaunch.data.length, 8 + 6 + 1 + 33);
    assert.deepEqual(
      Buffer.from(onlyLaunch.data),
      expectedData({ ...NONE_ALL, launchPriceOracle: launch }),
    );
    assert.equal(onlyLaunch.data[14], 0x00, "activity_oracle Option = None");
    // The two single-field encodings differ — each field is independently
    // addressable on the wire (the Rust handler applies each Option field
    // in its own if-let, so a None never clobbers the other field; that
    // per-field independence is additionally pinned host-side by
    // scalar_and_oracle_fields_apply_without_bounds in the Rust tests).
    assert.ok(!bytesEqual(onlyActivity.data, onlyLaunch.data));
  });
});
