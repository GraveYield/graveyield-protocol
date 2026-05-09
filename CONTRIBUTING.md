# Contributing to GraveYield Protocol

Thank you for your interest in GraveYield. This document covers the contribution workflow,
coding standards, and the **non-negotiable terminology rules** every contribution must follow.

## Table of contents

1. [Terminology — read this first](#terminology--read-this-first)
2. [Development environment](#development-environment)
3. [Workflow](#workflow)
4. [Coding standards](#coding-standards)
5. [Commit messages and PRs](#commit-messages-and-prs)
6. [Charter invariants — what cannot change](#charter-invariants--what-cannot-change)

---

## Terminology — read this first

GraveYield uses **maritime salvage** vocabulary deliberately. The protocol is **settlement
infrastructure**, not a rescue programme. The actor performing a salvage is a **finder under
maritime salvage law**, not a savior.

The following words are **forbidden** anywhere in the project — code, comments, doc-strings,
markdown, PR titles, PR bodies, commit messages, issue titles, UI copy:

| ❌ Forbidden          | ✅ Required (canonical v4.0) |
|-----------------------|-------------------------------|
| `rescue`              | `salvage`                     |
| `rescuer`             | `salvor`                      |
| `dead pool`           | `derelict pool`               |
| `RescueReceipt`       | `SalvageReceipt`              |
| `rescue_pool`         | `salvage_pool`                |
| `RescueCompleted`     | `SalvageCompleted`            |
| `PoolRescued`         | `PoolSalvaged`                |

CI runs a terminology lint over the entire repo. PRs introducing forbidden terms will fail
status checks. See [`docs/glossary.md`](docs/glossary.md) for the full canonical glossary.

## Development environment

```bash
./scripts/check-toolchain.sh       # verify pinned versions
pnpm install                       # JS workspace deps
anchor build                       # build Anchor programs
pnpm -r typecheck                  # TypeScript typecheck
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
anchor test                        # localnet integration tests
```

Required toolchain (pinned in `rust-toolchain.toml`, `Anchor.toml`, `package.json`):

- Solana CLI **2.0.x**
- Anchor **0.31.x**
- Rust **1.79+** stable
- Node **20 LTS**
- pnpm **9**

## Workflow

1. **Branch**: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`, or
   `docs/<short-name>`. Direct pushes to `main` are blocked by branch protection.
2. **Sign your commits** — `git commit -S`. Unsigned commits are rejected by branch protection.
3. **One logical change per PR** — surgical PRs review faster and revert cleanly.
4. **Keep CI green** — `cargo fmt`, `cargo clippy`, `anchor build`, and `pnpm -r typecheck` must
   all pass before review.
5. **PR review**: one approving review from a maintainer is required to merge.

## Coding standards

### Rust / Anchor

- `rustfmt` is the formatter; configuration is the workspace default.
- `clippy --all-targets -- -D warnings` must pass — warnings are errors in CI.
- Every `#[error_code]` variant gets a doc-comment explaining when it fires.
- Account constraints use `#[account(...)]` annotations; manual checks in handler bodies are
  reserved for cross-account invariants that cannot be expressed declaratively.
- `unsafe` is forbidden in on-chain code.
- All on-chain monetary calculations use checked arithmetic. Saturating or wrapping arithmetic
  must be justified in a comment.
- PDAs use the seed conventions documented in
  [`docs/architecture/eligibility-anchors.md`](docs/architecture/eligibility-anchors.md) and the
  combined GraveScanner × GraveVault doc. Do not invent new seed schemes ad-hoc.

### TypeScript

- `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Public SDK types are exported from `sdk/src/index.ts` only; internal types stay non-exported.
- All async functions handle their own errors at boundaries; no swallowing.

### Documentation

- Living source of truth lives in `docs/` as markdown. The `.docx` originals in `docs/published/`
  are immutable publishing snapshots — never edit those.
- When you change protocol behaviour, update both the relevant code AND the relevant doc in
  the same PR. Spec drift is treated as a bug.

## Commit messages and PRs

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(grave-vault): add claim_lp_proceeds instruction
fix(grave-scanner): tighten epoch confirmation check
docs(charter): clarify 20% protocol-share ceiling
chore(ci): pin anchor 0.31.1
```

Scopes mirror the workspace tree: `grave-scanner`, `grave-vault`, `sdk`, `indexer`, `adapters`,
`docs`, `ci`, `chore`.

PR descriptions should answer:

1. **Why** — what problem this solves or capability it adds.
2. **What** — the on-chain or off-chain change in 2–4 bullets.
3. **Risk** — invariants touched, migration steps, audit-relevant surface.
4. **Tests** — what was tested, what wasn't, and why.

## Charter invariants — what cannot change

These are protocol-level prohibitions encoded as constants and enforced at the program level.
A PR that touches them is automatically out-of-scope for normal review and must be flagged for
governance discussion before any code is written:

- **20% protocol share is a ceiling**, not a target. It can be lowered by governance with a
  72h timelock, but **cannot be raised**.
- **`lp_holder_pool_vault` is unsweepable** by any admin key, ever. Emergency pause does not
  affect this.
- **Standard upgrades** require 7-day public notice + 72h timelock.
- **Emergency upgrades** require 24h timelock + 5-day public post-mortem.
- **`claim_lp_proceeds` stays live during emergency pause** — original LPs can always withdraw
  their settled share.
- **No token, NFT, points programme, airdrop, or staking** at any layer.

See [`docs/architecture/charter-invariants.md`](docs/architecture/charter-invariants.md) for the
full list and rationale.
