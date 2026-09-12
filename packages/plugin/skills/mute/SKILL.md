---
name: mute
description: Silence Relay collision and impact notes for a path, glob, area or teammate on this machine (/relay:mute <target>, /relay:mute <target> --undo). Local only, never committed.
argument-hint: <path|glob|area|@dev> [--undo]
allowed-tools: Bash(/bin/sh *)
---

The user wants to mute (or unmute) Relay notes for a target on this machine.

Target: `$ARGUMENTS`

1. If `$ARGUMENTS` is empty, ask what to mute: a repo-relative path
   (`packages/contracts/src/orders.ts`), a glob (`apps/dashboard/**`), an area name
   (`contracts`) or a teammate (`@priya`). Stop there.
2. Run with Bash, passing the arguments through unchanged (`--undo` removes the mute):

   ```
   /bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" mute $ARGUMENTS
   ```

   The command appends to `$RELAY_HOME/mute/<repoKey>.json` (default `~/.relay/mute/`)
   for the repository of the current working directory. Mutes silence collision context and
   just-in-time impact notes for that target on this machine only; they are never
   committed and never reach the hub.
3. Report what the command printed. If it printed nothing, say the mute was recorded.
