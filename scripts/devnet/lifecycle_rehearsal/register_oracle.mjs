// register_oracle.mjs — the oracle registration governance action.
// No SDK client method exists (deliberate, per ORACLE_CUSTODY.md: "governance
// action, not a pipeline action"). The borsh shape is the proven
// scanner_windows_fork.rs L575-598 layout:
//   disc(8) = sha256("global:update_protocol_config")[0..8]
//   + 6×Option::None (6× 0x00) + Option<activity_oracle> + Option<launch_price_oracle>
//   both Some = 8 + 6 + 33 + 33 = 80 bytes
//   accounts: [protocol_config PDA (mut), authority (signer)]
import { createHash } from "node:crypto";
import { sendTx, IDS, pk, bigIntSafe } from "./lib.mjs";

export function configPda(programId) {
  const { PublicKey } = IDS.scanner.constructor;
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_config", "utf8")], programId)[0];
}

export function buildRegisterOracleIx({ scannerProgramId, authority, activityOracle, launchPriceOracle }) {
  const disc = createHash("sha256").update("global:update_protocol_config").digest().subarray(0, 8);
  const data = Buffer.concat([
    Buffer.from(disc),
    Buffer.alloc(6, 0x00), // 6× Option::None
    Buffer.from([0x01]), activityOracle.toBytes(),
    Buffer.from([0x01]), launchPriceOracle.toBytes(),
  ]);
  if (data.length !== 80) throw new Error(`update_protocol_config data must be 80B, got ${data.length}`);
  return {
    ix: {
      programId: scannerProgramId,
      keys: [
        { pubkey: configPda(scannerProgramId), isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: true },
      ],
      data,
    },
    dataLen: data.length,
  };
}

export async function registerOracles({ connection, authorityKeypair, activityOracle, launchPriceOracle }) {
  const { ix } = buildRegisterOracleIx({
    scannerProgramId: IDS.scanner,
    authority: authorityKeypair.publicKey,
    activityOracle,
    launchPriceOracle,
  });
  const r = await sendTx(connection, [ix], [authorityKeypair]);
  if (r.err) throw new Error(`register_oracle failed: ${JSON.stringify(bigIntSafe(r.err))} logs=${(r.logs ?? []).slice(-4)}`);
  return r.sig;
}

export async function readbackAssertOracles({ connection, SDK, activityOracle, launchPriceOracle }) {
  const cfgPda = configPda(IDS.scanner);
  const cfg = await SDK.fetchScannerProtocolConfig(connection, cfgPda);
  if (!cfg) throw new Error("scanner ProtocolConfig not found after oracle registration");
  if (cfg.activityOracle?.toBase58?.() !== activityOracle.toBase58()) {
    throw new Error(`activity oracle readback mismatch: ${cfg.activityOracle} vs ${activityOracle.toBase58()}`);
  }
  if (cfg.launchPriceOracle?.toBase58?.() !== launchPriceOracle.toBase58()) {
    throw new Error(`launch price oracle readback mismatch: ${cfg.launchPriceOracle} vs ${launchPriceOracle.toBase58()}`);
  }
  return cfg;
}
