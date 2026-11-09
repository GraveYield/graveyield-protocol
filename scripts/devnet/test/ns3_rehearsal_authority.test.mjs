// SPDX-License-Identifier: Apache-2.0
//
// NS-3 local-rehearsal governance-authority regression battery.
//
// Pins the authority flow of scripts/devnet/local_rehearsal_ns3.sh after
// the authority-mismatch correction (fix/ns3-local-rehearsal-governance-
// authority): ONE temporary governance keypair must drive the rehearsal's
// ENTIRE administrative lifecycle —
//
//   initialize (stores the authority in both ProtocolConfigs)
//     → emergency-control drills (signs pause/unpause; intruder rejected)
//     → register-oracle (signs the dedicated-oracle rotation)
//
// The defect this guards: initialization passed the PERMANENT NS-3
// governance public key (BMnrpx9m…Uwf5) while the drills and oracle
// registration signed with the TEMPORARY governance keypair, so the very
// first drill readback failed on the authority mismatch (and would have
// failed the oracle registration with Unauthorized 6000 next). The
// permanent NS-3 governance key must never enter the local validator's
// temporary state; production devnet behavior (deploy_devnet.sh +
// docs/DEVNET.md initializing with the owner's permanent key) must stay
// untouched — both directions are asserted here.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "local_rehearsal_ns3.sh");
const PROD_DEPLOY = join(HERE, "..", "deploy_devnet.sh");

/** Read a shell script with backslash line-continuations joined, so a
 *  single logical command spanning several physical lines is one string. */
function logicalLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .reduce(
      (acc, raw) => {
        const line = raw.replace(/#.*$/, ""); // strip comments, not strings
        if (/\\\s*$/.test(line) && acc.open) {
          acc.buf.push(line.replace(/\\\s*$/, ""));
        } else if (/\\\s*$/.test(line)) {
          acc.open = true;
          acc.buf = [line.replace(/\\\s*$/, "")];
        } else if (acc.open) {
          acc.out.push([...acc.buf, line].join(" "));
          acc.open = false;
          acc.buf = [];
        } else {
          acc.out.push(line);
        }
        return acc;
      },
      { open: false, buf: [], out: [] },
    ).out;
}

const lines = logicalLines(SCRIPT);
const adminCalls = lines.filter((l) => l.includes("protocol_admin.mjs"));
const initCalls = adminCalls.filter((l) => /init-(scanner|vault|all)\b/.test(l));
const drillCalls = adminCalls.filter((l) => /\bdrill\b/.test(l));
const oracleCalls = adminCalls.filter((l) => /\bregister-oracle\b/.test(l));

