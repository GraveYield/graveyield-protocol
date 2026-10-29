// SPDX-License-Identifier: Apache-2.0
//
// elf_dump.mjs — program-dump extraction + verification (Finding A fix).
//
// Guarantees (W1 follow-up, Finding A):
//   1. The destination file is REMOVED before the dump starts, so a failed
//      dump can never leave a stale binary from a previous run in place.
//   2. The subprocess result is fully checked: spawn error, termination
//      signal, and exit status. Any failure aborts immediately.
//   3. The produced file must exist, be non-empty, meet the harness minimum
//      size, and carry a real SBF ELF header (magic + 64-bit LSB +
//      e_machine 247 EM_BPF/EM_SBF).
//   4. Provenance: the dumped bytes are byte-compared against the on-chain
//      program data fetched fresh over RPC (read-only getAccountInfo). If
//      byte-identity cannot be established, the dump FAILS — no hash or
//      provenance claim is invented.
//
// Only public diagnostics are emitted: program id, RPC url, sizes, exit
// codes, stderr tails. Nothing here prints key material (there is none).
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** e_machine values the agave bpf_loader accepts for Solana programs:
 * EM_BPF = 247 (legacy eBPF value) and EM_SBF = 263 (SBF spec value emitted
 * by newer toolchains). Both load — proven by the validator itself every
 * rehearsal run (stage 1 boots the dumped ELF under agave 3.0.10). */
export const SBF_E_MACHINES = [247, 263];

/** Reject anything below the harness's long-standing minimum dump size. */
export const DEFAULT_MIN_DUMP_BYTES = 100_000;

const BPF_LOADER_V2 = "BPFLoader21111111111111111111111111111111111111";
const BPF_LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";

/** Validate a buffer as a 64-bit LSB SBF ELF (magic + class + machine). */
export function validateSbfElfBytes(buf, label) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) {
    throw new Error(`${label}: too small to be an ELF (${buf ? buf.length : 0} B)`);
  }
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error(`${label}: missing ELF magic (0x7f 'E' 'L' 'F')`);
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new Error(
      `${label}: not a 64-bit little-endian ELF (EI_CLASS=${buf[4]} EI_DATA=${buf[5]})`,
    );
  }
  const eMachine = buf.readUInt16LE(18);
  if (!SBF_E_MACHINES.includes(eMachine)) {
    throw new Error(
      `${label}: e_machine ${eMachine} not in {${SBF_E_MACHINES.join(", ")}} (EM_BPF/EM_SBF) — not a Solana SBF program`,
    );
  }
  return true;
}

/**
 * Byte-match a dumped ELF against the raw on-chain account data.
 *
 * Loader-v2 programs store the ELF directly in the program account
 * (exact byte equality).
 *
 * Loader-v3 (upgradeable) programs store the ELF in the ProgramData account
 * after a state header, and the ELF runs to the EXACT END of the account.
 * Known header lengths (empirically pinned + structurally derived):
 *   45 = u32 variant + u64 slot + u8 Option tag + 32 B authority
 *        (packed layout written by current agave — verified byte-for-byte
 *        against devnet ProgramData accounts, 2026-10-29)
 *   13 = same packed layout with authority = None
 *   48 = legacy bincode layout with authority (u32 option tag)
 *   16 = legacy bincode layout without authority
 * Anything else is refused — fail closed on unrecognized layouts.
 */
export function matchOnChainProgramData(elfBuf, onChainData) {
  if (elfBuf.length === onChainData.length) {
    return {
      match: elfBuf.equals(onChainData),
      headerLen: 0,
      layout: "elf stored directly in the on-chain program account (loader-v2 layout)",
    };
  }
  for (const headerLen of [45, 13, 48, 16]) {
    if (onChainData.length > headerLen && elfBuf.length === onChainData.length - headerLen) {
      return {
        match: elfBuf.equals(onChainData.subarray(headerLen)),
        headerLen,
        layout: `byte-identical to on-chain programdata payload after a ${headerLen} B upgradeable-loader state header`,
      };
    }
  }
  return { match: false, headerLen: null, layout: null };
}

