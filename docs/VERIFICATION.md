# What has been verified, and how

This is the evidence behind the status claims in the README: what was driven through the real
`claude` binary, what was fixed because of it, and what only an interactive session can show.

## Verified against the real `claude` CLI 2.1.236 (headless, this Mac)

The M0 flow was driven end to end through `claude -p` (stream-json in/out, `--include-hook-events`)
with the plugin loaded **through the real marketplace install path** (`.claude/settings.json` →
local `file://` marketplace → `~/.claude/plugins/cache/relay/relay/<version>`), against the demo hub
on PGlite. Two developers, five sessions, every hook exit 0 after the fix below. Observed:

| Moment | Headless evidence |
|---|---|
| plugin install | session 1 registers the marketplace, session 2 caches the plugin and writes the install record, session 3 loads hooks + MCP (B.1 confirmed); the install record is **per project folder** (`installed_plugins.json … scope: project, projectPath`), so the second clone needs its own one-or-two sessions |
| SessionStart digest | `<relay-digest>` injected (699–1,600 chars): teammate presence + objective, routed change set with diff hunk, handoffs since last session |
| MCP tools | 13 `mcp__plugin_relay_relay__*` tools listed, server connected in ~250–450 ms, exits cleanly on SIGINT; Claude called `impact_of`, `impacts`, `recent_changes`, `status`, `notify`, `handoffs` unprompted and correctly, permission granted by the project `permissions.allow` rule (B.4) |
| 1 presence | arjun's Claude answered "what is priya working on" from the digest: her objective, `12c9a67`, `OrderFilter: +status`, last event time |
| 2 impact | priya's edit + commit → `post-edit (edit,contract)` and `post-git (commit)` events → one change set routed to arjun with `apps/dashboard/**` dependents; arjun's second prompt named `OrderFilter.status` and refused to touch the file without the pull |
| 3 collision | `pre-edit` fired on arjun's Edit of `orders.ts`, verdict **HOT**, downgraded to `additionalContext` because `claude -p` is non-interactive (`CLAUDE_CODE_ENTRYPOINT=sdk-cli`, §4.0 rule 14) — Claude reported the collision in its answer. The `ask` + permission prompt UI itself is interactive-only (see below) |
| 4 notify | `notify` → `ntf_…`; at priya's next prompt the `UserPromptSubmit` hook injected `<relay-inbox>` with the note + 3 impacts and emitted `systemMessage: "Relay: 3 impacts, 1 note"` (stream `informational` event, B.11); her Claude quoted the note |
| 5 handoff | SessionEnd → detached worker → `/v1/session/end` → heuristic handoff `hnd_…` stored within 1 s (objective, changed files, interface `OrderFilter: +status` with commit, no API key) |
| 6 digest | arjun's next session start listed the change set and "Handoffs since your last session (1)"; `handoffs` tool returned the full markdown |
| status line | `statusline.sh` run with Claude's stdin JSON prints `relay ● priya app (+contracts) main 14:20Z · 3 impacts` (rendering in the terminal is interactive-only) |
| timings | session-start p50 197 ms / max 426 ms, prompt p50 8 ms, pre-edit p50 6 ms / max 26 ms, post-edit ≤ 141 ms, stop ≤ 172 ms, session-end ≤ 13 ms — all inside the §4 deadlines |

Fixed by that run: Claude Code exports `NODE_USE_SYSTEM_CA=1` to hooks and on Node 24.7 (macOS)
`process.exit()` races the keychain-reading thread into a **SIGSEGV in ~20 % of hook runs**
(Claude Code reports "hook error, exit 1"); `hook.sh`/`mcp.sh` now unset it. The heuristic handoff
also learned that "Committed as …" is a done-line.

Still to be observed in the two-terminal interactive run (nothing headless can drive them): the
workspace trust dialog itself (headless used `--settings <the clone's .claude/settings.json>` as
the trusted source; `hasTrustDialogAccepted: true` alone does not trigger the headless installer),
the **collision permission prompt** (`ask` + reason; in `-p` it is by design downgraded to context,
and the e2e replays the interactive verdict), `/reload-plugins`, `/cd` → CwdChanged, the status
line as rendered by Claude Code, `/exit` → `SessionEnd reason: prompt_input_exit`, and the Desktop
lifecycle. Note that in `claude -p` the async `Stop` hook is cancelled at teardown when the session
ends right after the last turn (B.6); a multi-turn `--input-format stream-json` session gives it
time and the `turn_end`/draft path then works as in the interactive CLI.

The contract experiments behind all this are in
[docs/research/experiments.md](docs/research/experiments.md).
