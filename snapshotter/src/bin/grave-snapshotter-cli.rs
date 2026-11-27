// grave-snapshotter-cli.rs — W1 Lifecycle Rehearsal Harness: the REAL Rust
// snapshotter binary (stage 9 of the run matrix).
//
// The snapshotter crate is lib-only by design; this bin target (added by W1,
// lib untouched) runs the REAL SnapshotBuilder + SnapshotArtifact::seal
// against the local validator RPC and writes the deterministic artifact JSON.
// The driver asserts root/supply/holder equality between this artifact and
// the SDK snapshot fleet-core feeds into the salvage.
//
// CONSISTENT-STATE PLUMBING (WD-02 fix)
//
// The commitment is an explicit, required CLI argument: the CLI and the
// library source use the SAME effective commitment (the client is
// constructed with it AND every source read carries it), and unsupported
// configurations (`processed`, unknown names) are rejected instead of
// silently falling back to a client default.
//
// GOVERNED INPUTS (WD-07 fix)
//
// `--lock-evidence rpc` is REQUIRED: the real `RpcLockedLpEvidence` (UNCX
// Raydium AMM V4 `getProgramAccounts`, pinned to the same commitment and
// anchor slot as the holder enumeration) is always consulted, so locked LP
// can never silently become an ordinary custody-PDA holder leaf because the
// CLI supplied an empty lock list. Unavailable, malformed, ambiguous, or
// unsupported evidence fails closed — it is never replaced with an empty
// lock list. In-repository adapter support is UNCX-specific (LOCKER-001);
// other locker protocols require separate validation before reliance.
//
// `--sink-ledger <file>` is optional: when supplied, the governed
// sink-exclusion ledger (`gy.sink-ledger.v1`, D-04-C/D) is validated and
// applied exactly; a malformed, unsupported, duplicate, ambiguous, or
// mismatched ledger aborts the run and is never silently reduced to an
// empty ledger. A schema-valid ledger is NOT proof of owner approval —
// that is a D-04-D process control outside this binary. When omitted, no
// exclusions are applied and the sealed artifact records the absence
// explicitly (no sink-ledger provenance).
//
// The sealed artifact carries provenance for both inputs (ledger id /
// version / exact-input SHA-256; lock-evidence source / program /
// commitment / anchor slot), so an independent reviewer can establish
// which governed inputs produced it.
use grave_snapshotter::artifact::{
    ArtifactProvenance, LockEvidenceProvenance, SinkLedgerProvenance,
};
use grave_snapshotter::rpc::{parse_commitment, RpcLockedLpEvidence, RpcLpAccountSource};
use grave_snapshotter::sink_ledger::SinkLedger;
use grave_snapshotter::{SnapshotArtifact, SnapshotBuilder, SnapshotMerkleTree, SnapshotRequest};
use solana_client::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

