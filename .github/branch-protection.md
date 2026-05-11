# Branch Protection — Parked Configuration

**Status:** Parked. Not in effect on `graveyieldprotocol/protocol` while the repo is on
the free tier as a private personal-account repo — GitHub silently lets you save
Classic Branch Protection and Rulesets here but **neither enforces** until the
account upgrades to GitHub Pro ($4/mo) or higher, or the repo is transferred to an
org / flipped public.

**Apply this configuration the moment GitHub Pro is enabled on the
`graveyieldprotocol` account** — or earlier if the repo is moved to a `graveyield`
org or flipped public. Nothing in here changes unless `ci.yml`, `codeql.yml`, or
`CODEOWNERS` move first. If you change a CI job `name:`, update the required-checks
list in this file before pushing the workflow change.

There is no automation behind this file. Settings live in the GitHub UI;
Composio's GitHub integration on this account does not expose
`UPDATE_BRANCH_PROTECTION` / `CREATE_A_REPOSITORY_RULESET`. The agent cannot
apply these for you — copy/paste from this file into the GitHub UI, or use the
`gh` CLI block at the bottom.

---

## 1. Activation trigger

Apply when **any one** of the following becomes true:

1. The `graveyieldprotocol` account upgrades to GitHub Pro (or Team / Enterprise).
2. `graveyieldprotocol/protocol` is transferred to a `graveyield` GitHub Organization.
3. `graveyieldprotocol/protocol` is flipped public (devnet/audit prep).

Until then, CI gates + sole-committer discipline are the only real enforcement
layer. Don't bother applying any of the rules below pre-Pro — the UI accepts them
but they will not block anything.

---

## 2. Classic Branch Protection — `main`

Path: **Settings → Branches → Branch protection rules → Add rule**

| Field | Value |
| --- | --- |
| Branch name pattern | `main` |
| Require a pull request before merging | ✅ ON |
| Required approving reviews | `1` |
| Dismiss stale pull request approvals when new commits are pushed | ✅ ON |
| Require review from Code Owners | ✅ ON |
| Restrict who can dismiss pull request reviews | ⬜ OFF (leave default) |
| Allow specified actors to bypass required pull requests | ✅ ON, add `@graveyieldprotocol` as a bypass actor — **solo-founder carve-out only**, remove the moment a second human reviewer joins |
| Require approval of the most recent reviewable push | ✅ ON |
| Require status checks to pass before merging | ✅ ON |
| Require branches to be up to date before merging | ✅ ON |
| Required status checks (exact names — must match `ci.yml` job `name:` fields) | `cargo fmt --check`, `cargo clippy`, `anchor build`, `pnpm typecheck`, `terminology lint` |
| Require conversation resolution before merging | ✅ ON |
| Require signed commits | ✅ ON |
| Require linear history | ✅ ON |
| Require deployments to succeed before merging | ⬜ OFF (no deploy gates yet) |
| Lock branch | ⬜ OFF |
| Do not allow bypassing the above settings | ✅ ON — admins included; the bypass-actor row above is the only exception |
| Restrict who can push to matching branches | ✅ ON — leave actor list empty so only the bypass actor + PR merge flow can write to `main` |
| Allow force pushes | ⬜ OFF |
| Allow deletions | ⬜ OFF |

### Required status checks — when the repo flips public

The moment `graveyieldprotocol/protocol` is flipped public, CodeQL stops being
gated off in `.github/workflows/codeql.yml` and starts producing a status check.
Add it to the required list:

- `Analyze (javascript-typescript)` *(from `codeql.yml`)*

If a Rust CodeQL pack is added later, also require `Analyze (rust)`.

---

## 3. Tag protection — `refs/tags/v*`

Release tags (`v0.1.0`, `v1.0.0`, …) must be signed and undeletable. Classic
"Tag protection rules" only blocks creation/deletion by non-admins — they don't
enforce signing. Use a **Ruleset** instead.

Path: **Settings → Rules → Rulesets → New ruleset → New tag ruleset**

| Field | Value |
| --- | --- |
| Name | `signed-release-tags` |
| Enforcement status | `Active` |
| Bypass list | `@graveyieldprotocol` (Always) — solo-founder carve-out, same caveat as above |
| Target tags | Include by pattern: `v*` (fnmatch) |
| Rules → Restrict creations | ⬜ OFF (we want to be able to create new release tags) |
| Rules → Restrict updates | ✅ ON |
| Rules → Restrict deletions | ✅ ON |
| Rules → Require signed commits *(this rule also enforces signed tags)* | ✅ ON |

The "Require signed commits" rule in Rulesets covers both signed commit objects
and signed tag objects — that is the canonical way to enforce signed tags.

---

## 4. Optional — Repository Ruleset mirror of branch rules

