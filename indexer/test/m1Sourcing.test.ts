// SPDX-License-Identifier: Apache-2.0
//
// D-01 M1 WSOL quote-side sourcing enforcement tests (GY-M1-ODR-001 §3)
// across the indexer pipeline boundaries:
//
//   * CandidateQueue.enqueue — the single candidate-ingestion choke
//     point: mis-oriented candidates are refused admission (never
//     stored), including direct programmatic injection (the bypass
//     attempt).
//   * GraveScannerV2.runOnce — the discovery gate rejects non-M1 pools
//     BEFORE any enrichment work, from ANY registered source, so an
//     adversarial/alternate discovery source cannot bypass the filter.
//   * submitCandidate — defense-in-depth before any attestation material
//     or transaction is produced.
//   * Non-M1 behavior is preserved when enforcement is explicitly off.
//   * M1_SOURCING_ENFORCED config parsing fails closed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";

import {
  CandidateQueue,
  GraveScannerV2,
  loadConfig,
  submitCandidate,
  type AmmSource,
  type Candidate,
  type DiscoveredPool,
  type IndexerConfig,
} from "../src/index.js";
import { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID } from "../src/index.js";
import {
  encodeBase58,
  RAYDIUM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "@graveyield/sdk";

const MEMECOIN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const AMM = RAYDIUM_V4_PROGRAM_ID;

function synth(seed: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(seed));
}

/** Valid pool: coin_mint = memecoin (non-WSOL), pc_mint = WSOL. */
const VALID_POOL = synth(0x01);
const COIN_VAULT = synth(0xc1);
const PC_VAULT = synth(0xc2);
const LP_MINT = synth(0x04);
const BASE_MINT = synth(0x05); // memecoin (coin_mint)
const NOW_SEC = Math.floor(Date.now() / 1000);

function makeCandidate(pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): Candidate {
  return {
    poolAddress: pool,
    ammProgramId: AMM,
    discovery: {
      poolAddress: pool,
      pool: {
        coinVault: synth(0xa1),
        pcVault: synth(0xa2),
        baseMint,
        quoteMint,
        lpMint: synth(0xa4),
      },
      fetchedAtSlot: 0,
    },
    activity: {
      poolAddress: pool,
      lastSwapUnixTs: NOW_SEC - 100 * 86_400,
      lastSwapSlot: 900_000,
      lastSwapSignature: "5" + "a".repeat(86),
      noSwapFound: false,
      unresolved: false,
    },
    reserves: {
      poolAddress: pool,
      coinReserve: 1_000_000n,
      pcReserve: 600_000_000n,
      lpSupply: 10_000_000n,
      wsolSideIdentified: true,
      tvlLamports: 600_000_000n,
    },
    metadata: {
      poolAddress: pool,
      baseMint,
      baseDecimals: 6,
      baseSupply: 1_000_000_000n,
      quoteMint,
      quoteDecimals: 9,
      quoteSupply: 0n,
      lpMint: synth(0xa4),
      lpDecimals: 2,
      lpSupply: 10_000_000n,
    },
    preFilter: { poolAddress: pool, passed: true, failedCriteria: [], criteriaBitmap: 0x3f },
  };
}

function score(candidate: Candidate, scoreValue: number) {
  return {
    candidate,
    score: scoreValue,
    scoreBreakdown: { inactivityMargin: 0, tvlMargin: 0, priceCollapseMargin: 0 },
  };
}

// ---------------------------------------------------------------------------
// CandidateQueue — the ingestion choke point
// ---------------------------------------------------------------------------

