#!/bin/sh
# /relay:doctor helper (DESIGN.md §9.2): local facts only, no network, POSIX sh.
# Prints node resolution, breaker/config-error state, plugin install facts, hook
# counters and recent hook errors, then the fix commands. Always exits 0.
D="${RELAY_HOME:-$HOME/.relay}"
CH="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
P="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
echo "relay doctor (local checks)"
echo "  RELAY_HOME: $D"
echo "  plugin root: $P"
N=""
[ -r "$D/node-path" ] && N=$(cat "$D/node-path" 2>/dev/null)
if [ -n "$N" ] && [ -x "$N" ]; then echo "  node: $N ($("$N" --version 2>/dev/null))"
else
  NP=$(command -v node 2>/dev/null)
  if [ -n "$NP" ]; then echo "  node: not cached yet; PATH has $NP ($("$NP" --version 2>/dev/null))"
  else echo "  node: NOT FOUND (hooks are silent no-ops until Node >= 18 is installed; set RELAY_NODE=/path/to/node if it lives elsewhere)"; fi
fi
for f in hook.mjs mcp.mjs; do
  if [ -s "$P/dist/$f" ]; then echo "  dist/$f: $(wc -c < "$P/dist/$f" | tr -d ' ') bytes"; else echo "  dist/$f: MISSING"; fi
done
if [ -r "$D/config-error.json" ]; then echo "  config-error.json: $(cat "$D/config-error.json")"; else echo "  config-error.json: none"; fi
if [ -r "$D/down-until" ]; then echo "  breaker down-until: $(cat "$D/down-until") (now $(date -u +%Y-%m-%dT%H:%M:%SZ))"; else echo "  breaker: closed"; fi
[ -r "$D/refresh-wanted" ] && echo "  refresh-wanted: present (a worker will refresh the snapshot)"
if [ -r "$D/last-error" ]; then echo "  last-error (tail):"; tail -n 3 "$D/last-error" | sed 's/^/    /'; fi
if [ -r "$D/identity.json" ]; then echo "  identity.json: $(cat "$D/identity.json")"; else echo "  identity.json: none (identity comes from RELAY_DEV or git email)"; fi
echo "  live sessions (current/*.json): $(ls "$D"/current/*.json 2>/dev/null | wc -l | tr -d ' ')"
if [ -r "$D/log/stats.jsonl" ]; then
  echo "  hook counters (last 200 lines of log/stats.jsonl):"
  tail -n 200 "$D/log/stats.jsonl" | sed -n 's/.*"verb":"\([a-z-]*\)".*/\1/p' | sort | uniq -c | sed 's/^/    /'
else
  echo "  hook counters: no log/stats.jsonl yet (no hook has run on this machine)"
fi
if [ -r "$CH/plugins/known_marketplaces.json" ]; then
  if grep -q '"relay"' "$CH/plugins/known_marketplaces.json" 2>/dev/null; then echo "  marketplace 'relay': registered"; else echo "  marketplace 'relay': NOT registered"; fi
fi
if [ -r "$CH/plugins/installed_plugins.json" ]; then
  SHA=$(tr -d '\n' < "$CH/plugins/installed_plugins.json" | sed -n 's/.*"relay@relay":[^]]*"gitCommitSha":[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
  if [ -n "$SHA" ]; then echo "  plugin relay@relay: installed at commit ${SHA}"; else echo "  plugin relay@relay: not in installed_plugins.json (running from --plugin-dir or a directory-source marketplace?)"; fi
fi
if [ -d "$CH/plugins/marketplaces/relay/.git" ]; then
  LOCAL=$(git -C "$CH/plugins/marketplaces/relay" rev-parse HEAD 2>/dev/null)
  REMOTE=$(git -C "$CH/plugins/marketplaces/relay" ls-remote origin HEAD 2>/dev/null | cut -f1)
  if [ -n "$LOCAL" ] && [ -n "$REMOTE" ]; then
    if [ "$LOCAL" = "$REMOTE" ]; then echo "  marketplace clone: up to date ($LOCAL)"; else echo "  marketplace clone: BEHIND (local $LOCAL, remote $REMOTE)"; fi
  fi
fi
T=$(ls -t "$CH"/projects/*/*.jsonl 2>/dev/null | head -n 1)
if [ -n "$T" ]; then
  E=$(grep -c 'hook error' "$T" 2>/dev/null); [ -n "$E" ] || E=0
  echo "  'hook error' lines in the latest transcript: $E ($T)"
fi
echo "fix commands:"
echo "  update plugin:   claude plugin marketplace update relay && claude plugin update relay@relay   (then /reload-plugins)"
echo "  set identity:    /relay:iam <handle>"
echo "  reset breaker:   rm -f \"$D/down-until\" \"$D/down-count\" \"$D/config-error.json\""
echo "  pick a node:     export RELAY_NODE=/path/to/node   (or rm -f \"$D/node-path\" to re-resolve)"
echo "  debug log:       RELAY_DEBUG=1 claude   -> $D/log/relay.log"
exit 0