describe("NS-3 local-rehearsal governance authority (one temporary key, whole lifecycle)", () => {
  test("rehearsal script invokes protocol_admin.mjs at all (sanity)", () => {
    assert.ok(adminCalls.length > 0, "no protocol_admin.mjs invocations found");
    assert.equal(initCalls.length, 2, "init-scanner + init-vault expected");
    assert.equal(drillCalls.length, 2, "scanner + vault drills expected");
    assert.equal(oracleCalls.length, 1, "one register-oracle expected");
  });

  test("initialization stores the TEMPORARY governance public key, not the permanent NS-3 key", () => {
    for (const call of initCalls) {
      assert.match(
        call,
        /--authority "\$REHEARSAL_GOVERNANCE_PK"/,
        `init must pass the temporary governance pubkey: ${call}`,
      );
      assert.doesNotMatch(
        call,
        /--authority "\$GOVERNANCE_PUBKEY"/,
        `init must NOT pass the permanent NS-3 governance key: ${call}`,
      );
    }
  });

  test("NO protocol_admin invocation anywhere passes the permanent NS-3 governance key", () => {
    for (const call of adminCalls) {
      assert.doesNotMatch(
        call,
        /--authority "\$GOVERNANCE_PUBKEY"/,
        `the permanent NS-3 governance key must never be an authority argument: ${call}`,
      );
    }
  });

  test("drills and oracle registration sign with the SAME temporary governance keypair", () => {
    for (const call of [...drillCalls, ...oracleCalls]) {
      assert.match(
        call,
        /--authority "\$GOVERNANCE"/,
        `administrative operations must sign with the temporary governance keypair: ${call}`,
      );
    }
    for (const call of drillCalls) {
      assert.match(call, /--intruder "\$INTRUDER"/, `drill needs the intruder keypair: ${call}`);
    }
    for (const call of oracleCalls) {
      assert.match(
        call,
        /--fee-payer "\$DEPLOYER"/,
        `register-oracle must keep governance off the fee path: ${call}`,
      );
    }
  });

  test("the temporary authority is derived from the throwaway keypair and collision-guarded", () => {
    const derivation = lines.filter((l) => /REHEARSAL_GOVERNANCE_PK=/.test(l));
    assert.equal(
      derivation.filter((l) => l.includes("solana-keygen pubkey")).length,
      1,
      "the temporary governance pubkey must be derived from the temp keypair exactly once",
    );
    assert.ok(
      lines.some((l) => l.includes("REHEARSAL_GOVERNANCE_PK") && l.includes("GOVERNANCE_PUBKEY")),
      "the script must compare the temporary governance key against the permanent NS-3 key",
    );
    const refusal = lines.filter((l) => l.includes("REFUSING"));
    assert.ok(
      refusal.some((l) => l.includes("collided")),
      "a collision with the permanent governance key must be refused loudly",
    );
  });

  test("the rehearsal stays strictly local — only the loopback validator URL is used", () => {
    const urls = lines.map((l) => /--url "?([^" ]+)/.exec(l)?.[1]).filter(Boolean);
    assert.ok(urls.length > 0);
    for (const url of urls) {
      assert.equal(url, "$URL", `every RPC target must be the $URL variable: got ${url}`);
    }
    assert.match(
      lines.join("\n"),
      /URL="http:\/\/127\.0\.0\.1:8899"/,
      "$URL must be pinned to the loopback validator",
    );
    assert.doesNotMatch(lines.join("\n"), /api\.(devnet|mainnet)[^ ]*solana\.com/);
  });

  test("production devnet deployment still initializes with the PERMANENT governance key", () => {
    const prod = readFileSync(PROD_DEPLOY, "utf8");
    assert.match(
      prod,
      /init-scanner --url "\$URL" --deployer "\$DEPLOYER_KP" --authority <GOVERNANCE_PUBKEY>/,
      "deploy_devnet.sh must keep templating the permanent governance pubkey for devnet init",
    );
    assert.match(
      prod,
      /--authority <GOVERNANCE_KEYPAIR>/,
      "deploy_devnet.sh must keep templating the governance KEYPAIR for the devnet drill",
    );
  });

  test("cmdDrill pins the post-intruder expected state: paused stays TRUE until the authority unpauses", () => {
    const src = readFileSync(join(HERE, "..", "protocol_admin.mjs"), "utf8");
    const drill = src.slice(
      src.indexOf("async function cmdDrill"),
      src.indexOf("async function main"),
    );
    const intruderOk = drill.indexOf(`intruder rejected`);
    const unpause = drill.indexOf("buildPauseIx(programId, authority.publicKey, false)");
    const restoredFalse = drill.indexOf(
      "assertConfig(connection, program, { [pausedField]: false })",
    );
    assert.ok(intruderOk !== -1, "intruder-rejection marker missing from cmdDrill");
    assert.ok(unpause !== -1, "authority unpause missing from cmdDrill");
    assert.ok(restoredFalse !== -1, "restored-unpaused readback missing from cmdDrill");
    // Exactly two paused=TRUE readbacks must exist: one right after the
    // authority pause (step 3) and one immediately after the intruder
    // rejection (step 5) — the post-intruder expected state is TRUE because
    // the rejected attempt must not have lifted the authority's pause.
    const trueReadbacks = [
      ...drill.matchAll(/assertConfig\(connection, program, \{ \[pausedField\]: true \}\)/g),
    ].map((m) => m.index);
    assert.equal(
      trueReadbacks.length,
      2,
      "cmdDrill must read back paused=true after the authority pause AND after the intruder rejection",
    );
    const [afterPause, postIntruder] = trueReadbacks;
    assert.ok(
      afterPause < intruderOk,
      "the first paused=true readback must precede the intruder attempt",
    );
    assert.ok(
      intruderOk < postIntruder,
      "the post-intruder readback (paused stays TRUE) must come after the intruder rejection",
    );
    assert.ok(
      postIntruder < unpause && unpause < restoredFalse,
      "only after the post-intruder readback may the authority unpause (readback: false restored)",
    );
  });
});