describe("CandidateQueue — D-01 M1 sourcing admission (default enforced)", () => {
  test("PASS: pc_mint WSOL + coin_mint non-WSOL is admitted", () => {
    const queue = new CandidateQueue();
    const admission = queue.enqueue(score(makeCandidate(VALID_POOL, BASE_MINT, WSOL_MINT), 1));
    assert.deepEqual(admission, { admitted: true });
    assert.equal(queue.size(), 1);
  });

  test("REJECT: WSOL on coin_mint — refused and never stored", () => {
    const pool = synth(0x02);
    const queue = new CandidateQueue();
    const admission = queue.enqueue(score(makeCandidate(pool, WSOL_MINT, MEMECOIN), 1));
    assert.equal(admission.admitted, false);
    if (!admission.admitted) {
      assert.equal(admission.reason, "wsol-on-coin-side");
      assert.ok(admission.detail.includes("quote side"));
    }
    assert.equal(queue.size(), 0, "rejected candidate must NOT enter the M1 candidate queue");
    assert.equal(queue.has(pool.toBase58()), false);
  });

  test("REJECT: neither mint WSOL / both mints WSOL", () => {
    const queue = new CandidateQueue();
    const none = queue.enqueue(score(makeCandidate(synth(0x03), MEMECOIN, synth(0x33)), 1));
    assert.equal(none.admitted, false);
    if (!none.admitted) assert.equal(none.reason, "no-wsol-side");
    const both = queue.enqueue(score(makeCandidate(synth(0x04), WSOL_MINT, WSOL_MINT), 1));
    assert.equal(both.admitted, false);
    if (!both.admitted) assert.equal(both.reason, "both-sides-wsol");
    assert.equal(queue.size(), 0);
  });

  test("REJECT: direct programmatic injection cannot bypass the gate", () => {
    // The queue is the choke point — a candidate injected directly (no
    // discovery, no pre-filter) still fails the exact predicate.
    const pool = synth(0x05);
    const queue = new CandidateQueue();
    const bad = makeCandidate(pool, WSOL_MINT, MEMECOIN); // coin-WSOL
    bad.preFilter = { poolAddress: pool, passed: true, failedCriteria: [], criteriaBitmap: 0x3f };
    const admission = queue.enqueue(score(bad, 100));
    assert.equal(admission.admitted, false);
    assert.equal(queue.size(), 0);
  });

  test("trust boundary: forged metadata claiming a valid orientation is ADMITTED (metadata screening only) and rejected by the authoritative submission gate", async () => {
    // Honest trust-boundary pin (review finding): the queue gate
    // evaluates the discovery record's mint metadata and holds NO RPC
    // connection — it never fetches the on-chain pool account. A record
    // forged to CLAIM the M1-eligible orientation (coin=memecoin,
    // pc=WSOL) while the ACTUAL on-chain account is coin-WSOL is
    // therefore ADMITTED here and occupies queue capacity. The
    // authoritative on-chain verification is the submission gate:
    // submitCandidate re-fetches + decodes the pool account
    // (fetchV4Pool — Raydium owner + canonical 752-byte layout) and
    // re-applies the SAME shared predicate to the decoded values, so
    // the forged candidate is skipped before any attestation material
    // or transaction is built.
    const pool = synth(0x07);
    let rpcCalls = 0;
    const actualPoolIsCoinWsol = {
      async getAccountInfo(address: PublicKey) {
        rpcCalls++;
        if (address.equals(pool)) {
          return {
            lamports: 1_000_000,
            data: Buffer.from(ammInfoBytes({ baseMint: WSOL_MINT, quoteMint: MEMECOIN })),
            owner: AMM,
            executable: false,
            rentEpoch: 0n,
          } as unknown as AccountInfo<Uint8Array>;
        }
        return null;
      },
    } as unknown as Connection;

    const queue = new CandidateQueue();
    const admission = queue.enqueue(score(makeCandidate(pool, BASE_MINT, WSOL_MINT), 1));
    assert.deepEqual(
      admission,
      { admitted: true },
      "the queue screens metadata only — a record claiming the M1-eligible orientation is admitted",
    );
    assert.equal(queue.size(), 1);
    assert.equal(
      rpcCalls,
      0,
      "enqueue must NOT fetch the on-chain pool account — metadata screening boundary",
    );

    // The authoritative gate decides on the DECODED account, not the
    // claimed metadata: the forged candidate is rejected at submission.
    const result = await submitCandidate(
      actualPoolIsCoinWsol,
      makeSubmitConfig(),
      makeCandidate(pool, BASE_MINT, WSOL_MINT),
    );
    assert.equal(result.status, "skipped");
    assert.ok(result.error?.startsWith("m1-sourcing-rejected: wsol-on-coin-side"), result.error);
  });

  test("non-M1 mode: enforcement off preserves the existing admission behavior", () => {
    const queue = new CandidateQueue({ m1SourcingEnforced: false });
    const coinWsol = makeCandidate(synth(0x06), WSOL_MINT, MEMECOIN);
    assert.deepEqual(queue.enqueue(score(coinWsol, 1)), { admitted: true });
    assert.equal(queue.size(), 1);
  });
});