function tail(buf, max = 400) {
  if (!buf) return "";
  const s = Buffer.from(buf).toString("utf8");
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/** Default dump runner: `solana program dump <id> <out> --url <rpc>`. */
function defaultRunDump({ programId, outPath, rpcUrl }) {
  const r = spawnSync("solana", ["program", "dump", programId, outPath, "--url", rpcUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    error: r.error ? String(r.error.message ?? r.error) : null,
    signal: r.signal ?? null,
    status: r.status,
    stdout: r.stdout ?? null,
    stderr: r.stderr ?? null,
  };
}

/** Default RPC reader: jsonrpc getAccountInfo (base64) over global fetch. */
async function defaultFetchAccountData(programId, rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [programId, { encoding: "base64" }],
    }),
  });
  if (!res.ok) throw new Error(`getAccountInfo(${programId}) HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) {
    throw new Error(`getAccountInfo(${programId}) RPC error: ${JSON.stringify(j.error)}`);
  }
  const info = j.result && j.result.value;
  if (!info) {
    throw new Error(`on-chain account ${programId} not found — provenance cannot be established`);
  }
  return { owner: info.owner, data: Buffer.from(info.data[0], "base64") };
}

/**
 * Dump one program and verify it end-to-end. Throws on ANY failure; on
 * success returns the pin metadata (sha256, sizes, provenance layout).
 */
export async function dumpAndVerifyElf({
  programId,
  outPath,
  rpcUrl,
  minBytes = DEFAULT_MIN_DUMP_BYTES,
  runDump = defaultRunDump,
  fetchAccountData = defaultFetchAccountData,
}) {
  // 1. Isolate: a pre-existing artifact must never survive into this dump.
  rmSync(outPath, { force: true });

  // 2. Dump with full subprocess-result checking.
  const r = runDump({ programId, outPath, rpcUrl });
  if (r.error) {
    throw new Error(`program dump ${programId}: spawn error: ${r.error}`);
  }
  if (r.signal) {
    throw new Error(
      `program dump ${programId}: terminated by signal ${r.signal}${tail(r.stderr) ? ` — ${tail(r.stderr)}` : ""}`,
    );
  }
  if (r.status !== 0) {
    throw new Error(
      `program dump ${programId}: exit ${r.status}${tail(r.stderr) ? ` — ${tail(r.stderr)}` : ""}`,
    );
  }

  // 3. Output validation: exists, non-empty, minimum size, real SBF ELF.
  const st = statSync(outPath, { throwIfNoEntry: false });
  if (!st) {
    throw new Error(`program dump ${programId}: exit 0 but no output file at ${outPath}`);
  }
  if (st.size === 0) {
    throw new Error(`program dump ${programId}: output file is empty`);
  }
  if (st.size < minBytes) {
    throw new Error(`program dump ${programId}: output ${st.size} B < minimum ${minBytes} B`);
  }
  const buf = readFileSync(outPath);
  validateSbfElfBytes(buf, `program dump ${programId}`);

  // 4. Provenance: byte-identity against fresh on-chain program data.
  const progAcct = await fetchAccountData(programId, rpcUrl);
  let onChainData = progAcct.data;
  if (progAcct.owner === BPF_LOADER_V3) {
    // The ELF lives in the ProgramData account. Its address is DETERMINISTIC:
    // the upgradeable loader derives it as find_program_address([programId],
    // loaderId) — verified against live devnet ProgramData accounts on
    // 2026-10-29 (the derived account exists, is owned by the loader, and its
    // payload byte-matches the dump). No CLI, no keypair/config dependency.
    const [dataAddr] = await PublicKey.findProgramAddress(
      [new PublicKey(programId).toBytes()],
      new PublicKey(BPF_LOADER_V3),
    );
    onChainData = (await fetchAccountData(dataAddr.toBase58(), rpcUrl)).data;
  } else if (progAcct.owner !== BPF_LOADER_V2) {
    // Not a loader-v3 program account owner we recognize — refuse rather
    // than guess the layout.
    throw new Error(
      `provenance for ${programId}: program account owner ${progAcct.owner} is neither ${BPF_LOADER_V2} nor ${BPF_LOADER_V3} — refusing to pin`,
    );
  }
  const m = matchOnChainProgramData(buf, onChainData);
  if (!m.match) {
    throw new Error(
      `provenance for ${programId}: dumped ELF (${buf.length} B) is NOT byte-identical to the on-chain program data (${onChainData.length} B) — refusing to pin`,
    );
  }

  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: st.size,
    program_id: programId,
    on_chain_match: true,
    provenance: `dumped via solana program dump; byte-identical to on-chain program data at ${rpcUrl} (${m.layout})`,
    dumped_at: new Date().toISOString(),
  };
}
