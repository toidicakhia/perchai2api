#!/usr/bin/env bash
#
# Cut a release: bump version, pack, tag, push, publish a GitHub Release with
# the tarball attached. See RELEASING.md for what the artifacts mean.
#
#   ./scripts/release.sh patch | minor | major | <x.y.z> [--dry-run]
#
set -euo pipefail

REPO_SLUG="zoeee1125/perchai2api"
BRANCH="main"
PKG="package.json"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '  • %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- arguments -------------------------------------------------------------

[ $# -ge 1 ] || die "usage: $0 patch|minor|major|<x.y.z> [--dry-run]"
BUMP="$1"; shift
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) die "unknown flag: $a" ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The bump rewrites package.json before later checks can fail, so any failed
# run has to put it back — otherwise an aborted release leaves the working tree
# sitting on a version that was never published.
BUMPED=0
STAGE="$(mktemp -d)"
cleanup() {
  local code=$?
  if [ "$BUMPED" = "1" ]; then
    git checkout -- "$PKG" 2>/dev/null || true
  fi
  rm -rf "$STAGE"
  exit "$code"
}
trap cleanup EXIT

# ---- pre-flight ------------------------------------------------------------

say "pre-flight"

[ -f "$PKG" ] || die "$PKG not found in $ROOT"
command -v node >/dev/null || die "node is required"
command -v npm  >/dev/null || die "npm is required"
command -v gh   >/dev/null || die "gh is required"

BRANCH_NOW="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH_NOW" = "$BRANCH" ] || die "on '$BRANCH_NOW', releases come from '$BRANCH'"
step "branch $BRANCH"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"
step "working tree clean"

gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
step "gh authenticated"

node --check index.mjs || die "index.mjs does not parse"
step "index.mjs parses"

CURRENT="$(node -p "require('./$PKG').version")"
case "$BUMP" in
  patch|minor|major) ;;
  [0-9]*)            ;;
  *)                 die "bump must be patch|minor|major or x.y.z, got '$BUMP'" ;;
esac
BUMPED=1
npm version "$BUMP" --no-git-tag-version --silent >/dev/null || die "npm version $BUMP failed"
# read the version back rather than parsing npm's output, which prints "v0.2.1"
NEXT="$(node -p "require('./$PKG').version")"
[ "$NEXT" != "$CURRENT" ] || die "version did not change from $CURRENT"
node -e '
  const next = process.argv[1], cur = process.argv[2]
  const parts = next.split(".")
  if (parts.length !== 3 || parts.some((s) => !/^\d+$/.test(s))) {
    console.error("error: " + next + " is not x.y.z"); process.exit(1)
  }
  const [a, b, c] = parts.map(Number)
  const [x, y, z] = cur.split(".").map(Number)
  const forward = a > x || (a === x && b > y) || (a === x && b === y && c > z)
  if (!forward) { console.error("error: " + next + " does not move forward from " + cur); process.exit(1) }
' "$NEXT" "$CURRENT" || { npm version "$CURRENT" --no-git-tag-version --silent >/dev/null; die "version check failed"; }
step "version $CURRENT -> $NEXT"

git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null && die "tag v$NEXT already exists"
gh release view "v$NEXT" >/dev/null 2>&1 && die "GitHub release v$NEXT already exists"
step "tag v$NEXT is free"

grep -q "^## \[$NEXT\]" CHANGELOG.md \
  || die "CHANGELOG.md has no '## [$NEXT]' section — write the notes before releasing"
step "changelog has a $NEXT section"

# ---- pack ------------------------------------------------------------------

say "pack"
TARBALL="perchai2api-$NEXT.tgz"

npm pack --silent --pack-destination "$STAGE" >/dev/null || die "npm pack failed"
PACKED="$(find "$STAGE" -name '*.tgz' -print -quit)"
[ -n "$PACKED" ] || die "npm pack produced no tarball"
mv "$PACKED" "$STAGE/$TARBALL"
step "$TARBALL ($(wc -c < "$STAGE/$TARBALL" | tr -d ' ') bytes)"

for want in index.mjs prompt.mjs README.md package.json; do
  tar -tzf "$STAGE/$TARBALL" | grep -q "package/$want\$" || die "$TARBALL is missing $want"
done
step "tarball contents ok"

if [ "$DRY" = "1" ]; then
  say "dry run — nothing committed, tagged, pushed, or published"
  step "would tag v$NEXT and attach $TARBALL"
  exit 0
fi

# ---- commit, tag, push -----------------------------------------------------

say "commit"
git add "$PKG" CHANGELOG.md
[ -n "$(git status --porcelain)" ] || die "nothing to commit after bump — did the version already match?"
git -c user.name="zoeee1125" -c user.email="zoeee1125@users.noreply.github.com" \
    commit -q -m "release v$NEXT"
step "$(git rev-parse --short HEAD) release v$NEXT"

git tag -a "v$NEXT" -m "v$NEXT"
step "tagged v$NEXT"

git push origin "$BRANCH" && git push origin "v$NEXT"
step "pushed $BRANCH and v$NEXT"

# ---- GitHub release --------------------------------------------------------

say "release"
# the changelog section doubles as the release body
NOTES="$STAGE/release-notes.md"
awk -v v="$NEXT" '
  $0 ~ "^## \\[" v "\\]" { on = 1; next }
  on && /^## \[/ { exit }
  on { print }
' CHANGELOG.md > "$NOTES"

# past this point the version is committed — the bump must survive, only the
# scratch directory goes away
BUMPED=0

gh release create "v$NEXT" "$STAGE/$TARBALL" \
  --title "v$NEXT" \
  --notes-file "$NOTES"
step "published $(gh release view "v$NEXT" --json url -q .url)"

# ---- what to install -------------------------------------------------------

say "installable now"
cat <<EOF
  pinned   https://github.com/$REPO_SLUG/releases/download/v$NEXT/$TARBALL
  branch   https://github.com/$REPO_SLUG/archive/refs/heads/$BRANCH.tar.gz
  commit   https://github.com/$REPO_SLUG/archive/$(git rev-parse HEAD).tar.gz

Bun does not compare versions for URL specs, so a spec change needs a reinstall:
  cd ~/.config/magpie/plugins && rm -rf node_modules/@magpie-community/perchai2api \\
    && ~/.cache/magpie/bun/1.4.3/magpie-bun install
EOF
