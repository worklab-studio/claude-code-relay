#!/bin/sh
# Relay status line (DESIGN.md §4.11): POSIX sh + sed, ~5 ms, no Node.
# stdin: Claude Code's status-line JSON. Prints the line pre-rendered by the last
# snapshot write (cache/<repoKey>/statusline.txt), located through
# current/<CLAUDE_PID>.json (§4.0 rule 11), with session-id fallbacks. The
# session-start hook copies this file to $RELAY_HOME/statusline.sh; the project
# statusLine command execs it only when present, so a machine without Relay prints
# nothing. If $RELAY_HOME/statusline-chain holds the developer's own status-line
# command, it runs first and its output is printed above Relay's line.
D="${RELAY_HOME:-$HOME/.relay}"
IN=$(cat 2>/dev/null)
OWN=""
# the chained command runs only from a file this account owns (a shared /tmp $RELAY_HOME could be planted, review)
if [ -s "$D/statusline-chain" ] && [ -O "$D/statusline-chain" ]; then
  OWN=$(printf '%s' "$IN" | /bin/sh -c "$(head -n 1 "$D/statusline-chain" 2>/dev/null)" 2>/dev/null)
fi
line_of() { sed -n 's/.*"statusline":"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1; }
F=""
if [ -n "$CLAUDE_PID" ] && [ -r "$D/current/$CLAUDE_PID.json" ]; then
  F=$(line_of "$D/current/$CLAUDE_PID.json")
fi
if [ -z "$F" ]; then
  # env session id first (updated on /clear), then the id in the status-line JSON
  for SID in "$CLAUDE_CODE_SESSION_ID" "$(printf '%s' "$IN" | sed -n 's/.*"session_id":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"; do
    [ -n "$SID" ] || continue
    for c in "$D"/current/*.json; do
      [ -r "$c" ] || continue
      grep -q "\"sessionId\":\"$SID\"" "$c" 2>/dev/null || continue
      F=$(line_of "$c")
      [ -n "$F" ] && break
    done
    [ -n "$F" ] && break
  done
fi
LINE=""
if [ -n "$F" ] && [ -r "$F" ]; then LINE=$(head -n 1 "$F" 2>/dev/null); fi
[ -n "$LINE" ] || LINE="relay ○"
if [ -n "$OWN" ]; then printf '%s\n' "$OWN"; fi
printf '%s\n' "$LINE"
exit 0
