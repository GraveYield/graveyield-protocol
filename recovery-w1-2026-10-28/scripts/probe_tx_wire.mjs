// probe_tx_wire.mjs — diagnose agave 3.0.10 vs web3.js 3.1.1 legacy tx serialization.
// Tries three send paths against a running local validator and reports which wire
// forms are accepted.
import { Connection, Keypair, Transaction, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const URL = "http://127.0.0.1:8899";
const connection = new Connection(URL, "confirmed");
const kp = await Keypair.fromSecretKey(Keypair.generate().secretKey);
console.log("probe wallet:", kp.publicKey.toBase58());

const airdropSig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
await connection.confirmTransaction(airdropSig, "confirmed");
console.log("airdrop confirmed:", airdropSig.slice(0, 16));

const dest = Keypair.generate().publicKey;
const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: 1000n });

// --- Path A: legacy Transaction + partialSign + serialize + sendRawTransaction(skipPreflight)
try {
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = kp.publicKey;
  await tx.partialSign(kp);
  const raw = tx.serialize();
  console.log("A: legacy wire bytes =", raw.length, "head:", Buffer.from(raw.subarray(0, 16)).toString("hex"));
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("A: OK", conf.value.err === null ? "landed" : JSON.stringify(conf.value.err));
} catch (e) {
  console.log("A: FAIL —", String(e?.message ?? e).slice(0, 160));
}

// --- Path B: connection.sendTransaction(tx, [kp]) (library-internal sign path)
try {
  const tx2 = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: 1000n }));
  const sig2 = await connection.sendTransaction(tx2, [kp]);
  const conf2 = await connection.confirmTransaction(sig2, "confirmed");
  console.log("B: OK", conf2.value.err === null ? "landed" : JSON.stringify(conf2.value.err));
} catch (e) {
  console.log("B: FAIL —", String(e?.message ?? e).slice(0, 160));
}

// --- Path C: VersionedTransaction v0
try {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: 1000n })] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([kp]);
  const sig3 = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig3, "confirmed");
  console.log("C: OK landed");
} catch (e) {
  console.log("C: FAIL —", String(e?.message ?? e).slice(0, 160));
}
process.exit(0);
