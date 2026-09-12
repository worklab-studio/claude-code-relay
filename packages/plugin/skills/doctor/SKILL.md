---
name: doctor
description: Diagnose the Relay plugin on this machine - identity, hub reachability, Node resolution, breaker and config errors, plugin version vs the marketplace, hook counters - and print the fix commands.
allowed-tools: Bash(/bin/sh *), mcp__plugin_relay_relay__whoami
---

Run both checks, then report.

1. Call `mcp__plugin_relay_relay__whoami` with `{}`. It returns the developer handle and
   the source of that identity, the team and hub URL, repo slug and project, the live
   session id and how it was resolved, cache age, breaker state, the plugin commit and
   whether it is behind the marketplace, and hook firing counts.
2. Run the local checker with Bash:

   ```
   /bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"
   ```

   It prints the resolved Node binary and version, the bundle sizes, `config-error.json`,
   the breaker file, `last-error`, `identity.json`, live session files, hook counters from
   `log/stats.jsonl`, the marketplace registration and the installed plugin commit, and
   the number of `hook error` lines in the latest transcript.

Report, in this order, only what is wrong or noteworthy:

- Identity: if the handle starts with `unknown-`, say that Relay does not know who this is
  and that `/relay:iam <handle>` fixes it for this machine.
- Hub: unreachable, breaker open, or a configuration error (401 = token rotated and the
  plugin is behind; 426 = plugin protocol too old; 413 = payload too large). For 401/426 the
  fix is `claude plugin marketplace update relay && claude plugin update relay@relay`, then
  `/reload-plugins`.
- Node: not found or below 18 means every hook is a silent no-op; suggest installing Node
  or exporting `RELAY_NODE=/path/to/node`.
- Plugin behind the marketplace: print the same update commands.
- Hooks: if no `PreToolUse`/`UserPromptSubmit` counters moved in the last session, say the
  hooks are not firing (plugin not loaded; `/reload-plugins` or restart `claude`).
- `hook error` lines: if present, the bundle failed to start; rebuilding/updating the
  plugin is the fix.

End with "Relay looks healthy" when nothing is wrong. Do not modify any file.