struct Args {
    url: String,
    pool: Pubkey,
    amm: Pubkey,
    lp_mint: Pubkey,
    out: String,
    commitment: CommitmentConfig,
    /// The `--commitment` name as supplied (log context only; never
    /// logged alongside or as part of the RPC URL — D1-01).
    commitment_name: String,
    sink_ledger: Option<String>,
    lock_evidence: LockEvidenceMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockEvidenceMode {
    /// Real UNCX locker evidence from the configured RPC (the only
    /// supported production mode).
    Rpc,
}

const USAGE: &str = "grave-snapshotter-cli --url <rpc> --pool <P> --amm <A> --lp-mint <M> --out <file.json> --commitment <confirmed|finalized> --lock-evidence rpc [--sink-ledger <file>]";

/// Parse the `--commitment` value. Required (no default), and unsupported
/// levels (`processed`, unknown names) are rejected — never silently mapped
/// to a client default. Factored out for deterministic unit tests.
/// Returns the parsed commitment together with the CLI name as supplied
/// (used for log context only — never for the RPC URL).
fn commitment_from_flag(value: Option<&str>) -> Result<(CommitmentConfig, String), String> {
    let name =
        value.ok_or("--commitment is required; usage: --commitment <confirmed|finalized>")?;
    let commitment = parse_commitment(name).map_err(|e| e.to_string())?;
    Ok((commitment, name.to_string()))
}

/// The startup context line, built EXCLUSIVELY from non-sensitive
/// operational fields (D1-01 / D2-01): pool address, AMM program id, LP
/// mint, commitment, lock-evidence mode, sink-ledger path, and output
/// path.
///
/// The RPC URL is deliberately NOT a parameter of this function: the
/// signature makes it structurally impossible for provider credentials
/// embedded in the endpoint (host, path, query parameters, API keys) to
/// reach the log — there is no URL-redaction logic to get wrong, because
/// no URL ever enters the logging path.
fn startup_context_line(
    pool: &Pubkey,
    amm: &Pubkey,
    lp_mint: &Pubkey,
    commitment: &str,
    lock_evidence: &str,
    sink_ledger: &str,
    out: &str,
) -> String {
    format!(
        "grave-snapshotter-cli: pool={pool} amm={amm} lp_mint={lp_mint} \
         commitment={commitment} lock_evidence={lock_evidence} \
         sink_ledger={sink_ledger} out={out}"
    )
}

/// Parse the `--lock-evidence` value. Required; only `rpc` is supported —
/// the CLI must never substitute an empty lock list for real locker
/// evidence (WD-07). Factored out for deterministic unit tests.
fn lock_evidence_from_flag(value: Option<&str>) -> Result<LockEvidenceMode, String> {
    match value {
        Some("rpc") => Ok(LockEvidenceMode::Rpc),
        Some(other) => Err(format!(
            "unsupported lock evidence mode `{other}`; supported values: rpc \
             (real UNCX locker evidence from the configured RPC)"
        )),
        None => Err(
            "--lock-evidence is required; usage: --lock-evidence rpc. Locked LP must never \
             silently become an ordinary custody-PDA holder leaf because the CLI supplied \
             an empty lock list"
                .to_string(),
        ),
    }
}

fn parse_args() -> Args {
    let mut url: Option<String> = None;
    let mut pool: Option<Pubkey> = None;
    let mut amm: Option<Pubkey> = None;
    let mut lp_mint: Option<Pubkey> = None;
    let mut out: Option<String> = None;
    let mut commitment: Option<String> = None;
    let mut sink_ledger: Option<String> = None;
    let mut lock_evidence: Option<String> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut take = |slot: &mut Option<String>| {
            *slot = it.next();
        };
        match a.as_str() {
            "--url" => take(&mut url),
            "--pool" => {
                pool =
                    Some(Pubkey::from_str(&it.next().expect("--pool value")).expect("pool pubkey"))
            }
            "--amm" => {
                amm = Some(Pubkey::from_str(&it.next().expect("--amm value")).expect("amm pubkey"))
            }
            "--lp-mint" => {
                lp_mint = Some(
                    Pubkey::from_str(&it.next().expect("--lp-mint value")).expect("lp mint pubkey"),
                )
            }
            "--out" => take(&mut out),
            "--commitment" => take(&mut commitment),
            "--sink-ledger" => take(&mut sink_ledger),
            "--lock-evidence" => take(&mut lock_evidence),
            other => {
                eprintln!("unknown arg {other}; usage: {USAGE}");
                std::process::exit(2);
            }
        }
    }
    let missing = [
        ("--url", url.is_none()),
        ("--pool", pool.is_none()),
        ("--amm", amm.is_none()),
        ("--lp-mint", lp_mint.is_none()),
        ("--out", out.is_none()),
        ("--commitment", commitment.is_none()),
        ("--lock-evidence", lock_evidence.is_none()),
    ];
    if missing.iter().any(|(_, m)| *m) {
        eprintln!(
            "missing {:?}; usage: {}",
            missing
                .iter()
                .filter(|(_, m)| *m)
                .map(|(n, _)| *n)
                .collect::<Vec<_>>(),
            USAGE
        );
        std::process::exit(2);
    }
    let (commitment, commitment_name) = match commitment_from_flag(commitment.as_deref()) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("grave-snapshotter-cli: {msg}");
            std::process::exit(2);
        }
    };
    let lock_evidence = match lock_evidence_from_flag(lock_evidence.as_deref()) {
        Ok(m) => m,
        Err(msg) => {
            eprintln!("grave-snapshotter-cli: {msg}");
            std::process::exit(2);
        }
    };
    Args {
        url: url.unwrap(),
        pool: pool.unwrap(),
        amm: amm.unwrap(),
        lp_mint: lp_mint.unwrap(),
        out: out.unwrap(),
        commitment,
        commitment_name,
        sink_ledger,
        lock_evidence,
    }
}