// ============================================================================
// Cluster-mode + signer independence (this workstream): the rehearsal must
// explicitly activate the CLI's narrow local-validator exception, keep every
// RPC target on the loopback validator, never depend on a global default
// signer, never reference owner custody paths, and keep its cleanup-on-
// failure behavior. Source-level checks are used for shell-command
// requirements that cannot be exercised without a live local validator —
// the behavioral coverage lives in the local rehearsal itself and in
// protocol_admin_cluster_guard.test.mjs.
// ============================================================================

describe("NS-3 rehearsal cluster-mode + signer independence (this workstream)", () => {
  const showCalls = lines.filter((l) => l.includes("program show"));

  test("both `solana program show` commands explicitly use the temporary deployer keypair", () => {
    assert.equal(showCalls.length, 2, "exactly two program show commands expected");
    for (const call of showCalls) {
      assert.match(
        call,
        /solana --url "\$URL" --keypair "\$DEPLOYER" program show/,
        `program show must carry the throwaway deployer keypair (no global default signer): ${call}`,
      );
    }
  });

  test("every protocol_admin invocation explicitly activates the local-only administration mode", () => {
    assert.ok(adminCalls.length >= 5, "init/drill/oracle invocations expected");
    for (const call of adminCalls) {
      assert.match(
        call,
        /--allow-local-validator/,
        `every protocol_admin call must opt in to the loopback local-validator mode explicitly: ${call}`,
      );
    }
  });

  test("the local-mode opt-in is the ONLY cluster-identity relaxation (no bypass flags appear)", () => {
    const joined = lines.join("\n");
    assert.doesNotMatch(joined, /--skip-cluster-check|--no-verify|skip-genesis/i);
  });

  test("the rehearsal never references the owner custody directory or any owner keypair path", () => {
    const joined = lines.join("\n");
    // $HOME/graveyield-ns3-keys/ is the owner custody directory — it must
    // never appear in the rehearsal (or any agent-run script).
    assert.doesNotMatch(joined, /graveyield-ns3-keys/);
    // the rehearsal keys all come from the temp dir minted at runtime
    for (const call of adminCalls) {
      assert.doesNotMatch(call, /\$HOME/, `no invocation may point at a home-dir key: ${call}`);
    }
  });

  test("the rehearsal keeps its cleanup behavior on success AND failure (trap EXIT)", () => {
    const joined = lines.join("\n");
    assert.match(
      joined,
      /trap cleanup EXIT/,
      "cleanup must be trapped on EXIT (success and failure)",
    );
    assert.match(joined, /kill "\$VALIDATOR_PID"/, "the local validator must be killed on cleanup");
    assert.match(joined, /rm -rf "\$TMP"/, "the temp keypair dir must be removed on cleanup");
  });

  test("the permanent NS-3 governance key never enters local validator state (retained)", () => {
    // GOVERNANCE_PUBKEY (permanent) is only ever PRINTED for contrast and
    // compared against — never passed to protocol_admin or stored on-chain.
    const printOnly = lines.filter((l) => l.includes("GOVERNANCE_PUBKEY"));
    assert.ok(printOnly.length > 0, "the permanent key contrast-print is expected to remain");
    for (const call of adminCalls) {
      assert.doesNotMatch(call, /GOVERNANCE_PUBKEY/);
    }
  });
});
