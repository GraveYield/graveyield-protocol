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
use grave_snapshotter::rpc::{parse_commitment, RpcLpAccountSource};
use grave_snapshotter::{
    InMemoryLocks, SnapshotArtifact, SnapshotBuilder, SnapshotMerkleTree, SnapshotRequest,
};
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
}

const USAGE: &str = "grave-snapshotter-cli --url <rpc> --pool <P> --amm <A> --lp-mint <M> --out <file.json> --commitment <confirmed|finalized>";

/// Parse the `--commitment` value. Required (no default), and unsupported
/// levels (`processed`, unknown names) are rejected — never silently mapped
/// to a client default. Factored out for deterministic unit tests.
fn commitment_from_flag(value: Option<&str>) -> Result<CommitmentConfig, String> {
    let name =
        value.ok_or("--commitment is required; usage: --commitment <confirmed|finalized>")?;
    parse_commitment(name).map_err(|e| e.to_string())
}

fn parse_args() -> Args {
    let mut url: Option<String> = None;
    let mut pool: Option<Pubkey> = None;
    let mut amm: Option<Pubkey> = None;
    let mut lp_mint: Option<Pubkey> = None;
    let mut out: Option<String> = None;
    let mut commitment: Option<String> = None;
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
    let commitment = match commitment_from_flag(commitment.as_deref()) {
        Ok(c) => c,
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
    }
}

fn main() {
    let args = parse_args();
    // The CLI and the library source share this exact commitment: the
    // client is constructed with it and every source read carries it
    // explicitly — there is no implicit client default anywhere in the run.
    let client = RpcClient::new_with_commitment(args.url.clone(), args.commitment);
    eprintln!(
        "grave-snapshotter-cli: pool={} amm={} lp_mint={} commitment={} url={}",
        args.pool, args.amm, args.lp_mint, args.commitment.commitment, args.url
    );

    let request = SnapshotRequest {
        pool_address: args.pool,
        amm_program_id: args.amm,
        lp_mint: args.lp_mint,
        sink_exclusions: Vec::new(),
        custody_owner_overrides: Vec::new(),
    };
    let builder = SnapshotBuilder::new(request);

    // Local rehearsal: the UNCX per-pool lock marker is absent from the local
    // validator (proven-unlocked path, PoolEnv::scanner_remaining precedent),
    // so the locked-LP evidence set is empty — the honest local mirror.
    let locks = InMemoryLocks::from_records(&args.pool, &args.lp_mint, Vec::new());

    let source = match RpcLpAccountSource::new(client, args.commitment) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("grave-snapshotter-cli: source configuration rejected: {e:?}");
            std::process::exit(1);
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
    let artifact = match SnapshotArtifact::seal(&snapshot, &tree) {
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
        "grave-snapshotter-cli: root={} leaves={} depth={} slot={} -> {}",
        hex(&artifact.root()),
        tree.leaf_count(),
        tree.tree_depth(),
        artifact.snapshot_slot,
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
        // Supported values parse.
        assert!(commitment_from_flag(Some("confirmed")).is_ok());
        assert!(commitment_from_flag(Some("finalized")).is_ok());
        // Speculative or unknown values are rejected, not mapped to a default.
        assert!(commitment_from_flag(Some("processed")).is_err());
        assert!(commitment_from_flag(Some("")).is_err());
        assert!(commitment_from_flag(Some("Confirmed")).is_err());
    }
}
