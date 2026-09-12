#!/bin/sh
# PreToolUse:Read guard (DESIGN.md §4.4): ~6 ms, spawns Node only when just-in-time
# impact notes are pending for THIS session (sessions/<sid>/pending is non-empty; one
# global marker would let two repos' refreshes clear each other, v1.1). Always exits 0.
D="${RELAY_HOME:-$HOME/.relay}"
[ -n "$CLAUDE_CODE_SESSION_ID" ] && [ -s "$D/sessions/$CLAUDE_CODE_SESSION_ID/pending" ] || exit 0
case "$0" in */*) SELF="${0%/*}";; *) SELF=.;; esac
exec /bin/sh "${CLAUDE_PLUGIN_ROOT:-$SELF/..}/scripts/hook.sh" pre-read
exit 0