Classic Branch Protection above is the primary enforcement layer. If you want
the modern UI / per-actor bypass granularity, replicate the same rules as a
Ruleset and turn the classic rule off. **Do not run both at the same time** —
they overlay and the strictest wins, which makes audit trails confusing.

Path: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**

| Field | Value |
| --- | --- |
| Name | `protect-main` |
| Enforcement status | `Active` |
| Bypass list | `@graveyieldprotocol` (Always) |
| Target branches | Include: `Default branch` |
| Restrict creations | ✅ ON |
| Restrict updates | ✅ ON |
| Restrict deletions | ✅ ON |
| Require linear history | ✅ ON |
| Require signed commits | ✅ ON |
| Require pull request before merging | ✅ ON — Required approvals `1`, dismiss stale reviews ✅, require CODEOWNERS review ✅, require approval of most recent reviewable push ✅, require conversation resolution ✅ |
| Require status checks to pass | ✅ ON — Require branches up to date ✅, contexts: `cargo fmt --check`, `cargo clippy`, `anchor build`, `pnpm typecheck`, `terminology lint` (plus `Analyze (javascript-typescript)` once public) |
| Block force pushes | ✅ ON |

---

## 5. `gh` CLI one-shot (alternative to the UI)

If `gh` is configured on a machine with admin access to the repo, the Classic
Branch Protection rule above can be applied with one POST. CodeQL is omitted
from the contexts list — add it the moment the repo flips public.

```bash
gh api -X PUT repos/graveyieldprotocol/protocol/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "cargo fmt --check",
      "cargo clippy",
      "anchor build",
      "pnpm typecheck",
      "terminology lint"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false,
  "required_signatures": true
}
JSON
```

The solo-founder bypass for required PR reviews is **not** expressible through
the Classic Branch Protection REST API — that feature only exists on Rulesets
and on the Branch Protection UI's "Allow specified actors to bypass required
pull requests" toggle. If you apply the rule via `gh` above, also tick that one
field in the UI, otherwise you'll lock yourself out of merging.

Sign the signature requirement separately if needed:

```bash
gh api -X POST repos/graveyieldprotocol/protocol/branches/main/protection/required_signatures \
  -H "Accept: application/vnd.github+json"
```

---

## 6. Post-apply verification

After applying, run through this list once. The whole thing takes under five
minutes and catches every common misconfiguration.

- [ ] `gh api repos/graveyieldprotocol/protocol/branches/main/protection` returns
      the JSON above (or the UI shows every row in §2 set as specified).
- [ ] `git push --force origin main` from a clean clone is **rejected** with
      "protected branch hook declined".
- [ ] `git push origin :main` (delete) is **rejected**.
- [ ] A draft PR against `main` shows the five required checks as pending /
      required, not optional.
- [ ] A PR touching `programs/grave-scanner/` auto-requests review from
      `@graveyieldprotocol` per `.github/CODEOWNERS`.
- [ ] A PR touching `docs/architecture/charter-invariants.md` auto-requests
      review from `@graveyieldprotocol` per `.github/CODEOWNERS`.
- [ ] An unsigned commit (e.g. `git commit --no-gpg-sign`) on a PR head
      surfaces an "Unverified" badge and blocks merge.
- [ ] A merge commit attempt (non-fast-forward) is rejected by the linear
      history rule.
- [ ] Pushing tag `v0.0.0-test` signed shows ✅ Verified; pushing it unsigned
      is rejected by the `signed-release-tags` ruleset.
- [ ] `git push --delete origin v0.0.0-test` is rejected.

If any item above fails, the rule didn't take. The most common cause on a
free-tier private personal repo is forgetting to upgrade to Pro first.

---

## 7. Open carve-outs to remove later

These are intentional solo-founder accommodations. Remove them as the project
scales — a comment per row noting the trigger condition.

| Carve-out | Remove when |
| --- | --- |
| `@graveyieldprotocol` bypass on required PR reviews | A second human reviewer is added to `.github/CODEOWNERS` (likely at audit prep / first hire). |
| `@graveyieldprotocol` bypass on `signed-release-tags` ruleset | Releases are cut from a CI workflow with a signed bot identity, not a personal key. |
| Required approvals = `1` | Org migration + ≥2 active contributors → bump to `2`. |
| `enforce_admins: true` with a single bypass actor | Multisig governance is live and at least one other admin exists. |

---

## 8. Pointers

- CI workflow: `.github/workflows/ci.yml` — five required jobs.
- CodeQL workflow: `.github/workflows/codeql.yml` — gated to public via
  `if: ${{ !github.event.repository.private }}`. No required-checks change
  needed at flip-public time other than the addition noted in §2.
- Code ownership map: `.github/CODEOWNERS`.
- Terminology gate: `scripts/terminology-lint.sh` (run by the `terminology lint`
  job). Forbidden vocabulary list is canonical; **do not** add carve-outs.
