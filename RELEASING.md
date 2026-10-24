# Releasing

One command cuts a release. It bumps the version, regenerates the tarball,
commits, tags, pushes, and publishes a GitHub Release with the tarball attached.

```bash
./scripts/release.sh patch     # 0.2.0 -> 0.2.1   bug fixes
./scripts/release.sh minor     # 0.2.0 -> 0.3.0   new behaviour, still compatible
./scripts/release.sh major     # 0.2.0 -> 1.0.0   breaking change
./scripts/release.sh 0.4.2     # explicit version
./scripts/release.sh patch --dry-run   # show the plan, change nothing
```

## What a release produces

Two installable artifacts from the same source, because magpie accepts either:

| Artifact | URL | Update behaviour |
|---|---|---|
| **Pinned tarball** | `https://github.com/zoeee1125/perchai2api/releases/download/v<version>/perchai2api-<version>.tgz` | Immutable. Reproducible. Survives a rebase or a moved branch. |
| **Branch archive** | `https://github.com/zoeee1125/perchai2api/archive/refs/heads/main.tar.gz` | Always the tip of `main`. Zero setup, but CDN-cached for a few minutes and unpinned. |

Pick by intent:

- **Use the pinned tarball for anything you care about.** It is versioned,
  immutable, and identifies exactly what is installed.
- **Use the branch archive for quick trials** and for the local dev loop, where
  you want "whatever is on `main` right now" after a `bun install --force`.

While `main` is moving and you want the *newest* code immediately, pin the
commit instead — archives are CDN-cached per URL, commit archives are not:

```bash
git rev-parse HEAD      # -> <sha>
# https://github.com/zoeee1125/perchai2api/archive/<sha>.tar.gz
```

## Registering with magpie

`~/.config/magpie/plugins/package.json` (what gets installed) and
`~/.config/magpie/plugins.json` (what gets updated) both need the same spec.

**Pinned release** (recommended):

```jsonc
// ~/.config/magpie/plugins/package.json  -> dependencies
"@magpie-community/perchai2api": "https://github.com/zoeee1125/perchai2api/releases/download/v0.2.1/perchai2api-0.2.1.tgz"

// ~/.config/magpie/plugins.json  -> plugins[]
{ "spec": "https://github.com/zoeee1125/perchai2api/releases/download/v0.2.1/perchai2api-0.2.1.tgz" }
```

Then reinstall, because bun does not compare versions for HTTP specs — a URL
spec has no semver, so `@latest` is meaningless for it and bun will keep
whatever it already fetched:

```bash
cd ~/.config/magpie/plugins
rm -rf node_modules/@magpie-community/perchai2api
~/.cache/magpie/bun/1.4.3/magpie-bun install
magpie plugin list
```

**Moving branch** (dev loop):

```jsonc
"@magpie-community/perchai2api": "https://github.com/zoeee1125/perchai2api/archive/refs/heads/main.tar.gz"
```

Take the plugin out of the install first (`rm -rf` above) so bun re-resolves
rather than trusting `bun.lock`. To force a cached URL to be re-fetched, delete
`bun.lock` as well — the archive URL itself is served through a CDN cache.

## npm

Not used. `@magpie-community` is a scope this account cannot publish to, and
magpie does not require the registry: a tarball URL is a first-class plugin
spec. If registry publishing is ever wanted, publish under a writable scope
(`@zoeee1125/perchai2api`), add `publishConfig.access: "public"`, and run
`npm publish` after `scripts/release.sh` has tagged the version.

## Pre-flight the script enforces

Each of these aborts the release before anything is pushed:

- On branch `main`, working tree clean, tag `v<version>` not already used.
- `node --check index.mjs` passes.
- `npm pack` succeeds and the tarball carries `index.mjs`, `prompt.mjs`,
  `README.md`, `package.json`.
- `package.json` version, `CHANGELOG.md` top entry, and the requested version
  agree — the changelog is not allowed to lag the tag.

## Manual checklist the script cannot do

1. **Move `## [Unreleased]` into a version heading in `CHANGELOG.md`** and write
   the notes there first. The script checks the heading matches the version it
   is about to publish; it does not write the notes for you.
2. **Prove the plugin still loads and answers** before tagging — the source of
   truth is the live service, not `node --check`:
   ```bash
   magpie provider test perchai2api        # expect ✓ chat <ms> · <model>
   ```
   Give it a minute after a burst of turns; `turn_rate_limited` disguises itself
   as a timeout.
3. **Re-verify a clean install from the new URL** if the spec form changed.
