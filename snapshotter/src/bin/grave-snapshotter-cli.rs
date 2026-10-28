// grave-snapshotter-cli.rs — W1 Lifecycle Rehearsal Harness: the REAL Rust
// snapshotter binary (stage 9 of the run matrix).
//
// The snapshotter crate is lib-only by design; this bin target (added by W1,
// lib untouched) runs the REAL SnapshotBuilder + SnapshotArtifact::seal
// against the local validator RPC and writes the deterministic artifact JSON.
// The driver asserts root/supply/holder equality between this artifact and
// the SDK snapshot fleet-core feeds into the salvage.
use grave_snapshotter::rpc::RpcLpAccountSource;
use grave_snapshotter::{InMemoryLocks, SnapshotArtifact, SnapshotBuilder, SnapshotRequest, SnapshotMerkleTree};
use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

struct Args {
    url: String,
    pool: Pubkey,
    amm: Pubkey,
    lp_mint: Pubkey,
    out: String,
}

fn parse_args() -> Args {
    let mut url: Option<String> = None;
    let mut pool: Option<Pubkey> = None;
    let mut amm: Option<Pubkey> = None;
    let mut lp_mint: Option<Pubkey> = None;
    let mut out: Option<String> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut take = |slot: &mut Option<String>| {
            *slot = it.next();
        };
        match a.as_str() {
            "--url" => take(&mut url),
            "--pool" => pool = Some(Pubkey::from_str(&it.next().expect("--pool value")).expect("pool pubkey")),
            "--amm" => amm = Some(Pubkey::from_str(&it.next().expect("--amm value")).expect("amm pubkey")),
            "--lp-mint" => lp_mint = Some(Pubkey::from_str(&it.next().expect("--lp-mint value")).expect("lp mint pubkey")),
            "--out" => take(&mut out),
            other => {
                eprintln!("unknown arg {other}; usage: grave-snapshotter-cli --url <rpc> --pool <P> --amm <A> --lp-mint <M> --out <file.json>");
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
    ];
    if missing.iter().any(|(_, m)| *m) {
        eprintln!(
            "missing {:?}; usage: grave-snapshotter-cli --url <rpc> --pool <P> --amm <A> --lp-mint <M> --out <file.json>",
            missing.iter().filter(|(_, m)| *m).map(|(n, _)| *n).collect::<Vec<_>>()
        );
        std::process::exit(2);
    }
    Args {
        url: url.unwrap(),
        pool: pool.unwrap(),
        amm: amm.unwrap(),
        lp_mint: lp_mint.unwrap(),
        out: out.unwrap(),
    }
}

fn main() {
    let args = parse_args();
    let client = RpcClient::new(args.url.clone());
    eprintln!(
        "grave-snapshotter-cli: pool={} amm={} lp_mint={} url={}",
        args.pool, args.amm, args.lp_mint, args.url
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

    let source = RpcLpAccountSource::new(client);
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
        "grave-snapshotter-cli: root={} leaves={} depth={} -> {}",
        hex(&artifact.root()),
        tree.leaf_count(),
        tree.tree_depth(),
        args.out
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
