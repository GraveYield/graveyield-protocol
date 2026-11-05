// summarize.mjs — W1 §11: readable Markdown summary + component
// classification next to the machine-readable run report JSON.
//
// The classification is HONEST-BY-CONSTRUCTION: every entry states what was
// actually exercised in THIS run (REAL / MOCK / STUB / EXTERNAL / NOT
// TESTED). A green suite is not proof of production integration — the
// "what this run does NOT prove" section is mandatory reading.
import { writeFileSync, readFileSync } from "node:fs";

// W1 §9 classification. Sources: the driver's actual call paths (verified at
// inspection, docs/W1_NS3_REHEARSAL_INSPECTION.md) + this run's report.
export const COMPONENT_CLASSIFICATION = [
  {
    component: "GraveScanner",
    classification: "REAL",
    detail:
      "locally built ELF, sha256 == approved NS-3 digest (provenance gate + stage 1 loaded-bytes check), executed on the local validator via real SDK/RPC transactions",
  },
  {
    component: "GraveVault",
    classification: "REAL",
    detail:
      "locally built ELF, sha256 == approved NS-3 digest, executed on the local validator (init, salvage_pool, claim_lp_proceeds, sweep_dust, drills)",
  },
  {
    component: "SDK clients (GraveYieldClient + instruction builders)",
    classification: "REAL",
    detail:
      "graveyield-protocol sdk/dist executed for config readback, PDAs, attestations, priority fee, snapshots, claims",
  },
  {
    component: "RPC clients",
    classification: "REAL",
    detail:
      "@solana/web3.js (single instance from the salvor checkout) against http://127.0.0.1:8899 only; v0/ALT-aware sender",
  },
  {
    component: "Snapshotter",
    classification: "REAL",
    detail:
      "Rust bin grave-snapshotter-cli (SnapshotBuilder + SnapshotArtifact::seal) run as a real subprocess; cross-checked against the SDK snapshot (root/supply/holder equality)",
  },
  {
    component: "Salvor components (fleet-core ExecutionPipeline, InMemoryFleetStore)",
    classification: "REAL",
    detail:
      'salvor-bots fleet-core mode:"live" submit path executed against the local validator over a real v0/ALT transaction (F2); the local market is the UNMODIFIED real mainnet fixture — fleet-core (since the salvor-side Finding E remediation) derives the market vault signer with the REAL OpenBook v1 rule ([market, stored_nonce_le], stored nonce preserved) and the October-era string-seed re-pin is RETIRED (contrast record only); the exact source revision is recorded in the run metadata (salvor_provenance)',
  },
  {
    component: "Monitoring (@graveyield/monitor reconcile)",
    classification: "REAL",
    detail:
      "salvor-bots monitor executed against the local validator state; stage-13 reconciliation gate (Finding D) with recorded rounding-remainder tolerance",
  },
  {
    component: "Oracle verification (ed25519 precompile + scanner checks)",
    classification: "REAL",
    detail:
      "real precompile verify + scanner offset/signer/staleness checks; attestations signed by local throwaway oracle keys (never production custody)",
  },
  {
    component: "Raydium V4 withdrawal CPI",
    classification: "REAL",
    detail:
      "REAL mainnet raydium_v4.so bytes loaded locally at the canonical program ID; the vault's withdraw CPI executes against it with real mainnet pool/vault accounts. ONLY the withdraw leg is exercised — the conversion/swap leg is config-skipped and covered by the Jupiter v6 entry (NOT TESTED)",
  },
  {
    component: "Serum/OpenBook market leg",
    classification: "REAL (bytes) / UNMODIFIED fixture",
    detail:
      "real serum_dex.so + the UNMODIFIED real market accounts (stored nonce 1, real vault owners); fleet-core (since its Finding E remediation) derives the vault signer with the real OpenBook rule and validates the true market relationship at stage 10",
  },
  {
    component: "Jupiter v6 integration",
    classification: "NOT TESTED",
    detail:
      "conversion leg config-skipped (dust threshold u64::MAX, canonical full_lifecycle_fork shape C3); the route-account shim satisfies fleet-core destination validation but is NEVER executed on-chain — no claim of real Jupiter execution is made",
  },
  {
    component: "Merkle proof generation",
    classification: "REAL",
    detail:
      "snapshotter Rust artifact proofs drive stage 14 claims + A9 negatives; TS buildMerkleTree is a port cross-check",
  },
  {
    component: "LP-holder claims (claim_lp_proceeds)",
    classification: "REAL",
    detail:
      "three real claims paid exactly floor(pool × balance / supply); duplicates/tampered/inflated proofs rejected (A9a–c) with zero movement",
  },
  {
    component: "Settlement accounting (40/40/20)",
    classification: "REAL",
    detail:
      "receipt legs 40/40/20 bps ± 1 lamport + PDA balance cross-checks + salvage receipt accounting (stage 12/13)",
  },
  {
    component: "Dust handling (sweep_dust)",
    classification: "REAL",
    detail:
      "permissionless sweep to treasury + one-shot guard (re-sweep observed 3012; 7021 fork-covered — Finding C)",
  },
  {
    component: "Devnet/Mainnet deployment acceptance (verify_ns3_deployment.mjs)",
    classification: "NOT TESTED",
    detail:
      "owner-executed, read-only, against the public cluster — out of W1 scope (no public-cluster operations permitted)",
  },
];

