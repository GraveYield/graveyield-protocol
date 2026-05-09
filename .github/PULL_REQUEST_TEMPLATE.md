<!--
Thanks for opening a PR against GraveYield Protocol.
Read CONTRIBUTING.md before your first contribution — especially the terminology rules.
-->

## Why

<!-- What problem does this solve or capability does it add? Link issues. -->

## What

<!-- 2-4 bullets describing the on-chain or off-chain change. -->

-
-

## Risk

<!-- Charter invariants touched? Migration steps? Audit-relevant surface? -->

- Charter invariants touched: <!-- e.g., none, 20% ceiling, lp_holder_pool_vault, timelock -->
- Migration required: <!-- yes/no — if yes, describe -->
- Audit surface: <!-- new accounts, new instructions, new CPIs -->

## Tests

<!-- What was tested? What wasn't, and why? -->

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] `anchor build`
- [ ] `pnpm -r typecheck`
- [ ] `anchor test`
- [ ] `bash scripts/terminology-lint.sh`

## Checklist

- [ ] Commits are signed (`git commit -S`).
- [ ] Branch follows `feat/`, `fix/`, `chore/`, or `docs/` prefix.
- [ ] Conventional Commit messages.
- [ ] Spec changes are reflected in `docs/` in the same PR.
- [ ] Canonical v4.0 terminology only — see [`docs/glossary.md`](../docs/glossary.md)
      for the full mapping.