// ---------------------------------------------------------------------------
// GraveScannerV2.runOnce — no bypass through an alternate discovery source
// ---------------------------------------------------------------------------

/** Canonical 165-byte SPL token account (mint @0, amount @64 LE). */
function tokenAccountBytes(mint: PublicKey, amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  buf.set(mint.toBytes(), 0);
  new DataView(buf.buffer).setBigUint64(64, amount, true);
  buf[108] = 1; // state = initialized
  return buf;
}

/** Canonical 82-byte SPL mint account (supply @36, decimals @44). */
function mintBytes(decimals: number, supply: bigint): Uint8Array {
  const buf = new Uint8Array(82);
  new DataView(buf.buffer).setBigUint64(36, supply, true);
  buf[44] = decimals;
  buf[45] = 1;
  return buf;
}

/** Raydium V4 instruction data for `tag` + 16 zero arg bytes. */
function v4TagData(tag: number): string {
  const data = new Uint8Array(17);
  data[0] = tag;
  return encodeBase58(data);
}

/**
 * Fake connection serving the enrichment surface for the VALID pool
 * (reserves, metadata, verified last-swap history) and NOTHING for the
 * adversarial pools — any RPC touch on an adversarial pool would fail
 * the test, proving the discovery gate rejects before enrichment.
 */
class PipelineFakeRpc {
  queried = new Set<string>();

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  assertNotQueried(address: PublicKey, what: string): void {
    assert.ok(
      !this.queried.has(address.toBase58()),
      `${what} must be rejected before any enrichment RPC (queried ${address.toBase58()})`,
    );
  }

  async getSignaturesForAddress(address: PublicKey): Promise<Array<unknown>> {
    this.queried.add(address.toBase58());
    return [
      {
        signature: "SIG_VERIFIED",
        slot: BigInt(900_000),
        blockTime: BigInt(NOW_SEC - 100 * 86_400),
        err: null,
        confirmationStatus: "finalized",
      },
    ];
  }

