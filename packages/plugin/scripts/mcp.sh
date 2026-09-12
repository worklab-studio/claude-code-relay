#!/bin/sh
# Relay stdio MCP server entry (DESIGN.md §9.1): the same Node >= 18 resolver as hook.sh,
# then exec dist/mcp.mjs so process.ppid of the server is the Claude Code process
# (experiment B.16). Exits 0 when Node is missing (Claude Code shows the server as failed).
PATH="${PATH:-/usr/bin:/bin}:/usr/bin:/bin"; export PATH   # coreutils and git even under a minimal Desktop PATH
D="${RELAY_HOME:-$HOME/.relay}"; [ -d "$D" ] || mkdir -p "$D" 2>/dev/null
v18() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' >/dev/null 2>&1; }
# The cached path is trusted only when the file is ours: $RELAY_HOME can sit under a shared /tmp
# (demo rig) where another local account could plant an interpreter path (review).
mine() { [ -f "$1" ] && [ -O "$1" ]; }
cached() { mine "$D/node-path" && C=$(cat "$D/node-path" 2>/dev/null) && [ -n "$C" ] && [ -x "$C" ]; }
N=""
if [ -n "$RELAY_NODE" ]; then
  # RELAY_NODE is probed once: when it matches the cache it is used without the extra Node start (review)
  if cached && [ "$C" = "$RELAY_NODE" ]; then N="$RELAY_NODE"
  elif v18 "$RELAY_NODE"; then N="$RELAY_NODE"; { printf '%s' "$N" > "$D/node-path"; } 2>/dev/null; fi
elif cached; then N="$C"; fi
if [ -z "$N" ]; then
  OLDIFS="$IFS"
  IFS='
'
  for c in node /opt/homebrew/bin/node /usr/local/bin/node \
           $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node \
                   "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -rV 2>/dev/null); do
    p=$(command -v "$c" 2>/dev/null) || continue
    v18 "$p" && N="$p" && break
  done
  IFS="$OLDIFS"
  [ -n "$N" ] && { printf '%s' "$N" > "$D/node-path"; } 2>/dev/null
fi
[ -z "$N" ] && { { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) relay: node >= 18 not found (mcp.sh)" >> "$D/last-error"; } 2>/dev/null; exit 0; }
case "$0" in */*) SELF="${0%/*}";; *) SELF=.;; esac
exec "$N" --no-warnings "${CLAUDE_PLUGIN_ROOT:-$SELF/..}/dist/mcp.mjs" "$@"
exit 0