fn main() {
    let args = parse_args();
    // The CLI and the library source share this exact commitment: the
    // clients are constructed with it and every source read carries it
    // explicitly — there is no implicit client default anywhere in the run.
    let client = RpcClient::new_with_commitment(args.url.clone(), args.commitment);
    // Startup context (D1-01 / D2-01): non-sensitive operational fields
    // only. The RPC URL — including any credentials embedded in it — is
    // never logged; `startup_context_line` cannot even accept one.
    eprintln!(
        "{}",
        startup_context_line(
            &args.pool,
            &args.amm,
            &args.lp_mint,
            &args.commitment_name,
            "rpc",
            args.sink_ledger.as_deref().unwrap_or("<none>"),
            &args.out,
        )
    );

    // Governed sink ledger (optional): parse + structural validation of the
    // EXACT input bytes before anything else. A supplied-but-invalid ledger
    // aborts the run — it is never silently reduced to an empty ledger.
    let (ledger, ledger_digest) = match &args.sink_ledger {
        Some(path) => {
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!(
                        "grave-snapshotter-cli: sink ledger {} unreadable: {e}; \
                         refusing to continue without it",
                        path
                    );
                    std::process::exit(1);
                }
            };
            let digest = SinkLedger::input_digest_hex(&bytes);
            match SinkLedger::parse(&bytes) {
                Ok(l) => (Some(l), digest),
                Err(e) => {
                    eprintln!("grave-snapshotter-cli: sink ledger rejected: {e}");
                    std::process::exit(1);
                }
            }
        }
        None => (None, String::new()),
    };

    let request = SnapshotRequest {
        pool_address: args.pool,
        amm_program_id: args.amm,
        lp_mint: args.lp_mint,
        // Governed exclusions: exactly the ledger's owners when a ledger is
        // supplied (the builder enforces equality), otherwise none.
        sink_exclusions: ledger
            .as_ref()
            .map(|l| l.entries.iter().map(|e| e.owner).collect())
            .unwrap_or_default(),
        custody_owner_overrides: Vec::new(),
        sink_ledger: ledger.clone(),
    };
    let builder = SnapshotBuilder::new(request);

    let source = match RpcLpAccountSource::new(client, args.commitment) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("grave-snapshotter-cli: source configuration rejected: {e:?}");
            std::process::exit(1);
        }
    };
    // Real UNCX locker evidence from the configured RPC — pinned to the
    // same commitment; the builder pins the query to the same anchor slot
    // as the enumeration. Never an empty lock list (WD-07). `rpc` is the
    // only supported mode (enforced in parse_args).
    let locks = match args.lock_evidence {
        LockEvidenceMode::Rpc => {
            let lock_client = RpcClient::new_with_commitment(args.url.clone(), args.commitment);
            match RpcLockedLpEvidence::new(lock_client, args.commitment) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("grave-snapshotter-cli: lock evidence configuration rejected: {e:?}");
                    std::process::exit(1);
                }
            }
        }
    };
    let snapshot = match builder.build(&source, &locks) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("grave-snapshotter-cli: snapshot build failed: {e:?}");
            std::process::exit(1);
        }
    };
    let tree = match SnapshotMerkleTree::from_snapshot(&snapshot) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("grave-snapshotter-cli: tree build failed: {e:?}");
            std::process::exit(1);
        }
    };
    // Sealed provenance: the sink ledger's identity/version/exact-input
    // digest and the lock-evidence source/context, cross-checked against
    // the snapshot before sealing.
    let provenance = ArtifactProvenance {
        sink_ledger: ledger.map(|l| SinkLedgerProvenance {
            schema_version: l.schema_version,
            ledger_id: l.ledger_id.clone(),
            input_sha256: ledger_digest.clone(),
            entry_count: l.entries.len(),
            sink_exclusions_total: snapshot.reconciliation.sink_exclusions_total,
        }),
        lock_evidence: LockEvidenceProvenance {
            source: "rpc".to_string(),
            program_id: grave_snapshotter::locked::uncx::PROGRAM_ID.to_string(),
            commitment: args.commitment_name.clone(),
            anchor_slot: snapshot.snapshot_slot,
            records_seen: snapshot.locked.lock_records_seen,
            total_locked: snapshot.locked.total_locked,
        },
    };
    let artifact = match SnapshotArtifact::seal_with_provenance(&snapshot, &tree, provenance) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("grave-snapshotter-cli: artifact seal failed: {e:?}");
            std::process::exit(1);
        }
    };
    if let Err(e) = artifact.verify_integrity() {
        eprintln!("grave-snapshotter-cli: artifact integrity check failed: {e:?}");
        std::process::exit(1);
    }
    let json = match artifact.to_json_pretty() {
        Ok(j) => j,
        Err(e) => {
            eprintln!("grave-snapshotter-cli: serialization failed: {e:?}");
            std::process::exit(1);
        }
    };
    if let Err(e) = std::fs::write(&args.out, json + "\n") {
        eprintln!("grave-snapshotter-cli: write {} failed: {e}", args.out);
        std::process::exit(1);
    }
    eprintln!(
        "grave-snapshotter-cli: root={} leaves={} depth={} slot={} locks={} -> {}",
        hex(&artifact.root()),
        tree.leaf_count(),
        tree.tree_depth(),
        artifact.snapshot_slot,
        artifact.locked.total_locked,
        args.out
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_flag_is_required_and_strict() {
        // Missing flag: rejected, no default.
        assert!(commitment_from_flag(None).is_err());
        // Supported values parse (and the CLI name is preserved for log
        // context and provenance).
        let (_, name) = commitment_from_flag(Some("confirmed")).unwrap();
        assert_eq!(name, "confirmed");
        let (_, name) = commitment_from_flag(Some("finalized")).unwrap();
        assert_eq!(name, "finalized");
        // Speculative or unknown values are rejected, not mapped to a default.
        assert!(commitment_from_flag(Some("processed")).is_err());
        assert!(commitment_from_flag(Some("")).is_err());
        assert!(commitment_from_flag(Some("Confirmed")).is_err());
    }

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    /// D1-01 / D2-01 regression: the startup context line carries only
    /// non-sensitive operational fields. It must never contain an RPC URL
    /// (scheme, host separator, or a `url` field), because
    /// `startup_context_line` cannot even receive one — provider
    /// credentials embedded in the endpoint therefore cannot leak into the
    /// log.
    #[test]
    fn startup_context_line_never_contains_the_rpc_url() {
        let line = startup_context_line(
            &key(0xAA),
            &key(0xAB),
            &key(0x01),
            "confirmed",
            "rpc",
            "<none>",
            "/tmp/artifact.json",
        );
        // No URL scheme, authority separator, or `url` field of any kind.
        assert!(
            !line.contains("http"),
            "log line must not contain a URL: {line}"
        );
        assert!(
            !line.contains("://"),
            "log line must not contain a URL: {line}"
        );
        assert!(
            !line.contains("url"),
            "log line must not contain a URL field: {line}"
        );
        // Useful non-sensitive operational context is retained.
        for field in [
            "pool=",
            "amm=",
            "lp_mint=",
            "commitment=",
            "lock_evidence=",
            "sink_ledger=",
            "out=",
        ] {
            assert!(
                line.contains(field),
                "missing context field `{field}`: {line}"
            );
        }
        // Even a credential-bearing input can only reach the line through
        // the declared parameters — the commitment name and output path are
        // echoed verbatim, but no endpoint ever is.
        let line = startup_context_line(
            &key(0xAA),
            &key(0xAB),
            &key(0x01),
            "finalized",
            "rpc",
            "<none>",
            "/tmp/artifact.json",
        );
        assert!(!line.contains("https"));
        assert!(line.contains("commitment=finalized"));
    }

    #[test]
    fn lock_evidence_flag_is_required_and_rpc_only() {
        // Missing flag: rejected — an empty lock list is never an acceptable
        // substitute for real locker evidence (WD-07 regression).
        assert!(lock_evidence_from_flag(None).is_err());
        // The only supported mode is the real RPC evidence source.
        assert_eq!(
            lock_evidence_from_flag(Some("rpc")).unwrap(),
            LockEvidenceMode::Rpc
        );
        // Anything else (file, none, empty, future names) is rejected.
        assert!(lock_evidence_from_flag(Some("none")).is_err());
        assert!(lock_evidence_from_flag(Some("file")).is_err());
        assert!(lock_evidence_from_flag(Some("")).is_err());
        assert!(lock_evidence_from_flag(Some("RPC")).is_err());
    }
}
