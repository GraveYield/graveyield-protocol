// SPDX-License-Identifier: Apache-2.0
//
// provenance.manifest.json integrity battery.
//
// The manifest is the SINGLE shared copy of the approved NS-3 deployment
// digests, consumed by BOTH .github/workflows/ci.yml and
// scripts/devnet/deploy_devnet.sh. These tests pin that:
//   ✔ the manifest carries EXACTLY the digests approved by PR #82 (merge
//     a71158edba7be42a2a0195bf95c24c863090bd44) — a digest change MUST
//     also change these test constants, i.e. it can never silently ride
//     along in an unrelated edit ("never bump a hash to make a failing
//     check pass");
//   ✔ the manifest's program IDs equal the canonical NS-3 identities;
//   ✔ the SBPF v0 / platform-tools v1.54 / toolchain records are intact;
//   ✔ BOTH consumers (CI + deploy script) actually consume the manifest —
//     and the old inline digest copy in ci.yml is gone (two copies would
//     drift).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkManifestSchema, loadManifest } from "../ns3_verify_provenance.mjs";
import { NS3 } from "../ns3_identities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const MANIFEST_PATH = join(HERE, "..", "provenance.manifest.json");

// ─── Approved provenance constants (PR #82 merge a71158ed…bd44). These are
// deliberately DUPLICATED HERE AND ONLY HERE (test + manifest): if a future
// edit changes the manifest digests without independent review + deliberate
// re-approval, this suite fails and the PR cannot merge quietly.
const APPROVED = {
  scanner: "e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98",
  vault: "8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83",
  platformToolsTarball: "fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e",
};

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

describe("provenance manifest integrity (single shared source of approved digests)", () => {
  test("schema, generation, and chain are intact", () => {
    assert.equal(manifest.schema, "graveyield.devnet.provenance/1");
    assert.equal(manifest.generation, "NS-3");
    assert.equal(manifest.chain, "devnet");
  });

  test("digests are EXACTLY the PR #82 approved constants (anti silent-hash-bump pin)", () => {
    assert.equal(manifest.elfs.scanner.sha256, APPROVED.scanner);
    assert.equal(manifest.elfs.vault.sha256, APPROVED.vault);
  });

  test("the two ELF digests are distinct", () => {
    assert.notEqual(manifest.elfs.scanner.sha256, manifest.elfs.vault.sha256);
  });

  test("platform-tools record is the pinned v1.54 + approved tarball digest", () => {
    assert.equal(manifest.platformTools.version, "v1.54");
    assert.equal(manifest.platformTools.tarballSha256, APPROVED.platformToolsTarball);
    assert.match(
      manifest.platformTools.tarballUrl,
      /^https:\/\/github\.com\/anza-xyz\/platform-tools/,
    );
  });

  test("SBPF record is the deploy-flow v0 target (e_machine 263 / e_flags 0)", () => {
    assert.equal(manifest.sbpf.arch, "v0");
    assert.equal(manifest.sbpf.eMachine, 263);
    assert.equal(manifest.sbpf.eFlags, 0);
  });

  test("toolchain record matches Anchor.toml pins", () => {
    const anchorToml = readFileSync(join(REPO_ROOT, "Anchor.toml"), "utf8");
    const anchorVersion = /anchor_version\s*=\s*"([^"]+)"/.exec(anchorToml)?.[1];
    const solanaVersion = /solana_version\s*=\s*"([^"]+)"/.exec(anchorToml)?.[1];
    assert.equal(manifest.toolchain.anchorCli, anchorVersion);
    assert.equal(manifest.toolchain.solanaCli, solanaVersion);
  });

  test("manifest program IDs equal the canonical NS-3 identities", () => {
    assert.equal(manifest.elfs.scanner.programId, NS3.scannerProgramId);
    assert.equal(manifest.elfs.vault.programId, NS3.vaultProgramId);
    assert.equal(manifest.elfs.scanner.artifact, "grave_scanner.so");
    assert.equal(manifest.elfs.vault.artifact, "grave_vault.so");
  });

  test("checkManifestSchema passes on the real manifest", () => {
    const { ok, problems } = checkManifestSchema(manifest);
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
  });

  test("loadManifest reads the repo manifest end-to-end", () => {
    const { manifest: m, schema } = loadManifest(MANIFEST_PATH);
    assert.equal(m.schema, manifest.schema);
    assert.equal(schema.ok, true);
  });

  test("ci.yml consumes the SHARED manifest via the provenance gate (and the inline digest copy is gone)", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    assert.match(
      ci,
      /node scripts\/devnet\/ns3_verify_provenance\.mjs \\\n\s+--manifest scripts\/devnet\/provenance\.manifest\.json/,
      "CI must run the provenance gate against the shared manifest",
    );
    assert.doesNotMatch(
      ci,
      /e24ddc5ea3fbfe13f5732166a6a3c68d91fdc6de98b4046e05d35f4483cd6c98/,
      "the approved scanner digest must live ONLY in the manifest (no second copy in CI to drift)",
    );
    assert.doesNotMatch(
      ci,
      /8c71fe9d8d02c0adc8006f3616b984fc57b4a6c01f37f371b850bfd2ec033e83/,
      "the approved vault digest must live ONLY in the manifest (no second copy in CI to drift)",
    );
    // The gate subsumes the structural verifier (ns3_verify_provenance.mjs
    // imports verifyElfIdentity from ns3_verify_elf.mjs) — assert the gate
    // module exists next to the manifest, and the artifact upload +
    // sha256sum echo must remain.
    assert.match(ci, /Upload program ELFs \(deployment-provenance artifacts\)/);
    assert.match(ci, /sha256sum target\/deploy\/\*\.so/);
  });

  test("deploy_devnet.sh consumes the SHARED manifest on every deploy-reaching path", () => {
    const script = readFileSync(join(HERE, "..", "deploy_devnet.sh"), "utf8");
    assert.match(script, /MANIFEST="\$DEVNET_DIR\/provenance\.manifest\.json"/);
    assert.match(script, /verify_provenance\(\)/, "the gate must be defined");
    // Three invocation sites: --build-only, and the main path before deploy.
    const calls = script.match(/verify_provenance\n/g) ?? [];
    assert.ok(calls.length >= 2, `expected >=2 gate invocations, found ${calls.length}`);
    assert.doesNotMatch(
      script,
      /--skip-provenance|--no-verify|SKIP_PROVENANCE/,
      "no flag may bypass the provenance gate",
    );
  });
});