  async getTransaction(_signature: string): Promise<unknown> {
    return {
      slot: 900_000n,
      blockTime: BigInt(NOW_SEC - 100 * 86_400),
      transaction: {
        message: {
          getAccountKeys: () => ({
            keySegments: () => [[AMM, VALID_POOL, COIN_VAULT, PC_VAULT]],
          }),
          compiledInstructions: [
            {
              programIdIndex: 0,
              accountKeyIndexes: [1, 2, 3],
              data: v4TagData(9), // SwapBaseIn — verified economic swap
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
        preTokenBalances: [
          { accountIndex: 2, uiTokenAmount: { amount: "1000000" } },
          { accountIndex: 3, uiTokenAmount: { amount: "100000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, uiTokenAmount: { amount: "1100000" } },
          { accountIndex: 3, uiTokenAmount: { amount: "90000" } },
        ],
      },
    };
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    this.queried.add(address.toBase58());
    const info = (data: Uint8Array, owner: PublicKey) =>
      ({
        lamports: 1_000_000,
        data: Buffer.from(data),
        owner,
        executable: false,
        rentEpoch: 0n,
      }) as unknown as AccountInfo<Uint8Array>;
    if (address.equals(VALID_POOL)) {
      return info(
        (() => {
          const buf = new Uint8Array(752);
          buf.set(COIN_VAULT.toBytes(), 336);
          buf.set(PC_VAULT.toBytes(), 368);
          return buf;
        })(),
        AMM,
      );
    }
    if (address.equals(COIN_VAULT))
      return info(tokenAccountBytes(BASE_MINT, 1_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(PC_VAULT))
      return info(tokenAccountBytes(WSOL_MINT, 600_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(LP_MINT)) return info(mintBytes(2, 10_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(BASE_MINT)) return info(mintBytes(6, 1_000_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(WSOL_MINT)) return info(mintBytes(9, 0n), SPL_TOKEN_PROGRAM_ID);
    return null;
  }
}

function staticSource(name: string, pools: DiscoveredPool[]): AmmSource {
  return {
    name,
    programId: AMM,
    async *enumeratePools(): AsyncIterable<DiscoveredPool> {
      for (const pool of pools) yield pool;
    },
  };
}

function validDiscoveredPool(): DiscoveredPool {
  return {
    poolAddress: VALID_POOL,
    pool: {
      coinVault: COIN_VAULT,
      pcVault: PC_VAULT,
      baseMint: BASE_MINT,
      quoteMint: WSOL_MINT,
      lpMint: LP_MINT,
    },
    fetchedAtSlot: 0,
  };
}

describe("GraveScannerV2.runOnce — the discovery filter cannot be bypassed", () => {
  test("adversarial alternate source: every mis-oriented pool rejected before enrichment; only the M1-eligible pool reaches the queue", async () => {
    const rpc = new PipelineFakeRpc();
    const coinWsolPool = synth(0x20);
    const noWsolPool = synth(0x21);
    const bothWsolPool = synth(0x22);

    const scanner = new GraveScannerV2({
      connection: rpc as unknown as Connection,
      // Source A — the canonical discovery path; Source B — an
      // adversarial/alternate ingestion path feeding mis-oriented pools.
      sources: [
        staticSource("canonical", [validDiscoveredPool()]),
        staticSource("adversarial", [
          {
            poolAddress: coinWsolPool,
            pool: {
              coinVault: synth(0xd1),
              pcVault: synth(0xd2),
              baseMint: WSOL_MINT,
              quoteMint: MEMECOIN,
              lpMint: synth(0xd4),
            },
            fetchedAtSlot: 0,
          },
          {
            poolAddress: noWsolPool,
            pool: {
              coinVault: synth(0xd5),
              pcVault: synth(0xd6),
              baseMint: MEMECOIN,
              quoteMint: synth(0xd7),
              lpMint: synth(0xd8),
            },
            fetchedAtSlot: 0,
          },
          {
            poolAddress: bothWsolPool,
            pool: {
              coinVault: synth(0xd9),
              pcVault: synth(0xda),
              baseMint: WSOL_MINT,
              quoteMint: WSOL_MINT,
              lpMint: synth(0xdb),
            },
            fetchedAtSlot: 0,
          },
        ]),
      ],
      maxCandidatesPerCycle: 0, // no submission in this test — ingestion only
      scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
      vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
      thresholds: {
        inactivitySeconds: 7_776_000n,
        priceCollapseBps: 9_900,
        minTvlLamports: 500_000_000n,
        lpBurnDustThreshold: 1_000n,
      },
    });

    const results = await scanner.runOnce();
    assert.deepEqual(results, [], "no submissions configured (drain 0)");

    // The M1-eligible pool passed discovery + pre-filter + the queue gate.
    assert.equal(scanner.queueSize(), 1, "exactly the M1-eligible candidate is queued");
    assert.ok(scanner["queue"].has(VALID_POOL.toBase58()));

    // Every adversarial pool was rejected by the discovery gate BEFORE
    // any enrichment RPC — they are absent from the queue and were never
    // touched by the activity/reserve/metadata stages.
    for (const pool of [coinWsolPool, noWsolPool, bothWsolPool]) {
      rpc.assertNotQueried(pool, "mis-oriented pool");
      assert.ok(!scanner["queue"].has(pool.toBase58()));
    }
  });

  test("enforcement explicitly off (non-M1): mis-oriented pools are no longer gated at discovery", async () => {
    const rpc = new PipelineFakeRpc();
    const coinWsolPool = synth(0x30);
    const scanner = new GraveScannerV2({
      connection: rpc as unknown as Connection,
      sources: [
        staticSource("adversarial", [
          {
            poolAddress: coinWsolPool,
            pool: {
              coinVault: synth(0xe1),
              pcVault: synth(0xe2),
              baseMint: WSOL_MINT,
              quoteMint: MEMECOIN,
              lpMint: synth(0xe4),
            },
            fetchedAtSlot: 0,
          },
        ]),
      ],
      maxCandidatesPerCycle: 0,
      m1SourcingEnforced: false, // explicit non-M1 operation
      scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
      vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
      thresholds: {
        inactivitySeconds: 7_776_000n,
        priceCollapseBps: 9_900,
        minTvlLamports: 500_000_000n,
        lpBurnDustThreshold: 1_000n,
      },
    });
    await scanner.runOnce();
    // The gate is off; the pool reaches enrichment (the RPC fake serves
    // nothing for it, so the pipeline skips it downstream) — the point is
    // that the M1 gate itself no longer rejects at discovery.
    assert.ok(
      rpc.queried.has(coinWsolPool.toBase58()),
      "pool reached enrichment with the gate off",
    );
    assert.equal(scanner.queueSize(), 0);
  });
});

// ---------------------------------------------------------------------------
// submitCandidate — defense-in-depth before any submission.
//
// The submission gate validates the ACTUAL on-chain pool account via the
// SDK's established fetch/decode path (`fetchV4Pool`: Raydium V4 owner
// check + canonical 752-byte AmmInfo, coin_mint @400 / pc_mint @432) and
// applies the shared predicate to the DECODED values — candidate-supplied
// mint metadata is never authoritative here.
// ---------------------------------------------------------------------------

/** Canonical 752-byte Raydium V4 AmmInfo with the SDK-parsed fields. */
function ammInfoBytes(opts: { baseMint: PublicKey; quoteMint: PublicKey }): Uint8Array {
  const buf = new Uint8Array(752);
  buf.set(COIN_VAULT.toBytes(), 336);
  buf.set(PC_VAULT.toBytes(), 368);
  buf.set(opts.baseMint.toBytes(), 400); // coin_mint
  buf.set(opts.quoteMint.toBytes(), 432); // pc_mint
  buf.set(LP_MINT.toBytes(), 464);
  return buf;
}

/** Minimal fake connection serving ONE pool account for `fetchV4Pool` (and nothing else). */
function poolAccountRpc(
  pool: PublicKey,
  data: Uint8Array | null,
  owner: PublicKey = AMM,
): Connection {
  return {
    async getAccountInfo(address: PublicKey) {
      if (data && address.equals(pool)) {
        return {
          lamports: 1_000_000,
          data: Buffer.from(data),
          owner,
          executable: false,
          rentEpoch: 0n,
        } as unknown as AccountInfo<Uint8Array>;
      }
      return null;
    },
  } as unknown as Connection;
}

function makeSubmitConfig(m1SourcingEnforced?: boolean): IndexerConfig {
  return {
    rpcUrl: "http://127.0.0.1:8899",
    cluster: "devnet",
    scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
    vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
    activityOracleSecretKey: null,
    activityOraclePublicKey: PublicKey.default,
    minTvlLamports: 500_000_000n,
    inactivitySeconds: 7_776_000n,
    priceCollapseBps: 9_900,
    lpBurnDustThreshold: 1_000n,
    maxCandidatesPerCycle: 10,
    pollIntervalMs: 1_000,
    maxPoolsPerScan: 100,
    signatureScanLimit: 1000,
    ...(m1SourcingEnforced !== undefined ? { m1SourcingEnforced } : {}),
  };
}

describe("submitCandidate — D-01 defense-in-depth (actual pool account, not candidate metadata)", () => {
  test("mis-oriented ACTUAL pool account is skipped with a machine-checkable reason; no tx is built or sent", async () => {
    let sendCalled = false;
    const send = async (): Promise<string> => {
      sendCalled = true;
      return "should-never-happen";
    };
    const pool = synth(0x40);
    const result = await submitCandidate(
      poolAccountRpc(pool, ammInfoBytes({ baseMint: WSOL_MINT, quoteMint: MEMECOIN })), // actual on-chain account: coin-WSOL
      makeSubmitConfig(),
      makeCandidate(pool, WSOL_MINT, MEMECOIN),
      { sendOverride: send as never },
    );
    assert.equal(result.status, "skipped");
    assert.ok(result.error?.startsWith("m1-sourcing-rejected: wsol-on-coin-side"), result.error);
    assert.equal(sendCalled, false, "no transaction may be sent for a mis-oriented candidate");
  });

  test("candidate metadata claiming a valid orientation cannot override an invalid ACTUAL pool account", async () => {
    const pool = synth(0x42);
    // The discovery record claims (coin=memecoin, pc=WSOL) — the exact
    // M1-eligible orientation — but the on-chain account is coin-WSOL.
    // The gate must decide on the DECODED account, not the metadata.
    const result = await submitCandidate(
      poolAccountRpc(pool, ammInfoBytes({ baseMint: WSOL_MINT, quoteMint: MEMECOIN })),
      makeSubmitConfig(),
      makeCandidate(pool, BASE_MINT, WSOL_MINT), // metadata CLAIMS pc_mint WSOL
    );
    assert.equal(result.status, "skipped");
    assert.ok(result.error?.startsWith("m1-sourcing-rejected: wsol-on-coin-side"), result.error);
  });

  test("decoded pool account with WSOL as pc_mint passes the gate and proceeds to the ordinary guards", async () => {
    const pool = synth(0x43);
    const result = await submitCandidate(
      poolAccountRpc(pool, ammInfoBytes({ baseMint: BASE_MINT, quoteMint: WSOL_MINT })),
      makeSubmitConfig(),
      makeCandidate(pool, BASE_MINT, WSOL_MINT),
    );
    assert.equal(result.status, "skipped");
    assert.ok(result.error?.includes("no activity oracle key"), result.error);
    assert.ok(!result.error?.includes("m1-sourcing-rejected"), result.error);
  });

  test("missing pool account is rejected (fail-closed, never accepted on claimed metadata)", async () => {
    const pool = synth(0x44);
    const result = await submitCandidate(
      poolAccountRpc(pool, null),
      makeSubmitConfig(),
      makeCandidate(pool, BASE_MINT, WSOL_MINT), // metadata claims a valid orientation
    );
    assert.equal(result.status, "skipped");
    assert.ok(
      result.error?.startsWith("m1-sourcing-rejected: unverifiable-orientation"),
      result.error,
    );
  });

  test("malformed pool account (non-canonical layout) is rejected (fail-closed)", async () => {
    const pool = synth(0x45);
    const result = await submitCandidate(
      poolAccountRpc(pool, new Uint8Array(700)),
      makeSubmitConfig(),
      makeCandidate(pool, BASE_MINT, WSOL_MINT),
    );
    assert.equal(result.status, "skipped");
    assert.ok(
      result.error?.startsWith("m1-sourcing-rejected: unverifiable-orientation"),
      result.error,
    );
  });

  test("non-Raydium pool owner is rejected (fail-closed)", async () => {
    const pool = synth(0x46);
    const result = await submitCandidate(
      poolAccountRpc(
        pool,
        ammInfoBytes({ baseMint: BASE_MINT, quoteMint: WSOL_MINT }),
        PublicKey.default,
      ),
      makeSubmitConfig(),
      makeCandidate(pool, BASE_MINT, WSOL_MINT),
    );
    assert.equal(result.status, "skipped");
    assert.ok(
      result.error?.startsWith("m1-sourcing-rejected: unverifiable-orientation"),
      result.error,
    );
  });

  test("with enforcement explicitly off, the same candidate reaches the ordinary guards (non-M1 behavior)", async () => {
    const result = await submitCandidate(
      new PublicKey(new Uint8Array(32).fill(1)) as unknown as Connection,
      makeSubmitConfig(false),
      makeCandidate(synth(0x41), WSOL_MINT, MEMECOIN),
    );
    // No oracle key configured → the ordinary discovery-only skip fires;
    // the M1 gate did not reject this candidate (and did not touch the RPC).
    assert.equal(result.status, "skipped");
    assert.ok(result.error?.includes("no activity oracle key"), result.error);
  });
});

// ---------------------------------------------------------------------------
// Config — fail-closed parsing
// ---------------------------------------------------------------------------

describe("M1_SOURCING_ENFORCED config parsing", () => {
  function withEnv(env: Record<string, string | undefined>): IndexerConfig {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return loadConfig();
    } finally {
      process.env = saved;
    }
  }

  test("unset → enforced (default ON for the M1 milestone)", () => {
    assert.equal(withEnv({ M1_SOURCING_ENFORCED: undefined }).m1SourcingEnforced, true);
  });

  test('exactly "false" disables (explicit non-M1 operation)', () => {
    assert.equal(withEnv({ M1_SOURCING_ENFORCED: "false" }).m1SourcingEnforced, false);
  });

  test("any other value fails closed to enforced", () => {
    for (const v of ["", "0", "no", "FALSE", "true", "1"]) {
      assert.equal(
        withEnv({ M1_SOURCING_ENFORCED: v }).m1SourcingEnforced,
        true,
        `M1_SOURCING_ENFORCED=${JSON.stringify(v)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// GraveScannerV2.runOnce → submitCandidate — enforcement-mode propagation.
//
// Finding-2 regression: runOnce must pass the SAME resolved
// m1SourcingEnforced mode it used for discovery/queueing into the
// submission configuration. A unit test of submitCandidate alone cannot
// prove this — these tests drive the full scanner cycle with the explicit
// non-M1 setting and observe the submission outcome.
// ---------------------------------------------------------------------------

/**
 * Fake connection for the full pipeline: enrichment surface for the
 * discovered pool (verified last-swap history, vault reserves, mint
 * metadata) PLUS the ACTUAL on-chain pool account served at the pool
 * address (what `fetchV4Pool` decodes at the submission gate). The
 * discovery record's metadata is independent of these bytes — which is
 * exactly the trust gap the submission gate must close.
 */
class SubmissionPipelineFakeRpc {
  queried = new Set<string>();

  constructor(
    readonly poolAddress: PublicKey,
    readonly actualPoolBytes: Uint8Array,
  ) {}

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  async getSignaturesForAddress(address: PublicKey): Promise<Array<unknown>> {
    this.queried.add(address.toBase58());
    return [
      {
        signature: "SIG_VERIFIED",
        slot: BigInt(900_000),
        blockTime: BigInt(NOW_SEC - 100 * 86_400),
        err: null,
        confirmationStatus: "finalized",
      },
    ];
  }

  async getTransaction(_signature: string): Promise<unknown> {
    return {
      slot: 900_000n,
      blockTime: BigInt(NOW_SEC - 100 * 86_400),
      transaction: {
        message: {
          getAccountKeys: () => ({
            keySegments: () => [[AMM, VALID_POOL, COIN_VAULT, PC_VAULT]],
          }),
          compiledInstructions: [
            {
              programIdIndex: 0,
              accountKeyIndexes: [1, 2, 3],
              data: v4TagData(9), // SwapBaseIn — verified economic swap
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
        preTokenBalances: [
          { accountIndex: 2, uiTokenAmount: { amount: "1000000" } },
          { accountIndex: 3, uiTokenAmount: { amount: "100000" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, uiTokenAmount: { amount: "1100000" } },
          { accountIndex: 3, uiTokenAmount: { amount: "90000" } },
        ],
      },
    };
  }

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    this.queried.add(address.toBase58());
    const info = (data: Uint8Array, owner: PublicKey) =>
      ({
        lamports: 1_000_000,
        data: Buffer.from(data),
        owner,
        executable: false,
        rentEpoch: 0n,
      }) as unknown as AccountInfo<Uint8Array>;
    if (address.equals(this.poolAddress)) {
      return info(this.actualPoolBytes, AMM); // the ACTUAL on-chain account
    }
    if (address.equals(COIN_VAULT))
      return info(tokenAccountBytes(BASE_MINT, 1_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(PC_VAULT))
      return info(tokenAccountBytes(WSOL_MINT, 600_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(LP_MINT)) return info(mintBytes(2, 10_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(BASE_MINT)) return info(mintBytes(6, 1_000_000_000n), SPL_TOKEN_PROGRAM_ID);
    if (address.equals(WSOL_MINT)) return info(mintBytes(9, 0n), SPL_TOKEN_PROGRAM_ID);
    return null;
  }
}

describe("GraveScannerV2.runOnce → submitCandidate — enforcement-mode propagation", () => {
  function propagationScanner(rpc: SubmissionPipelineFakeRpc, m1SourcingEnforced?: boolean) {
    return new GraveScannerV2({
      connection: rpc.asConnection(),
      // The discovery record CLAIMS the M1-eligible orientation
      // (coin=memecoin, pc=WSOL) — discovery and the queue gate accept it
      // in both tests below; the decisive check is the submission gate's
      // view of the ACTUAL on-chain account.
      sources: [staticSource("canonical", [validDiscoveredPool()])],
      maxCandidatesPerCycle: 5,
      ...(m1SourcingEnforced !== undefined ? { m1SourcingEnforced } : {}),
      scannerProgramId: DEVNET_SCANNER_PROGRAM_ID,
      vaultProgramId: DEVNET_VAULT_PROGRAM_ID,
      thresholds: {
        inactivitySeconds: 7_776_000n,
        priceCollapseBps: 9_900,
        minTvlLamports: 500_000_000n,
        lpBurnDustThreshold: 1_000n,
      },
    });
  }

  const misOrientedActualBytes = ammInfoBytes({ baseMint: WSOL_MINT, quoteMint: MEMECOIN });

  test("absent configuration (default enforced): a candidate whose ACTUAL pool account is mis-oriented is rejected at submission", async () => {
    const rpc = new SubmissionPipelineFakeRpc(VALID_POOL, misOrientedActualBytes);
    const scanner = propagationScanner(rpc); // m1SourcingEnforced absent → fail-closed default (enforced)
    const results = await scanner.runOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skipped");
    assert.ok(
      results[0].error?.startsWith("m1-sourcing-rejected: wsol-on-coin-side"),
      results[0].error,
    );
    // The discovery metadata claimed a valid orientation, so the candidate
    // passed discovery and the queue gate and reached the submission gate —
    // which rejected it on the decoded on-chain account.
  });

  test("M1_SOURCING_ENFORCED=false: the explicit non-M1 mode propagates through runOnce into submitCandidate — the M1-only restriction is NOT applied at submission", async () => {
    const rpc = new SubmissionPipelineFakeRpc(VALID_POOL, misOrientedActualBytes);
    const scanner = propagationScanner(rpc, false); // explicit non-M1 operation
    const results = await scanner.runOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skipped");
    // The candidate reached the ordinary discovery-only guard — the M1
    // sourcing gate did NOT fire at submission, proving the resolved
    // non-M1 mode was propagated from the scanner into the submission
    // configuration (a missing propagation would have returned
    // "m1-sourcing-rejected" here despite the explicit opt-out).
    assert.ok(results[0].error?.includes("no activity oracle key"), results[0].error);
    assert.ok(!results[0].error?.includes("m1-sourcing-rejected"), results[0].error);
  });

  test("default-enforced mode keeps the existing discovery + queue behavior consistent with the submission gate", async () => {
    // A genuinely valid pool (actual bytes agree with the metadata) flows
    // through discovery → queue → submission without any M1 rejection.
    const rpc = new SubmissionPipelineFakeRpc(
      VALID_POOL,
      ammInfoBytes({ baseMint: BASE_MINT, quoteMint: WSOL_MINT }),
    );
    const scanner = propagationScanner(rpc);
    const results = await scanner.runOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skipped");
    assert.ok(results[0].error?.includes("no activity oracle key"), results[0].error);
    assert.ok(!results[0].error?.includes("m1-sourcing-rejected"), results[0].error);
  });
});
