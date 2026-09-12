#!/bin/sh
# Relay hook entry (DESIGN.md §4.0). usage: hook.sh <verb>   stdin: Claude Code hook JSON.
# POSIX sh: Desktop-launched sessions may have no login-shell PATH, so Node is resolved
# here (PATH, Homebrew, nvm, volta, fnm), verified once to be >= 18 (global fetch and
# AbortSignal.timeout) and cached in $RELAY_HOME/node-path. Every path this script
# controls exits 0 (fail open, §4.0 rule 2); a missing Node is a silent no-op.
PATH="${PATH:-/usr/bin:/bin}:/usr/bin:/bin"; export PATH   # coreutils and git even under a minimal Desktop PATH
# Claude Code exports NODE_USE_SYSTEM_CA=1 to its children. On Node 24.7 (macOS) that starts a keychain-reading
# thread at startup and process.exit() races it into a SIGSEGV (~20% of hook runs, reported by Claude Code as
# a hook error with exit code 1; seen in the real-claude verification). The hub is reached over plain http or
# a public CA; private CAs still work through NODE_EXTRA_CA_CERTS.
unset NODE_USE_SYSTEM_CA
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
    v18 "$p" && N="$p" && break            # skips Node < 18 (v1.1)
  done
  IFS="$OLDIFS"
  [ -n "$N" ] && { printf '%s' "$N" > "$D/node-path"; } 2>/dev/null
fi
[ -z "$N" ] && { { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) relay: node >= 18 not found (hook.sh $1)" >> "$D/last-error"; } 2>/dev/null; exit 0; }
case "$0" in */*) SELF="${0%/*}";; *) SELF=.;; esac
exec "$N" --no-warnings "${CLAUDE_PLUGIN_ROOT:-$SELF/..}/dist/hook.mjs" "$@"
exit 0
