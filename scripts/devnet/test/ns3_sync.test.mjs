// SPDX-License-Identifier: Apache-2.0
//
// NS-3 identity synchronization regression battery (M-1).
//
// Pins, inside CI:
//   1. every ACTIVE identity surface in this repo names the NS-3 IDs;
//   2. the pinned ProtocolConfig PDA vectors are the honest derivations
//      of those IDs (bump 255);
//   3. the NS-3 authority/oracle arrangement constants are valid public
//      keys and are distinct roles (no single-key concentration);
//   4. no legacy NS-1/NS-2 ID survives in an ACTIVE surface (the
//      historical records in docs/ are intentionally out of scope —
//      they MUST keep their references).
//
// A partial sync (one surface missed) fails this suite — the exact
// failure mode that previously shipped as the salvor devnetSmoke
// NS-1-vector drift.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { NS3, NS3_PDAS, configPdaWithBump, findProgramAddressSync } from "../ns3_identities.mjs";
import {
  checkProtocolInternal,
  checkPinnedPdaVectors,
  LEGACY_IDS,
} from "../ns3_verify_sync.mjs";

describe("NS-3 identity synchronization (M-1)", () => {
  test("all ACTIVE identity surfaces agree on the NS-3 program IDs", () => {
    const r = checkProtocolInternal();
    assert.ok(r.ok);
    assert.ok(r.scannerSurfaces.length >= 8, "scanner ID must appear across the active surfaces");
    assert.ok(r.vaultSurfaces.length >= 8, "vault ID must appear across the active surfaces");
  });

  test("pinned PDA vectors are the honest [protocol_config] derivations (bump 255)", () => {
    const r = checkPinnedPdaVectors();
    assert.ok(r.ok);
    const [scanner, scannerBump] = configPdaWithBump(new PublicKey(NS3.scannerProgramId));
    const [vault, vaultBump] = configPdaWithBump(new PublicKey(NS3.vaultProgramId));
    assert.equal(scannerBump, 255);
    assert.equal(vaultBump, 255);
    assert.equal(scanner.toBase58(), NS3_PDAS.scannerConfigPda);
    assert.equal(vault.toBase58(), NS3_PDAS.vaultConfigPda);
  });

  test("NS-3 identities are valid canonical base58 ed25519 public keys", () => {
    for (const [role, id] of Object.entries(NS3)) {
      const pk = new PublicKey(id);
      assert.equal(pk.toBase58(), id, `${role} must be a canonical base58 pubkey`);
    }
  });

  test("NS-3 roles are distinct — no single-key concentration (DR-002 lesson)", () => {
    const roles = Object.values(NS3);
    assert.equal(new Set(roles).size, roles.length, "every NS-3 role must be a distinct key");
    // The program IDs are NOT administrative authorities (task §4).
    assert.notEqual(NS3.scannerProgramId, NS3.governanceAuthority);
    assert.notEqual(NS3.vaultProgramId, NS3.governanceAuthority);
    assert.notEqual(NS3.deployer, NS3.governanceAuthority);
    assert.notEqual(NS3.activityOracle, NS3.launchPriceOracle);
  });

  test("no legacy NS-1/NS-2 ID string appears in any ACTIVE surface", () => {
    // checkProtocolInternal already enforces this; re-assert the legacy set
    // itself is what we think it is (guards an accidental edit of the table).
    assert.equal(LEGACY_IDS.ns2Scanner, "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54");
    assert.equal(LEGACY_IDS.ns2Vault, "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg");
    assert.equal(LEGACY_IDS.ns1Scanner, "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF");
    assert.equal(LEGACY_IDS.ns1Vault, "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6");
  });

  test("findProgramAddressSync helper reproduces the NS-2 derivation (algorithm canary)", () => {
    // The derivation must remain byte-exact: feeding the NS-2 IDs MUST
    // reproduce the recorded NS-2 config PDAs (bump 255). If this ever
    // fails, the helper drifted from find_program_address.
    const [s] = findProgramAddressSync(
      [Buffer.from("protocol_config", "utf8")],
      new PublicKey(LEGACY_IDS.ns2Scanner),
    );
    const [v] = findProgramAddressSync(
      [Buffer.from("protocol_config", "utf8")],
      new PublicKey(LEGACY_IDS.ns2Vault),
    );
    assert.equal(s.toBase58(), LEGACY_IDS.ns2ScannerConfigPda);
    assert.equal(v.toBase58(), LEGACY_IDS.ns2VaultConfigPda);
  });
});
