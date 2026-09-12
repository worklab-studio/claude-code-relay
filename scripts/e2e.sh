#!/bin/sh
# `pnpm test:e2e` (DESIGN.md §12 M0): the six demo moments end to end without the claude CLI —
# a throwaway PGlite hub, two clones of examples/demo-repo, two RELAY_HOMEs, the real hook bundle
# replayed with Claude Code stdin payloads and the real MCP bundle over stdio. See scripts/e2e.mjs.
#
#   scripts/e2e.sh [--build]      --build forces `pnpm build` first (otherwise only when dist/ is missing)
#   RELAY_HUB=<url>               reuse a running hub instead of starting one
#   KEEP=1                        keep the temp directory for inspection
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
build=0
for a in "$@"; do
  case "$a" in
    --build) build=1 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) printf 'e2e: unknown option %s\n' "$a" >&2; exit 2 ;;
  esac
done
command -v node >/dev/null 2>&1 || { printf 'e2e: node is required\n' >&2; exit 1; }
nv=$(node -e 'process.stdout.write(String(+process.versions.node.split(".")[0]))')
[ "$nv" -ge 18 ] || { printf 'e2e: node >= 18 required (found %s)\n' "$(node --version)" >&2; exit 1; }
if [ "$build" = 1 ] || [ ! -s "$ROOT/packages/plugin/dist/hook.mjs" ] || [ ! -s "$ROOT/packages/plugin/dist/mcp.mjs" ]; then
  (cd "$ROOT" && pnpm build)
fi
exec node "$ROOT/scripts/e2e.mjs"
