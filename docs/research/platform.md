# Claude Code platform surfaces for team context, identity and coordination (beyond hooks & plugins)

Researched 2026-09-12 against https://code.claude.com/docs (llms.txt index). Docs describe Claude Code up to ~v2.1.269.
Local check on this machine: `claude --version` on PATH = **2.1.236**; the desktop app bundles its own newer engine (**2.1.260**, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`). Version gates matter: several features below need >= 2.1.239 / 2.1.246 / 2.1.257.

Companion notes: `hooks.md` and `plugins-mcp.md` in this directory cover hooks and plugins; this file covers everything else.

---

## 0. TL;DR for the four target questions

| Goal | Best native surface | Notes |
|---|---|---|
| (a) Identity per developer | `claude auth status` JSON (`email`, `orgId`, `orgName`, `subscriptionType`); OTel standard attrs (`user.email`, `user.account_uuid`, `user.account_id`, `organization.id`); `~/.claude/settings.json` `env` block for a self-declared `TEAM_DEV_ID`; `OTEL_RESOURCE_ATTRIBUTES` for team/department tags | No env var carries the email into hooks/MCP subprocesses. Identity to child processes = `CLAUDE_CODE_SESSION_ID` + `CLAUDE_PID` + whatever you put in settings `env`. `CLAUDE_CODE_ACCOUNT_UUID` exists as a host-owned identity var (ignored if set from settings files). |
| (b) Per-session team digest injection | (1) `CLAUDE.md` `@import` of a file the relay rewrites (loads at launch, re-injected after `/compact`); (2) `--append-system-prompt-file` for scripted launches; (3) MCP server `instructions` string (delivered at connect, **2KB cap**); (4) managed `claudeMd` setting for org-wide; (5) cross-session message into the inbox socket for *live* pushes | CLAUDE.md is delivered as a user message after the system prompt, not inside the system prompt. `--append-system-prompt` text is snapshotted on first request and reused on `--resume` unless `--system-prompt-snapshot off`. |
| (c) Live presence cheaply | `statusLine` command with `refreshInterval` (min 1s) reading a presence file the relay maintains; `claude agents --json` (supported script interface: pid, cwd, sessionId, name, status busy/waiting/idle); `~/.claude/sessions/<pid>.json` registry (one file per live session, but not a documented stable interface) | Statusline is local, no tokens, gets `session_id`, `session_name`, `transcript_path`, `workspace.repo.*`, `worktree.*`, `pr.*`. It only re-runs on events + timer, so use `refreshInterval`. |
| (d) Headless relay (`claude -p`) | `claude -p --bare --output-format json --json-schema ... --resume <id> --fork-session --no-session-persistence` to summarize a transcript by ID from any directory; `--exclude-dynamic-system-prompt-sections` for cache reuse across machines; `--permission-prompts none` for unattended | `--resume` without `--fork-session` **interleaves** into the developer's live transcript. `-p` sessions bind an inbox socket (unless `--bare`) so the relay can also receive cross-session messages. `-p` runs project hooks/MCP unless `--bare`. |

---

## 1. Memory: CLAUDE.md, rules, imports, auto-memory

Source: https://code.claude.com/docs/en/memory.md

### Locations and load order (broadest -> most specific, concatenated, not overriding)
1. **Managed policy**: macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`, Linux/WSL `/etc/claude-code/CLAUDE.md`, Windows `C:\Program Files\ClaudeCode\CLAUDE.md`. Cannot be excluded by users. Alternatively the managed-settings key `claudeMd` (string) injects the same content without a file (honored only in managed/policy settings).
2. **User**: `~/.claude/CLAUDE.md` (all projects, just you).
3. **Project**: `./CLAUDE.md` or `./.claude/CLAUDE.md` (team-shared via VCS).
4. **Local**: `./CLAUDE.local.md` (personal, gitignore it). Appended after CLAUDE.md at the same level.
- CLAUDE.md / CLAUDE.local.md in cwd **and every ancestor directory** load at launch. Files in subdirectories load lazily when Claude reads files there.
- `--add-dir` dirs do not load memory unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
- `claudeMdExcludes` (any settings layer, arrays merge) skips files by absolute-path glob; managed CLAUDE.md can't be excluded.
- Block-level HTML comments are stripped before injection (free maintainer notes).
- Max 4 MiB per file (larger skipped); target < 200 lines for adherence.
- **Delivered as a user message after the system prompt**, not inside the system prompt. Context, not enforcement.
- Project-root CLAUDE.md + unscoped rules + auto memory are **re-injected from disk after `/compact`**. Hook-added context is summarized away; only `SessionStart` hooks matching `compact` re-run.
- `/context` lists which memory files loaded; `/memory` opens/edits them. `InstructionsLoaded` hook logs exactly what loaded and why.

### `@imports`
- `@path/to/file` anywhere in a CLAUDE.md; relative to the containing file; recursive to depth 4; skipped inside backticks/code fences.
- Imported files are expanded **at launch** (they do not reduce context, just organize it).
- **External import** = path resolving outside the working directory (e.g. `@~/.claude/team-digest.md`) in a *project-level* file triggers a one-time approval dialog per project; declining disables permanently. User-scope files (`~/.claude/CLAUDE.md`, `~/.claude/rules/`) load external imports without the dialog (except Cowork desktop sessions, which skip out-of-workdir imports and symlinked user files).
- Pattern from docs for cross-worktree personal instructions: `- @~/.claude/my-project-instructions.md` in project CLAUDE.md. **Digest injection recipe**: user-scope `~/.claude/CLAUDE.md` containing `@~/.claude/team/digest.md`; relay rewrites `digest.md`; every new session (any repo) picks it up at launch and after compaction with no approval dialog.
- `@AGENTS.md` import or symlink pattern is the documented way to share instructions with other agents.

### `.claude/rules/`
- Project `.claude/rules/**/*.md` (recursive) and user `~/.claude/rules/`. Rules without `paths:` frontmatter load at launch with the same priority as `.claude/CLAUDE.md`. User rules load before project rules.
- `paths:` frontmatter (globs, brace expansion; budget 1,000 expanded patterns / 4 MiB per rule) makes a rule load only when Claude reads a matching file.
- Symlinks supported; a symlink whose target is outside the working dir is treated like an external import (needs the approval; then only unscoped rules load). `~/.claude/rules/` avoids this entirely.
- Project rules skipped if `--setting-sources` excludes `project`.

### Auto memory
- Per-repo directory `~/.claude/projects/<project>/memory/` (`<project>` derived from git repo, so **all worktrees share one**; outside git, the cwd). `MEMORY.md` index: first 200 lines / 25KB loaded every session; topic files read on demand. Types: `user`, `feedback`, `project`, `reference`; `modified` ISO timestamp in frontmatter (>= 2.1.214).
- Toggle: `autoMemoryEnabled` (settings, any scope), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, or `/memory`.
- Relocate: `autoMemoryDirectory` (absolute or `~/`), any scope; or `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_PROJECT_DIR_NAME` (>= 2.1.234) to pin the project dir name.
- Machine-local; not shared across machines/cloud; excluded from `cleanupPeriodDays` sweep. Not loaded into subagents (except forks); subagents can have their own via `memory` frontmatter.
- Idea: a relay could *write* into a project's `memory/` a `reference`-type topic file, but it's not loaded unless indexed in `MEMORY.md` (Claude-managed). Prefer CLAUDE.md imports for deterministic loading.

---

## 2. Git worktrees

Source: https://code.claude.com/docs/en/worktrees.md

- `claude --worktree <name>` / `-w`: creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`; name auto-generated if omitted; `#1234` or PR/MR URL branches from that PR (fetched from `origin`). `--tmux` (requires `--worktree`) opens a tmux/iTerm2 pane.
- Interactive `--worktree` requires prior workspace trust; `-p --worktree` skips the trust check but **never cleans up** and leaves a `git worktree lock` until a later sweep.
- `EnterWorktree` / `ExitWorktree` tools let Claude move mid-session; entering a path outside `.claude/worktrees/` prompts (only `bypassPermissions` skips).
- **Hooks and worktrees**: `${CLAUDE_PROJECT_DIR}` stays at the launch project root; hook input `cwd` follows the worktree. Read `cwd` for the worktree path.
- **Session <-> worktree mapping**: a session that was inside a worktree is returned to it on resume (interactive, `-p --resume/--continue`, SDK; >= 2.1.212). When Claude enters/exits a git-created worktree, the **transcript moves** to the new cwd's project dir (>= 2.1.198), so `--resume`/`/desktop` find it there. Hook-created worktrees keep the transcript at the launch dir. `--fork-session` starts in the launch dir. Deleted worktree -> session resumes in cwd, binding cleared.
- Isolation enforcement: blocks Edit/Write/NotebookEdit into main checkout, Bash cwd in main checkout, git redirects (`-C`, `GIT_DIR`, `cd`), and unparseable command shapes. Applies to subagents too.
- Subagents: `isolation: worktree` frontmatter; temp worktrees removed when clean; periodic sweep after `cleanupPeriodDays`. Marker in git metadata identifies Claude-created worktrees (>= 2.1.246).
- `worktree.baseRef`: `"fresh"` (default, `origin/HEAD`, fetched if stale >24h, 5s cap) or `"head"`. Can't be a branch name.
- `.worktreeinclude` (gitignore syntax) copies gitignored files (e.g. `.env`) into every git-created worktree (CLI, subagent, desktop). Not processed when a `WorktreeCreate` hook replaces creation.
- `WorktreeCreate` / `WorktreeRemove` hooks replace git logic entirely (SVN/Perforce/custom placement). Hook reads `{name}` on stdin and prints the directory path. Hook-created dirs must be **outside any git repo** or Claude Code refuses them.
- Shared with main checkout: `.git`, project-scope plugins (>= 2.1.200), and `settings.local.json` permission approvals (saved to main checkout root, >= 2.1.211).
- Statusline gets `workspace.git_worktree` (any linked worktree) and `worktree.{name,path,branch,original_cwd,original_branch}` (only in a `--worktree` session). Auto memory is shared across worktrees of a repo.
- Desktop app: "worktree" option when starting a session; `worktree.bgIsolation: "none"` disables worktree isolation for background sessions.

---

## 3. Channels (research preview)

Sources: https://code.claude.com/docs/en/channels.md , https://code.claude.com/docs/en/channels-reference.md

- A channel = a **stdio MCP server** that declares `capabilities.experimental['claude/channel'] = {}` and emits `notifications/claude/channel` `{content, meta}`. Event arrives in Claude's context as `<channel source="<server-name>" k="v">content</channel>` (meta keys must be identifier-safe; hyphenated keys silently dropped). Server `instructions` are delivered to Claude at connect (tell it what events mean and which reply tool to call).
- **Opt-in per session**: `claude --channels plugin:<name>@<marketplace> [more...]`. Being in `.mcp.json` is not enough. Flags are hidden from `--help` during preview but work.
- **Allowlist**: only Anthropic-curated plugins in `claude-plugins-official` (telegram, discord, imessage, fakechat) register via `--channels`. Custom/own-marketplace channels need `--dangerously-load-development-channels plugin:x@y` or `server:<mcp-json-name>` (per-entry bypass, confirmation prompt). Community marketplace is not on the allowlist.
- **Enterprise controls** (managed settings, users can't override): `channelsEnabled` (master switch; Team/Enterprise blocked until an Owner enables it in claude.ai Admin settings -> Claude Code -> Channels, or managed `channelsEnabled: true`; Console API-key orgs allowed by default unless they deploy managed settings) and `allowedChannelPlugins` (`[{marketplace, plugin}]`, replaces the Anthropic list; empty array blocks all except the dev flag). Pro/Max without org skip these checks.
- **Auth constraints**: requires claude.ai or Console API key; **not available on Bedrock / Google Agent Platform / Foundry**, nor behind a non-`api.anthropic.com` base URL.
- Delivery semantics: no ack; `mcp.notification()` resolves when written to transport; dropped silently if not registered or org-blocked. Events queue and are delivered **together on the next turn** if Claude is busy. Only arrive while the session is open -> "always-on" means a background/persistent session. Reply text goes out via the channel's own tool; the terminal shows only the tool call.
- Sender gating is the server's job (allowlist by sender id, pairing flows). Permission relay (`claude/channel/permission` capability, `notifications/claude/channel/permission_request` -> `notifications/claude/channel/permission` with `request_id` + `behavior`) lets allowlisted senders approve tool use remotely; only to servers registered as channels (>= 2.1.234).
- With `-p`, tools that need terminal input (AskUserQuestion, plan approval) are disabled so channels never stall.
- v2 MCP runtime gotcha: a stdio server that negotiates protocol revision 2026-07-28 (only when `MCP_PROTOCOL_NEGOTIATION=auto`) is **not** registered as a channel.
- **Can an MCP server push without `--channels`?** No. A standard MCP server is pull-only: Claude sees it only when it calls a tool, reads a resource (`@server:uri`, or the auto-provided list/read resource tools), or runs an MCP prompt (`/mcp__server__prompt`). What a plain MCP server *can* inject passively: (1) its `instructions` string at connect (truncated at 2KB with tool search on), (2) tool descriptions (also 2KB each), (3) `list_changed` notifications (refresh tool/prompt/resource lists, no content to the model), (4) elicitation dialogs (user-facing, not model context). Tool results are the only large-content path and require Claude to call the tool.

---

## 4. Agent teams, subagents, cross-session messaging

Sources: agent-teams.md, sub-agents.md, cross-session-messaging.md, agent-view.md

### Cross-session messaging (the key coordination primitive; >= 2.1.224 macOS/Linux/WSL2, >= 2.1.234 Windows; on by default)
- Tools `ListAgents` + `SendMessage` (same tool also messages subagents and teammates). `/list-agents` (`/peers`) shows this session's own name (>= 2.1.239) and reachable rows: subagents, teammates, **other local sessions** (incl. background sessions), cloud sessions and Remote Control sessions on other machines (only while this session is connected to Remote Control).
- **Same-machine transport**: per-session Unix domain socket (named pipe on Windows), never via Anthropic servers. Works on every provider incl. Bedrock/Vertex/Foundry (>= 2.1.248 there). **Cross-machine / cloud** goes through Anthropic servers and needs claude.ai sign-in + Remote Control on both ends; not with API keys or 3P providers.
- **Everything is per-user-account / per-OS-user**. Nothing crosses user accounts: local sockets are restricted to your OS user; cross-machine needs *your* Remote Control sessions; containers/WSL vs host can't see each other. Desktop app's "work across sessions" surface sees only desktop-run sessions (not CLI/VS Code ones).
- **Registry on disk**: "Each session registers itself in files on disk". Observed locally: `~/.claude/sessions/<pid>.json` (fields: `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint, pidDomain, messagingSocketPath, name, nameSource, nameSince, bridgeSessionId`) plus a `<pid>.<hash>.key` file; sockets at `/tmp/cc-socks/<pid>.sock` (docs say fallback `/tmp/cc-socks-<uid>` when the dir is unacceptable). Docs: `sessions/` "holds one small file per running session, used to detect concurrent sessions and crashes"; removed on exit, crash leftovers cleared on next launch. **Not documented as a stable interface** - use `claude agents --json` for scripts.
- **Inbox socket for scripts/hooks**: Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash commands (before any hook runs, including SessionStart). A script can connect and post; first line may be `{"type":"auth","token":"<token>"}` (optional on macOS/Linux, required on Windows). Connection closed if no complete line within 30s. `/status` shows `Peer address: uds:...`. Wire format for the message line itself is not in the docs (the docs only document the auth line); treat as reverse-engineerable but unstable.
- **Inbound controls**: `crossSessionInbound` = `accept` | `hold` | `refuse` (settings; project/local can only tighten). Default with no value: delivered when both sessions are in the same permission class (prompting vs bypassing); held for approval otherwise; held dialog expires after `dialogExpiry` (default 5m; `"never"` keeps). **Own-child messages** (a hook/Bash posting back to its own session's socket) are delivered by default if verifiable by process evidence (Linux) or by the token (macOS after exit, containers as PID 1, Windows). `-p` workers: start with `--settings '{"crossSessionInbound":"accept"}'` to take messages unattended; `--bare` binds no socket at all.
- Delivery: read between tool calls during a turn; starts a new turn if idle. Receiving Claude is told it came from another session: can't approve prompts, can't change config, slash commands arrive as text, permissions still apply. Plain text only; ~1M char cap; burst refusal; loop throttling (rate-limit per sender, drop identical repeats, queue cap 50); at most 100 held.
- **`notify_when_idle`** (>= 2.1.236, both sides, same machine only, main conversation only): one-shot notice when a watched session next goes idle/exits, with turn-finish time and a one-line status; no tokens spent in the watched session; expires after 12h.
- **Naming**: `--name`/`-n` or `/rename`; also `sessionTitle` from a SessionStart hook; default display name `<dir>-<2 chars>` (e.g. `intellegence-layer-38`) is not a resume handle; AI-generated title is. Duplicate live names get a two-word suffix (>= 2.1.232, interactive only). `@name` typeahead mentions (>= 2.1.232). Under Remote Control, `/list-agents` withholds cwd and unattributed names.
- Restrict: deny `SendMessage`/`ListAgents`; `isolatePeerMachines: true` (any scope, can only turn on) forces approval before any cross-machine send even in bypass mode.

### Agent teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
- One lead session spawns teammates (separate Claude Code instances, in-process or tmux/iTerm2 panes via `teammateMode` / `--teammate-mode`). Shared task list `~/.claude/tasks/<session-8chars>/`, team config `~/.claude/teams/<team>/config.json` (runtime state, don't edit), mailboxes `~/.claude/teams/<team>/inboxes/<agent>.json` (JSON files; writes validated).
- One team per session; no nested teams; no resume of in-process teammates; teammates inherit lead's permission mode; prompts surface in the lead. Not in Desktop. Everything is local to one user and one session; nothing crosses accounts.
- Hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted` carry a deprecated `team_name`.
- `CLAUDE_CODE_TASK_LIST_ID`: set the same ID in multiple sessions to **share one task list across sessions** (sessions that have the Task tools). Local-only shared state, useful for same-machine coordination.

### Subagents
- `--agents '{"name":{"description","prompt",...}}'` defines subagents at launch (validated, >= 2.1.242); `--agent <name>` / `agent` setting runs the main thread as a named agent (statusline `agent.name`, hooks `agent_type`). Hooks inside subagents get `agent_id` + `agent_type`. Subagent status rows customizable with `subagentStatusLine` (JSON per row on stdin: `id, name, type, status, description, label, startTime, model, effort, contextWindowSize, tokenCount, tokenSamples, cwd`).
- Subagents load CLAUDE.md, MCP, skills but not the main session's auto memory (forks do).

### Agent view / background sessions (agent-view.md)
- `claude --bg "<prompt>"` (not with `-p`) starts a background session under a **supervisor daemon** (`claude daemon status|stop`); `claude agents` TUI; `claude attach|logs|stop|respawn|rm <id>`. `--bg --exec '<cmd>'` runs a PTY shell job. `--bg --name x`. Background sessions edit in their own worktree by default (`worktree.bgIsolation`).
- **`claude agents --json [--all] [--cwd <path>]`** = the *supported* way to read session state from outside: entries `{cwd, kind: interactive|background, startedAt, id?, state?: working|blocked|done|failed|stopped, pid?, status?: busy|waiting|idle, waitingFor?, sessionId?, name?}`. Verified locally: lists interactive CLI/desktop sessions with pid/cwd/sessionId/name; `status` appears only for some. Docs explicitly suggest polling it from "a status bar, a scheduler, or another Claude session".
- State under `~/.claude/jobs/<id>/state.json` and `~/.claude/daemon/roster.json` are **not stable interfaces**; `CLAUDE_JOB_DIR` is set in background sessions; write progress files to `$CLAUDE_JOB_DIR/tmp`.
- `/fork [prompt]` copies the conversation into a new background session; peek/reply from agent view; unattended dialogs stay open until attached.

---

## 5. settings.json keys of interest

Sources: settings.md, settings-reference.md

Precedence (highest first): managed (file/MDM/server-managed) > `--settings` CLI > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`. Lists (e.g. `permissions.allow`, `hooks`, `claudeMdExcludes`) merge. Env vars are not a level; pairs decided per key.

| Key | Scope | Relevance |
|---|---|---|
| `env` | any | Sets vars for the session *and every subprocess* (hooks, MCP stdio, Bash, statusline). Overwrites shell exports. Best place for a per-developer `TEAM_DEV_ID`/`TEAM_RELAY_URL` (user scope) or team defaults (project scope). Project/local files **can't** set `CLAUDE_CONFIG_DIR`, `HOME`, `XDG_*`, `TMPDIR`, `CLAUDE_CODE_PROCESS_WRAPPER`, sync vars, `OTEL_LOG_RAW_API_BODIES`; every file ignores host-owned identity vars `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_ACCOUNT_UUID`, plus `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `CLAUDE_CODE_RESTRICTED`. Project/local `env` applies only after trust (or at startup in `-p`). |
| `permissions` (`allow`/`ask`/`deny`/`defaultMode`/`additionalDirectories`) | any (defaultMode `auto`/`bypassPermissions` only from managed/`--settings`/user) | Deny `SendMessage`/`ListAgents` to kill messaging; allow `Bash(...)`/`Monitor` patterns for relay commands. |
| `hooks` | any | See hooks.md. `disableAllHooks`, `allowManagedHooksOnly` also gate `statusLine`, `subagentStatusLine`, `fileSuggestion`. |
| `statusLine` | any | `{type:"command", command, padding?, refreshInterval?(>=1s), hideVimModeIndicator?}`. |
| `subagentStatusLine` | any | Custom subagent rows. |
| `model`, `availableModels`, `effortLevel`, `modelSettings` | any/managed | `--model` overrides; managed `availableModels` locks. |
| `agent` | any | Run main thread as a named subagent. |
| `crossSessionInbound`, `isolatePeerMachines`, `dialogExpiry` | any / any / user+managed | Messaging controls (above). |
| `teammateMode`, `worktree.{baseRef,bgIsolation,symlinkDirectories,sparsePaths}` | any | Teams/worktrees. |
| `claudeMd` | **managed only** | Inline org CLAUDE.md text. |
| `claudeMdExcludes`, `autoMemoryEnabled`, `autoMemoryDirectory` | any | Memory. |
| `companyAnnouncements` | any | Array of strings shown at startup (one at random per session; first one on first launch). A cheap, visible-to-human (not to Claude) team banner. |
| `footerLinksRegexes` | user or managed | Regex -> clickable footer badges for IDs in output (e.g. `PROJ-123`). |
| `attribution.{commit,pr,sessionUrl}` | any | Commit trailer / PR text; `sessionUrl` adds `Claude-Session` trailer linking claude.ai session for cloud/Remote Control sessions. |
| `channelsEnabled`, `allowedChannelPlugins` | managed | Channels gating. |
| `enabledPlugins`, `extraKnownMarketplaces`, `pluginConfigs` | any | Plugins (see plugins-mcp.md). |
| `allowedMcpServers`, `deniedMcpServers`, `managedMcpServers`, `enableAllProjectMcpServers`, `enabledMcpjsonServers` | managed / any | MCP allow/deny. |
| `remoteControlAtStartup`, `disableRemoteControl`, `agentPushNotifEnabled`, `inputNeededNotifEnabled`, `preferredNotifChannel`, `awaySummaryEnabled` | user/managed | Remote Control + notifications. |
| `cleanupPeriodDays`, `desktopSessionCleanupPeriodDays` | any | Transcript retention (default 30d). |
| `apiKeyHelper`, `otelHeadersHelper`, `forceLoginMethod`, `forceLoginOrgUUID` | user/managed | Auth. |
| `disableAgentView`, `processWrapper` | any | Background sessions. |

`/config key=value` sets keys without the UI (also in `-p`); `/status` shows the managed source in effect; `claude doctor` validates settings files.

---

## 6. CLI reference: flags that matter here

Source: https://code.claude.com/docs/en/cli-reference.md , headless.md

**Commands**: `claude`, `claude -p "..."` (SDK/print), `-c`, `-r <id|name> "..."`, `claude agents [--json [--all] --cwd]`, `claude attach|logs|stop|respawn|rm <id>`, `claude daemon status|stop --any [--keep-workers]`, `claude auth status [--text]` (JSON: `loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType`; exit 1 if logged out), `claude doctor`, `claude mcp ...`, `claude plugin ...`, `claude project purge`, `claude remote-control [--name] [--remote-control-session-name-prefix]`, `claude setup-token` (long-lived OAuth token for CI/scripts; subscription required), `claude ultrareview`, `claude import`.

**Flags**:
- System prompt: `--system-prompt`, `--system-prompt-file` (replace, mutually exclusive), `--append-system-prompt`, `--append-system-prompt-file` (append; combinable), `--append-subagent-system-prompt[-file]`, `--system-prompt-snapshot off|on` (>= 2.1.257). **Snapshot gotcha**: the prompt is built once on the first request and recorded; later `--resume/--continue` reuse it until compaction/new conversation. Bare mode records nothing unless `--system-prompt-snapshot on`. `--exclude-dynamic-system-prompt-sections` moves cwd/env/memory paths/git flag into the first user message for cache reuse across users/machines (only with default prompt).
- Sessions: `--session-id <uuid>` (choose the ID up front; useful so a relay knows the ID before the transcript exists), `--name/-n`, `--resume/-r <id|name|/abs/path.jsonl>`, `--continue/-c`, `--fork-session`, `--from-pr <n>`, `--no-session-persistence` (print only), `--worktree/-w`, `--tmux`, `--bg`, `--exec`, `--cloud`, `--remote-control`, `--teleport`.
- Config: `--settings <file|json>` (2 MiB max, overrides files, can't beat managed), `--setting-sources user,project,local`, `--mcp-config <file|json>...` (with `-p` waits up to `MCP_TIMEOUT` 30s for servers), `--strict-mcp-config`, `--plugin-dir`, `--plugin-url`, `--agents <json>`, `--agent <name>`, `--add-dir`, `--tools "Bash,Edit,Read"`, `--allowedTools`, `--disallowedTools "mcp__*"`, `--model`, `--effort`, `--fallback-model`, `--permission-mode`, `--dangerously-skip-permissions`, `--permission-prompt-tool <mcp_tool>`, `--permission-prompts none` (>= 2.1.259), `--bare` (= `CLAUDE_CODE_SIMPLE=1`: no hooks/skills/commands/subagents/plugins/MCP autodiscovery/auto memory/CLAUDE.md; no keychain/OAuth -> needs `ANTHROPIC_API_KEY` or `apiKeyHelper`; MCP via `--mcp-config` still works; no inbox socket), `--restricted` (>= 2.1.248), `--channels`, `--dangerously-load-development-channels`, `--init`, `--init-only` (run Setup + SessionStart hooks then exit), `--maintenance`, `--max-turns`, `--max-budget-usd`, `--json-schema`, `--output-format text|json|stream-json`, `--input-format stream-json`, `--include-partial-messages`, `--include-hook-events`, `--forward-subagent-text`, `--replay-user-messages`, `--verbose`, `--debug[=mcp,startup]`, `--debug-file`, `--teammate-mode`.

**Headless specifics** (headless.md):
- `--output-format json` -> `{result, session_id, total_cost_usd, usage, structured_output?, permission_denials, ...}`. `stream-json` first event `system/init` (model, tools, `mcp_servers[{name,status}]`, `mcp_server_errors`, `plugins`, `plugin_errors`, `capabilities[]`); last is `result`. Subagent messages carry `parent_tool_use_id`.
- `claude -p --resume <id>` works **from any directory** (>= 2.1.223; searches current project + worktrees, then every project; must be unique). Also `--resume /abs/path/to/transcript.jsonl`. Docs example: `claude -p --resume <session-id> --output-format json "summarize what we changed" | jq -r '.result'`.
- **Gotcha**: resuming the same session in two processes without forking interleaves both into one transcript. A relay summarizing a developer's live session should add `--fork-session` (+ `--no-session-persistence` to leave no extra transcript). `-p --continue` includes `-p`/SDK/`/loop` sessions; interactive `--continue` skips them.
- `-p` without `--bare` runs project hooks and `.mcp.json` servers **without trust dialogs**; `-p` never shows workspace trust or per-server approval.
- Piped stdin capped at 10MB. Exit 0/non-zero; SIGTERM -> exit 143, runs `SessionEnd` hooks only. `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (10 min default wait for background subagents/workflows), `CLAUDE_CODE_MAX_TURNS`.
- Slash commands/skills work inside the `-p` prompt string; `/mcp` with no arg prints server status; `/rename <name>`, `/config k=v`, `/model x` accepted (>= 2.1.205).
- Permission modes for `-p`: default is Manual (prompts denied when no host); `--permission-mode auto|acceptEdits|dontAsk`; `--permission-prompts none` denies without waiting and removes AskUserQuestion.
- `--bare` "is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release."

---

## 7. Session naming, resume, transcripts

Source: https://code.claude.com/docs/en/sessions.md

- Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl` (`<project>` = cwd path with non-alphanumerics -> `-`, truncated + hashed past 200 chars). JSONL entry format is **internal and version-unstable**; docs say use `/export`, `-p --output-format json`, hooks' `transcript_path`, or the SDK instead of parsing. `CLAUDE_CONFIG_DIR` relocates; `CLAUDE_CODE_PROJECT_DIR_NAME` (with `CLAUDE_CONFIG_DIR`) pins the project dir name (multi-tenant hosts). `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` suppresses transcript writes; retention `cleanupPeriodDays`.
- Extra per-session dirs: `projects/<project>/<session>/subagents/`, `.../tool-results/` (large tool outputs spilled), `file-history/<session>/`, `session-env/`, `image-cache/<session>/`, `uploads/<session>/`.
- Session picker: `claude --resume` (Ctrl+A all projects, Ctrl+W all worktrees, Ctrl+B branch), `/resume <name|id>`, `--from-pr`. `-p`/SDK sessions are hidden from the picker and from interactive `--continue` but resumable by ID.
- Names: `-n`, `/rename`, `Ctrl+R` in picker, plan-accept title, rename from claude.ai/desktop. Statusline `session_name` = custom name or AI title (never the default display name).
- `/branch` and `--fork-session` create new IDs; `/clear` saves and starts a new session (statusline cost resets; `CLAUDE_CODE_SESSION_ID` updates for Bash/hooks; an MCP server keeps the ID it was spawned with).
- Moving: `/cd <path>` relocates the session into the new directory's project storage (>= 2.1.196 for clean picker behavior); entering a git worktree also moves the transcript (>= 2.1.198).
- Resume restores: history, model, agent, permission mode (terminal only, with table of exceptions), active goal, scheduled tasks. **Not restored**: `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir` (pass again); system-prompt flags are snapshotted (see §6).
- `/export [file]` = rendered plain-text transcript. `/desktop` moves a CLI session into the desktop app.

---

## 8. Status line: can it show live team presence?

Source: https://code.claude.com/docs/en/statusline.md

- Yes, cheaply. `statusLine.command` is any shell command; JSON on stdin; stdout rendered (multi-line, ANSI colors, OSC 8 links); **runs locally, no tokens**; `COLUMNS`/`LINES` env give width. Subprocess env includes `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, plus settings `env`.
- Triggers: session start/resume, each new assistant message, `/compact`, permission-mode change, vim toggle, command change, **`refreshInterval` timer (min 1s)**, rate-limit `resets_at`, cache `expires_at`. Debounced 300ms; in-flight script cancelled on new trigger. Event triggers go quiet when idle -> **set `refreshInterval` (e.g. 5-15s) for presence**.
- Input fields: `session_id`, `session_name`, `prompt_id`, `transcript_path`, `version`, `cwd`, `workspace.{current_dir,project_dir,added_dirs,git_worktree,repo.{host,owner,name}}`, `model.{id,display_name}`, `cost.*`, `context_window.*`, `rate_limits.*`, `prompt_cache.*`, `effort.level`, `thinking.enabled`, `fast_mode`, `output_style.name`, `vim.mode`, `agent.name`, `pr.{number,url,review_state,kind}`, `worktree.{name,path,branch,original_cwd,original_branch}`.
- **No user identity field** in the JSON; derive dev identity from settings `env` or `claude auth status` (cache it - it's an extra process).
- Presence recipe: the relay (or a SessionStart/Stop hook pair) maintains `~/.claude/team/presence.json`; the statusline script reads that file (cheap) and prints e.g. `● alice:api-worker (feat/auth) · bob:idle`. Docs' own caching pattern: key cache files by `session_id`, refresh every N seconds. Use `claude agents --json` for the *local* session list, but avoid running it on every tick without caching (it spawns a process).
- Gates: `disableAllHooks` (outside managed) disables custom statusline; `allowManagedHooksOnly` restricts to managed statusline. Plugins can ship a default `statusLine`/`subagentStatusLine`.
- Related: `footerLinksRegexes` (badges from IDs), `awaySummaryEnabled` session recap on return, terminal title from `/rename` (`terminalTitleFromRename`).

---

## 9. `/mcp`, `/hooks`, other commands

- `/mcp [reconnect <s>|enable|disable [<s>|all]]`: interactive server list + OAuth; in `-p`, prints text status (>= 2.1.205). `claude mcp login|logout <name>` from the shell. `/mcp` also enables computer use on macOS.
- `/hooks`: **read-only** browser of configured hooks (event counts, matchers, type prefix `[command|prompt|agent|http|mcp_tool]`, source: User/Project/Local/Plugin/Session Hooks). Editing = settings JSON.
- `/status`: version, model, account, connectivity, `Setting sources` (managed), `Session kind`, `Peer address` (inbox socket).
- `/list-agents` (`/peers`), `/rename`, `/context`, `/memory`, `/export`, `/statusline`, `/desktop`, `/cd`, `/remote-control` (`/rc`), `/loop`, `/schedule` (`/routines`, cloud), `/tasks`, `/fork`, `/branch`, `/goal`, `/reload-plugins`, `/config k=v`, `/permissions`, `/team-onboarding` (generates a markdown onboarding guide from your last 30 days of sessions/commands/MCP usage; share link for claude.ai subscribers), `/insights` -> `~/.claude/usage-data/report.html`.
- Hook types beyond shell (context for hooks.md): `http` (POST JSON to URL, allowlist `allowedHttpHookUrls`, `httpHookAllowedEnvVars`), `mcp_tool` (call a connected MCP server's tool as a hook), `prompt`, `agent`.

---

## 10. Desktop app vs CLI

Source: https://code.claude.com/docs/en/desktop.md

- Same engine, separate session history; **shares** CLAUDE.md/CLAUDE.local.md, `~/.claude.json` + `.mcp.json` MCP servers, hooks and skills from settings, `~/.claude/settings.json` permission rules. Managed settings on disk apply; server-managed apply on Anthropic API with eligible login; Cowork sessions never fetch admin-console settings.
- Desktop additionally loads MCP servers from `claude_desktop_config.json` into local Code-tab sessions (CLI doesn't read it; `claude mcp add-from-claude-desktop` imports). Same-name precedence differs from the CLI.
- Plugins: Plugin manager UI, scopes user/project/local; org-managed plugins available the same as CLI. Not in cloud sessions (declare `enabledPlugins` in repo settings instead).
- Sessions: sidebar tabs; "worktree" option per session; `Local`/`Cloud`/`SSH`/`WSL` environments; env vars via an encrypted local environment editor (or settings `env`). Desktop's own "work across sessions" (list/read/message/archive) sees only desktop-run sessions, 20 most recent, not CLI/VS Code/cloud sessions; cross-session messaging (§4) separately reaches terminal sessions.
- Not available: `-p`/`--output-format`, agent teams, `dontAsk` mode, terminal-dialog commands (`/permissions` -> "isn't available"; `/config` opens Settings, args ignored), inline suggestions, 3P providers (except via gateway/3P desktop).
- Observed locally: desktop sessions run a bundled engine (`CLAUDE_CODE_EXECPATH=.../Claude/claude-code/2.1.260/...`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_HOST_SESSION_ID=local_<uuid>`) and still register in `~/.claude/sessions/` and `claude agents --json`, so a local relay sees both surfaces. Scheduled tasks exist for Desktop (min 1 min, machine on, config files + connectors).

---

## 11. Session id / transcript path exposure

| Consumer | session id | transcript path | other |
|---|---|---|---|
| Hooks (stdin JSON) | `session_id` | `transcript_path` (written async; may lag) | `cwd`, `prompt_id`, `scratchpad_dir` (>= 2.1.257), `permission_mode`, `effort`, `hook_event_name`, `agent_id`/`agent_type` in subagents; SessionStart adds `source`, `model`, `session_title`, resume-cost fields |
| Hook + Bash + statusline env | `CLAUDE_CODE_SESSION_ID` (updated on `/clear`) | - | `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_ENV_FILE` (SessionStart/Setup/CwdChanged/FileChanged only), `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, `CLAUDE_CODE_BRIDGE_SESSION_ID` (Remote Control `session_...` id, >= 2.1.199), `CLAUDE_CODE_REMOTE`/`_REMOTE_SESSION_ID` (cloud), `CLAUDE_JOB_DIR` (background sessions), `CLAUDE_CODE_ENTRYPOINT` (observed), settings `env` |
| Stdio MCP server subprocess | `CLAUDE_CODE_SESSION_ID` (the ID at spawn; not updated on `/clear`; on `--continue`/bare `--resume` may be the initial startup ID) | **no** | `CLAUDECODE=1`; **not** `CLAUDE_CODE_CHILD_SESSION`; inherits shell env unless `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`; `${VAR}` expansion in `.mcp.json` `command/args/env/url/headers`; `OTEL_*` never passed; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials |
| Statusline stdin | `session_id` | `transcript_path` | see §8 |
| `-p` JSON/stream output | `session_id` in `result`, `system/init`, retry events | - | `--session-id` lets you choose it |
| OTel | `session.id` | - | `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`, `prompt.id`, `message.uuid`, `terminal.type`, `app.entrypoint`, `vcs.*` (>= 2.1.269, opt-in) |
| `claude agents --json` | `sessionId` | - | `pid`, `cwd`, `name`, `kind`, `status`, `state` |
| Remote MCP (HTTP) | not documented; use `headersHelper` / `headers` with `${CLAUDE_CODE_SESSION_ID}`? (only shell-env expansion is documented, and the parent Claude process's env doesn't contain its own session id) | - | claude.ai connectors carry the user's OAuth identity |

**Identity per developer, concretely**: the only doc-level identity carriers are (1) OAuth-derived OTel attributes (`user.email` etc., sent only to your OTel endpoint), (2) `claude auth status` JSON, (3) `~/.claude.json` (holds sign-in, anonymous `user.id`; treat as private), (4) whatever you set in user-scope settings `env`, and (5) `OTEL_RESOURCE_ATTRIBUTES` (`department=..,team.id=..`) which also lands on every metric/event. Nothing injects a peer's identity into another user's session automatically; there is no shared-team registry service in the product. Every coordination surface (messaging, teams, agent view, artifacts comments aside) is scoped to one Anthropic account and mostly one machine.

---

## 12. Other surfaces worth knowing

- **OpenTelemetry (monitoring-usage.md)**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_LOGS_EXPORTER=otlp` + endpoint (settable via managed/user `env`) streams events `user_prompt` (`prompt` text only with `OTEL_LOG_USER_PROMPTS=1`), `assistant_response`, `tool_result`, `tool_decision`, `api_request`, `permission_mode_changed`, `mcp_server_connection`, `skill_activated`, `hook_registered`, etc., stamped with `session.id`, `user.email`, `organization.id`, repo attrs. A local OTLP collector is a **hook-free, plugin-free live feed of every session on the machine** (and, if the endpoint is shared, of the whole team). Managed settings can lock the OTLP destination.
- **Monitor tool**: Claude can tail a file/command or a WebSocket and gets each line/message as an event mid-conversation. Denies `ws://` to private/link-local addresses (so a localhost relay socket is out; use a command like `tail -f` on a relay file instead). Not on Bedrock/Vertex/Foundry or with `DISABLE_TELEMETRY`. Plugins can declare auto-start monitors.
- **Scheduled tasks**: `/loop [interval] [prompt]` + `CronCreate` tools (session-scoped, min 1 min, restored on resume, 7-day expiry); Desktop scheduled tasks (machine-local, no open session needed); cloud Routines (`/schedule`, min 1h, fresh clone, no local files).
- **Remote Control**: `claude remote-control [--name] [--remote-control-session-name-prefix]` (server mode) / `claude --remote-control` / `/rc` / `remoteControlAtStartup`. Needs claude.ai subscription, `api.anthropic.com`, feature flags on; Team/Enterprise admin toggle. Enables cross-machine session listing/messaging and mobile push (`PushNotification` tool; `CLAUDE_CLIENT_PRESENCE_FILE` suppresses pushes while you're at the keyboard - a presence primitive Claude Code already understands).
- **Artifacts** (Pro/Max/Team/Enterprise): publish a page from a session; Team/Enterprise editor roles, comments that can wake the publishing session, shared DB per artifact. A possible team-visible "digest board" surface, but it's claude.ai-hosted and not injected into sessions.
- **`--exclude-dynamic-system-prompt-sections`**: for a fleet running the same `-p` task across developers, keeps the system prompt byte-identical for cache reuse.
- **Setup hooks / `--init-only`**: `claude --init-only` runs Setup + SessionStart hooks and exits; usable by a relay to warm per-developer state without a conversation.

---

## 13. Recipes

### (b) Per-session team digest, no hooks/plugins
```
# one-time, per developer (user scope, no approval dialog)
cat >> ~/.claude/CLAUDE.md <<'EOF'
# Team context
@~/.claude/team/digest.md
EOF
# relay rewrites ~/.claude/team/digest.md; every new session loads it at launch
# and re-injects it after /compact. Keep it short (< ~100 lines).
```
Alternatives: `claude --append-system-prompt-file ~/.claude/team/digest.md` for scripted launches (remember snapshot semantics on resume); an MCP server whose `instructions` carries a <= 2KB pointer ("call team_digest for today's context") and exposes a `team_digest` tool for the full text; org-wide fixed text via managed `claudeMd`.

### (c) Presence in the statusline
```json
{ "statusLine": { "type": "command", "command": "~/.claude/team/statusline.sh", "refreshInterval": 10 } }
```
`statusline.sh`: read stdin JSON (`session_id`, `session_name`, `workspace.repo.name`, `worktree.name`), write own heartbeat to `~/.claude/team/presence/<session_id>.json` (or let the relay do it from `claude agents --json` + hooks), read the merged team presence file the relay syncs down, print one line. Zero API tokens.

### (d) Headless relay summarizer
```bash
# discover live sessions (supported interface)
claude agents --json --all | jq -c '.[] | select(.sessionId) | {sessionId,cwd,name,status,state}'

# summarize a session without touching its live transcript
claude -p --resume "$SID" --fork-session --no-session-persistence \
  --bare --settings '{"crossSessionInbound":"refuse","disableAllHooks":true}' \
  --permission-prompts none --max-turns 1 --output-format json \
  --json-schema '{"type":"object","properties":{"summary":{"type":"string"},"files":{"type":"array","items":{"type":"string"}}},"required":["summary"]}' \
  "Summarize what this session has done so far for a teammate; list files touched." \
  | jq '.structured_output'
```
Notes: `--bare` needs `ANTHROPIC_API_KEY`/`apiKeyHelper` (no keychain OAuth) - drop `--bare` to use the subscription login, but then project hooks/MCP run; `--resume` by ID works from any cwd (>= 2.1.223); cost appears in `total_cost_usd`. To *push* the digest into a live session: write it to the CLAUDE.md-imported file (next session/compact) or post a cross-session message (needs the undocumented socket line format, or drive a helper `claude -p` session that calls `SendMessage`; a `-p` relay session itself can receive messages if started with `crossSessionInbound: accept`).

---

## 14. Gotchas collected

- Version gates: cross-session messaging >= 2.1.224; `/list-agents` own-name + teammates >= 2.1.239; `notify_when_idle` >= 2.1.236; `--resume` cross-project >= 2.1.223; `-p --resume` re-enters worktree >= 2.1.212; `--system-prompt-snapshot` >= 2.1.257; `--permission-prompts` >= 2.1.259; `scratchpad_dir` hook field >= 2.1.257; `CLAUDE_CODE_PROJECT_DIR_NAME` >= 2.1.234; `--restricted` >= 2.1.248. Local CLI is 2.1.236 (desktop engine 2.1.260).
- CLAUDE.md is context, not enforcement; delivered as a user message; adherence drops past ~200 lines; imports don't save context.
- Project-level `@~/...` imports trigger an approval dialog once per project; declining silently disables forever. User-scope imports don't.
- `--append-system-prompt` text is recorded on first request and reused on resume until compaction (unless `--system-prompt-snapshot off`, >= 2.1.257).
- MCP server `instructions` and tool descriptions are truncated at 2KB with tool search on (default on first-party API; off behind non-first-party base URLs).
- Standard MCP servers cannot push into a session; only channel-capable servers named in `--channels` (allowlisted or dev flag) can, and channels are unavailable on Bedrock/Vertex/Foundry and blocked for Team/Enterprise until an Owner enables them.
- `~/.claude/sessions/*.json`, `~/.claude/jobs/*/state.json`, `roster.json`, transcript JSONL, and team inbox files are all documented as internal/unstable; `claude agents --json` is the supported read path.
- Statusline gets no user identity; event triggers go quiet when idle (use `refreshInterval`); `disableAllHooks`/`allowManagedHooksOnly` also disable custom statuslines.
- `claude -p --resume <id>` without `--fork-session` appends to the live transcript ("messages from both interleave").
- `-p` runs project hooks + `.mcp.json` with no trust dialog; `--bare` avoids that but drops OAuth/keychain auth.
- `-p` sessions bind an inbox socket by default and hold unknown-class messages for `dialogExpiry` (5m) then drop; `--bare` binds none.
- `CLAUDE_CODE_SESSION_ID` for a stdio MCP server is frozen at spawn; hooks/Bash see the live value.
- `OTEL_*` vars are never passed to subprocesses; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from hooks/Bash/MCP env.
- Settings `env` from project/local files applies only after workspace trust (except `-p`), and can't set identity/storage vars; `CLAUDE_CODE_ACCOUNT_UUID` and `CLAUDE_CODE_REMOTE` are ignored from every file.
- Worktree `${CLAUDE_PROJECT_DIR}` doesn't follow the worktree; hook `cwd` does. `-p --worktree` never cleans up and leaves a lock.
- Monitor WebSocket source refuses private/link-local/loopback targets; use a command-based watch for a local relay.
- Desktop app "work across sessions" sees only desktop sessions; `/permissions` and `/config args` don't work in the Code tab.
- Agent teams: experimental, one team per session, no resume of in-process teammates, not in Desktop; all state local to one user.
- Everything account-scoped: no surface crosses Anthropic user accounts (local sockets are per OS user; cross-machine requires your own Remote Control sessions).

---

## Sources
- https://code.claude.com/docs/llms.txt
- https://code.claude.com/docs/en/memory.md
- https://code.claude.com/docs/en/worktrees.md
- https://code.claude.com/docs/en/channels.md
- https://code.claude.com/docs/en/channels-reference.md
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/cross-session-messaging.md
- https://code.claude.com/docs/en/agent-teams.md
- https://code.claude.com/docs/en/sub-agents.md
- https://code.claude.com/docs/en/agent-view.md
- https://code.claude.com/docs/en/settings.md
- https://code.claude.com/docs/en/settings-reference.md
- https://code.claude.com/docs/en/env-vars.md
- https://code.claude.com/docs/en/cli-reference.md
- https://code.claude.com/docs/en/headless.md
- https://code.claude.com/docs/en/sessions.md
- https://code.claude.com/docs/en/statusline.md
- https://code.claude.com/docs/en/hooks.md (common input fields, SessionStart, /hooks, hook types only)
- https://code.claude.com/docs/en/commands.md
- https://code.claude.com/docs/en/desktop.md
- https://code.claude.com/docs/en/monitoring-usage.md
- https://code.claude.com/docs/en/tools-reference.md
- https://code.claude.com/docs/en/claude-directory.md
- https://code.claude.com/docs/en/context-window.md
- https://code.claude.com/docs/en/scheduled-tasks.md
- https://code.claude.com/docs/en/remote-control.md
- https://code.claude.com/docs/en/feature-availability.md
- https://code.claude.com/docs/en/whats-new/index.md
- Local verification on this Mac: `claude --version`, `claude auth status`, `claude agents --json`, `claude daemon status`, `ls ~/.claude/sessions /tmp/cc-socks`, `env | grep CLAUDE` inside a tool subprocess.