export const PROVES = [
  "the approved NS-3 GraveScanner + GraveVault artifacts (sha256-verified) initialize, certify (two-epoch), salvage (real Raydium V4 withdraw CPI), settle 40/40/20, serve Merkle claims, sweep dust, and pause/unpause — all on a local validator, through the real SDK/RPC/fleet-core paths",
  "the adversarial battery's exact-code rejections hold on the real programs (unauthorized callers, bad oracles, bad signatures, stale/premature evidence, replay, tampered snapshots/proofs, duplicate actions) with measured zero state movement",
  "the local rehearsal needs NO Devnet or Mainnet program bytes for GraveScanner/GraveVault",
];

export const DOES_NOT_PROVE = [
  "real Jupiter v6 route execution or any Raydium conversion/swap leg (the conversion leg is config-skipped; the route shim is never executed on-chain)",
  "public-cluster behavior: devnet/mainnet state, fees, congestion, production oracle attestation delivery (the NS-3 deployment acceptance is an owner-executed read-only step)",
  "fleet-core discovery against a LIVE public-cluster market (the local market IS the real mainnet fixture, unmodified, and the real OpenBook rule is validated locally — but live-cluster markets can present account states a static fixture cannot)",
  "production custody-key operations (throwaway identities only, by design — PR #81)",
];

