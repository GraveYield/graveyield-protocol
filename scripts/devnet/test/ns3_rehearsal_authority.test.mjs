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
    .reduce((acc, raw) => {
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
    }, { open: false, buf: [], out: [] }).out;
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
    const urls = lines
      .map((l) => /--url "?([^" ]+)/.exec(l)?.[1])
      .filter(Boolean);
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
});
