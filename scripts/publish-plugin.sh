#!/bin/sh
# Publish packages/plugin/ to the marketplace repo (DESIGN.md §2.3): copy the plugin
# verbatim into <relay-plugin clone>/plugin/, write .claude-plugin/marketplace.json,
# commit with the monorepo SHA in the message and push. Run by
# .github/workflows/publish-plugin.yml on pushes to main that touch packages/plugin/**,
# and manually via `pnpm plugin:publish`. POSIX sh.
#
#   publish-plugin.sh [--dir <clone>] [--remote <git url>] [--branch main] [--no-push] [--dry-run]
#
# Defaults: --dir $RELAY_PLUGIN_REPO_DIR or ../relay-plugin next to this monorepo (cloned from
# --remote when absent); --remote from team.json "marketplace" as git@github.com:<owner/repo>.git
# (https://github.com/<owner/repo>.git when RELAY_PLUGIN_HTTPS=1 or $RELAY_PLUGIN_REMOTE is set).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN="$ROOT/packages/plugin"
DIR="${RELAY_PLUGIN_REPO_DIR:-$ROOT/../relay-plugin}"
REMOTE="${RELAY_PLUGIN_REMOTE:-}"
BRANCH=main
PUSH=1
DRY=0
KEEPDIR=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    --dry-run) DRY=1; PUSH=0; shift ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "publish-plugin: unknown option $1" >&2; exit 1 ;;
  esac
done

die() { echo "publish-plugin: $*" >&2; exit 1; }

# 1. sanity: bundles are real and match the sources (CI rebuilds and diffs; here we only refuse stubs)
for f in hook.mjs mcp.mjs; do
  [ -s "$PLUGIN/dist/$f" ] || die "packages/plugin/dist/$f missing: run pnpm build"
  [ "$(wc -c < "$PLUGIN/dist/$f" | tr -d ' ')" -ge 1000 ] || die "packages/plugin/dist/$f is a stub: run pnpm build"
done
grep -q '"version"' "$PLUGIN/.claude-plugin/plugin.json" && die "plugin.json must not carry a version (§2.3)"
MK=$(node -e 'try{const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(t.marketplace||"")}catch{}' "$PLUGIN/team.json" 2>/dev/null || true)
[ -n "$MK" ] || MK=your-org/relay-plugin
if [ -z "$REMOTE" ]; then
  if [ "${RELAY_PLUGIN_HTTPS:-0}" = 1 ]; then REMOTE="https://github.com/$MK.git"; else REMOTE="git@github.com:$MK.git"; fi
fi
SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
DIRTY=""
[ -z "$(git -C "$ROOT" status --porcelain -- packages/plugin 2>/dev/null)" ] || DIRTY=" (working tree had uncommitted plugin changes)"
STAMP="0.$(date -u +%Y%m%d).$(date -u +%H%M%S | sed 's/^0*//')"
[ -n "$STAMP" ] || STAMP="0.0.1"

# 2. clone or refresh the marketplace repo
if [ ! -d "$DIR/.git" ]; then
  [ "$DRY" = 1 ] && { echo "dry-run: would clone $REMOTE into $DIR"; DIR=$(mktemp -d "${TMPDIR:-/tmp}/relay-plugin.XXXXXX"); KEEPDIR=0; git -C "$DIR" init -q -b "$BRANCH" 2>/dev/null || git -C "$DIR" init -q; }
  if [ "$DRY" = 0 ]; then
    echo "==> cloning $REMOTE into $DIR"
    git clone -q --branch "$BRANCH" "$REMOTE" "$DIR" 2>/dev/null || {
      git clone -q "$REMOTE" "$DIR" || die "clone failed (auth? create the repo first: gh repo create $MK --private)"
      git -C "$DIR" checkout -q -B "$BRANCH"
    }
  fi
else
  [ "$DRY" = 0 ] && git -C "$DIR" pull -q --ff-only origin "$BRANCH" 2>/dev/null || true
fi

# 3. copy the plugin verbatim; publish only when plugin/ actually changed (a new
#    marketplace version for an unchanged plugin would be a pointless update prompt).
rm -rf "$DIR/plugin"
cp -R "$PLUGIN" "$DIR/plugin"
rm -f "$DIR/plugin/team.json.example"
git -C "$DIR" add -A plugin
if [ -f "$DIR/.claude-plugin/marketplace.json" ] && git -C "$DIR" diff --cached --quiet -- plugin; then
  echo "==> nothing to publish (plugin unchanged since $(git -C "$DIR" log -1 --format=%h 2>/dev/null || echo '?'))"
  [ "$DRY" = 1 ] && [ "$KEEPDIR" = 0 ] && rm -rf "$DIR"
  exit 0
fi
#    The marketplace entry carries a monotonic version stamp so the cache dir
#    ~/.claude/plugins/cache/relay/relay/<version> changes on every publish (experiment
#    B.13: with no version anywhere the cache dir name never changes). plugin.json itself
#    stays version-free (§2.3).
mkdir -p "$DIR/.claude-plugin"
cat > "$DIR/.claude-plugin/marketplace.json" <<JSON
{
  "name": "relay",
  "owner": { "name": "Parallel Connect" },
  "description": "Relay: team presence, collision warnings, contract impact routing and automatic handoffs for Claude Code",
  "plugins": [
    {
      "name": "relay",
      "source": "./plugin",
      "version": "$STAMP",
      "description": "Team presence, collision warnings, contract impact routing and automatic handoffs"
    }
  ]
}
JSON
cat > "$DIR/README.md" <<TXT
# relay-plugin

Published automatically from the \`relay\` monorepo (\`scripts/publish-plugin.sh\`); do not edit here.
Client repos reference this marketplace from \`.claude/settings.json\`
(\`extraKnownMarketplaces.relay\` -> \`{"source":"github","repo":"$MK"}\`, \`enabledPlugins["relay@relay"]\`).
Last publish: monorepo $SHA, marketplace version $STAMP.
TXT
[ -f "$DIR/.gitignore" ] || printf '%s\n' '.DS_Store' > "$DIR/.gitignore"

# 4. commit + push
git -C "$DIR" add -A
if git -C "$DIR" diff --cached --quiet; then
  echo "==> nothing to publish (plugin unchanged)"; exit 0
fi
if [ "$DRY" = 1 ]; then
  echo "dry-run: would commit (version $STAMP, monorepo $SHA):"; git -C "$DIR" diff --cached --stat | tail -n 20
  [ "$KEEPDIR" = 0 ] && rm -rf "$DIR"
  exit 0
fi
git -C "$DIR" -c user.name="${GIT_AUTHOR_NAME:-relay-publish}" -c user.email="${GIT_AUTHOR_EMAIL:-relay-publish@exampleteam.local}" \
  commit -q -m "relay plugin $STAMP from $SHA$DIRTY"
echo "==> committed $(git -C "$DIR" rev-parse --short HEAD) in $DIR (version $STAMP, monorepo $SHA)"
if [ "$PUSH" = 1 ]; then
  git -C "$DIR" push -q origin "HEAD:$BRANCH" || die "push failed"
  echo "==> pushed to $REMOTE ($BRANCH); teammates get it via autoUpdate or: claude plugin marketplace update relay && claude plugin update relay@relay"
else
  echo "==> not pushed (--no-push)"
fi