// Markdown table-cell escaping. The transformation ORDER is load-bearing:
//   1. string coercion (nullish → ""),
//   2. CRLF / LF / CR line breaks → single space (a raw newline inside a
//      table cell would split the row and inject extra table lines),
//   3. backslash doubling — MUST precede the pipe escape: a cell value
//      containing `\|` (or a lone trailing `\`) would otherwise survive as
//      an unescaped backslash and either absorb the escaped pipe (a `\\`
//      renders as a literal `\`, leaving the pipe live as a cell separator
//      and silently adding a column) or escape the cell's trailing
//      character,
//   4. pipe escape.
// Doubling `\` first keeps every output pipe odd-backslash-escaped and the
// column layout unambiguous. (CodeQL js/incomplete-string-escaping-or-encoding
// — alert #1.)
export function esc(s) {
  return String(s ?? "")
    .replace(/\r\n/g, " ")
    .replace(/[\r\n]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

// Writes the mandatory Markdown summary and stamps the machine-readable JSON
// with an explicit `reporting` marker. Reporting is part of the W1 result:
// a missing Markdown summary (or an unstampeable JSON) makes the run
// INCOMPLETE even if every lifecycle stage passed. Returns { ok, error,
// mdPath }; on failure `error` names the exact reporting operation that
// failed (MARKDOWN vs JSON) and the JSON — when writable — records
// reporting.complete = false so an on-disk report can never masquerade as
// complete. Genuine lifecycle results are never touched.
export function completeReporting(doc, outJsonPath) {
  let error = null;
  let mdPath = null;
  try {
    mdPath = writeSummaryFiles(doc, outJsonPath);
  } catch (e) {
    error = `MARKDOWN summary generation FAILED — mandatory W1 report missing: ${e?.message ?? e}`;
  }
  try {
    const onDisk = JSON.parse(readFileSync(outJsonPath, "utf8"));
    onDisk.reporting = {
      complete: error === null,
      markdown_path: mdPath,
      error,
    };
    writeFileSync(outJsonPath, JSON.stringify(onDisk, null, 2) + "\n");
  } catch (e) {
    const jsonErr = `JSON report update FAILED — cannot stamp reporting status onto ${outJsonPath}: ${e?.message ?? e}`;
    error = error ? `${error} | ${jsonErr}` : jsonErr;
  }
  return { ok: error === null, error, mdPath };
}

// Final exit decision for the W1 driver. Genuine lifecycle failures and
// reporting failures are reported SIDE BY SIDE — a reporting error must
// never overwrite (or be written over) a real stage failure, and a passing
// lifecycle must never mask a missing mandatory report.
export function w1ExitStatus(doc, reporting) {
  const reasons = [];
  if (!doc.all_pass)
    reasons.push(
      "lifecycle results: at least one stage or adversarial case FAILED (see the run report JSON for the exact failures)",
    );
  if (reporting && !reporting.ok)
    reasons.push(`mandatory reporting incomplete: ${reporting.error}`);
  return { code: reasons.length === 0 ? 0 : 1, reasons };
}

export function renderSummary(doc) {
  const lines = [];
  lines.push(`# W1 Lifecycle Rehearsal — Run Summary`);
  lines.push("");
  lines.push(
    `- started: ${doc.started_at} · finished: ${doc.finished_at} · **all_pass: ${doc.all_pass}**`,
  );
  const m = doc.meta ?? {};
  lines.push(`- repository: ${m.repository ?? "n/a"}`);
  lines.push(`- base: ${m.base_branch ?? "n/a"} @ ${m.base_commit ?? "n/a"}`);
  lines.push(`- feature: ${m.feature_branch ?? "n/a"} @ ${m.feature_commit ?? "n/a"}`);
  const t = m.toolchain ?? {};
  lines.push(
    `- toolchain: ${t.solana_cli ?? "n/a"} · ${t.cargo_build_sbf ?? "n/a"} · platform-tools ${t.platform_tools_version ?? "n/a"} · node ${t.node ?? "n/a"}`,
  );
  lines.push(
    `- programs: scanner \`${m.program_ids?.scanner}\` · vault \`${m.program_ids?.vault}\` · raydium_v4 \`${m.program_ids?.raydium_v4}\``,
  );
  // Salvor checkout provenance (W1 §11): the fleet-core/monitor source
  // revision is part of the execution environment. Missing provenance is
  // stated explicitly — never silently omitted.
  const sp = m.salvor_provenance ?? {};
  if (sp.inspectable) {
    lines.push(
      `- salvor-bots: \`${sp.head}\`${sp.branch ? ` @ ${sp.branch}` : ""}${sp.repository ? ` · ${sp.repository}` : ""} · ${sp.dirty === true ? "DIRTY working tree" : sp.dirty === false ? "clean" : "dirty/clean UNKNOWN"}`,
    );
  } else {
    lines.push(`- salvor-bots: provenance UNAVAILABLE (path: ${sp.path ?? "n/a"})`);
  }
  if (sp.note) lines.push(`  - LIMITATION: ${sp.note}`);
  const stage1 = (doc.stages ?? []).find((s) => Number(s.id) === 1);
  if (stage1?.genesis_hash) lines.push(`- local validator genesis: \`${stage1.genesis_hash}\``);
  lines.push("");
  lines.push(`## What this run genuinely proves`);
  for (const p of PROVES) lines.push(`- ${p}`);
  lines.push("");
  lines.push(`## What this run does NOT prove`);
  for (const p of DOES_NOT_PROVE) lines.push(`- ${p}`);
  lines.push("");
  lines.push(`## Component classification (W1 §9)`);
  lines.push("");
  lines.push(`| Component | Class | Evidence in this run |`);
  lines.push(`|---|---|---|`);
  for (const c of COMPONENT_CLASSIFICATION) {
    lines.push(`| ${esc(c.component)} | ${c.classification} | ${esc(c.detail)} |`);
  }
  lines.push("");
  lines.push(`## Stage results (PASS/FAIL)`);
  lines.push("");
  lines.push(`| # | Stage | Result | Detail |`);
  lines.push(`|---|---|---|---|`);
  for (const s of doc.stages ?? []) {
    lines.push(
      `| ${s.id} | ${esc(s.name)} | ${s.pass ? "PASS" : "FAIL"} | ${esc(s.detail ?? s.reason ?? "")} |`,
    );
  }
  lines.push("");
  lines.push(`## Adversarial battery`);
  lines.push("");
  lines.push(`| ID | Case | Expected | Observed | Result | Zero movement |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const a of doc.adversarial ?? []) {
    const expected =
      a.expected?.code !== undefined
        ? `code ${a.expected.code}`
        : `family ${a.expected?.family ?? "?"}`;
    const observed =
      a.observed?.code != null ? `code ${a.observed.code}` : `family ${a.observed?.family ?? "?"}`;
    lines.push(
      `| ${a.id} | ${esc(a.name)} | ${expected} | ${observed} | ${a.pass ? "PASS" : "FAIL"} | ${a.zero_movement?.proved ? "proved" : "FAILED"} |`,
    );
  }
  lines.push("");
  lines.push(`## Labeled boundaries (none silent)`);
  for (const b of doc.boundaries ?? []) lines.push(`- ${b}`);
  lines.push("");
  lines.push(
    `_Rule: INCOMPLETE is never reported as PASS — every stage above is a measured result; \`all_pass: ${doc.all_pass}\` requires every stage AND every adversarial case to have passed._`,
  );
  lines.push("");
  return lines.join("\n");
}

export function writeSummaryFiles(doc, outJsonPath) {
  const mdPath = outJsonPath.replace(/\.json$/, "") + ".summary.md";
  writeFileSync(mdPath, renderSummary(doc) + "\n");
  return mdPath;
}
