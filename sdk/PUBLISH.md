# Publishing `@graveyield/sdk`

> The SDK is **publish-ready**: `npm publish --dry-run` passes with a
> clean tarball (dist + README only), and a pre-built tarball ships with
> every release. What it needs is the owner's npm credentials — that
> step is deliberately out of the bot's reach (2FA / automation tokens
> are custodial decisions).

## One-time setup (owner)

1. Create an npm account for the `graveyield` scope (or reuse the org's),
   and enable 2FA.
2. Create an **automation** access token (granular, publish-only,
   revocable): npmjs.com → Access Tokens → Generate New Token →
   *Automation*.
3. Hand the token to the publishing session **in chat only** (the same
   one-time-PAT protocol used for git pushes). It is never written to
   disk, never committed, and should be revoked right after the publish.

## Per-release checklist

```bash
cd sdk/

# 1. Clean build + full offline gate
pnpm --filter @graveyield/sdk build
pnpm --filter @graveyield/sdk test

# 2. Dry-run — verify the tarball contents (dist/ + README.md, nothing else)
npm publish --dry-run

# 3. Version bump (semver; pre-1.0: minor = features, patch = fixes)
npm version patch   # or minor / the exact target version

# 4. Publish (requires the owner's automation token)
npm publish --access public

# 5. Verify
npm view @graveyield/sdk version
```

## Post-publish

- Sync the version into `CHANGELOG.md` (both repos) and the root
  READMEs' status lines.
- Operators who install from GitHub (below) keep working; update the
  pinned tag if the install docs reference one.

## Installing without npm (always available)

The repo itself is an install source — no registry required:

```bash
# From a release tag (recommended)
npm install github:GraveYield/salvor-bots#<tag>

# From the protocol monorepo
npm install github:GraveYield/graveyield-protocol#<tag>
```

Or install the packed tarball directly (`graveyield-sdk-<version>.tgz`
in the release assets / `download/` directory):

```bash
npm install ./graveyield-sdk-0.2.0.tgz
```

## Scope history

- The npm name `@graveyield/sdk` is reserved by convention (the
  salvor-bots repo's package name kept it for back-compat with the
  monorepo references). First public publish should be **v0.2.0** to
  match the shipped Phase 8 SDK surface.
