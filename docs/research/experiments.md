# Contract experiments on the real Claude Code CLI (Appendix B)

Run on 2026-09-12, Claude Code CLI **2.1.236** (`claude --version`), macOS, node v24.7.0 at `/opt/homebrew/bin/node`.
All runs were headless (`claude -p`), time-boxed to ~35 min. Nothing under the project tree was touched
except this file. Scratch rig lives in
`<scratch>/exp`
(`repo/`, `repo2/`, `plugin/`, `mktsrc/` + bare `mkt.git`, `out/*.debug.log`, `out/*.stream.jsonl`, `log.jsonl`).

Interactive-only behaviours (trust dialog, permission prompt UI, status line, Desktop tab lifecycle, `/cd`,
`/reload-plugins`) could not be driven headlessly and are marked **untestable** with the closest evidence.

## 0. The rig and the invocation that worked

Plugin under test: `plugin/.claude-plugin/plugin.json` (`name: relayexp`, `version: 0.0.1`), `plugin/hooks/hooks.json`
(exec-form `command: /opt/homebrew/bin/node`, `args: ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.js", "<verb>"]` for
SessionStart, UserPromptSubmit, PreToolUse `Edit|Write|MultiEdit|NotebookEdit`, PreToolUse `Read`, PreToolUse
`mcp__plugin_relayexp_relayexp__.*`, PostToolUse edit (`async: true`), PostToolUse `Bash` with `if: "Bash(git *)"`
(`async: true`), PostToolUse `Bash` (sync control), TaskCreated, TaskCompleted, CwdChanged, Stop (`async: true`),
SessionEnd), and `plugin/.mcp.json` (stdio, `command: /opt/homebrew/bin/node`,
`args: ["${CLAUDE_PLUGIN_ROOT}/server/mcp.js"]`, one tool `ping` built with `@modelcontextprotocol/sdk` 1.30.0 + zod,
installed with npm under the scratch dir, not the monorepo).
`hook.js` appends `{verb, pid, ppid, env subset, stdin}` to `log.jsonl` and emits whatever `mode.json[verb].out` says;
`mcp.js` logs `process.pid/ppid` and its env at start and on each `ping`.

Working invocation (prompt **must** go on stdin — `--allowedTools` is variadic and swallows a trailing positional
prompt, yielding `Error: Input must be provided either through stdin or as a prompt argument`):

```sh
cd "$EXP/repo" && printf '%s' "<prompt>" | \
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_PID -u CLAUDE_CODE_SESSION_ID \
      -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_PROJECT_DIR -u CLAUDE_ENV_FILE -u CLAUDE_PLUGIN_ROOT \
  claude -p --plugin-dir "$EXP/plugin" --debug-file "$EXP/out/<name>.debug.log" \
      --output-format stream-json --verbose --include-hook-events \
      --permission-mode acceptEdits --allowedTools "Bash(git *)" "Edit" "Read" "mcp__plugin_relayexp_relayexp__ping"
```

Notes on flags (2.1.236 `--help`): `--plugin-dir` (repeatable), `--settings <file-or-json>`, `--permission-mode`
(`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`), `--allowedTools`, `--output-format json|stream-json`,
`--include-hook-events` (stream-json only; emits `system/hook_started` and `system/hook_response` with the hook's
stdout, exit code and `outcome: success|cancelled`), `--resume <id> --fork-session`, `--debug-file`.
**There is no `--max-turns` on 2.1.236**; turn count was bounded by prompt design instead.
Every `-p` run takes 7–15 s wall clock on this machine (the user's many claude.ai/MCP connectors slow startup).

## 1. Results per Appendix B item

| # | Item | Result | One-line evidence |
|---|------|--------|-------------------|
| 1 | First-session liveness after install | **partial** | Headless `--settings` path: session 1 registers the marketplace, session 2 caches the plugin, session 3 loads hooks (see §2.1). Trust-dialog path untestable headless. |
| 4 | Permission rule form for plugin MCP | **confirmed (both)** | `mcp__plugin_relayexp_relayexp` and `mcp__plugin_relayexp_relayexp__*` each allow `ping` with zero `permission_denials`; control rule `mcp__nothing_here` → denied. |
| 5 | `ask` semantics | **partial** | Headless: `ask` becomes a denial whose reason is the tool error (`decision_reason_type: "hook"`); `additionalContext` still delivered; same in a subagent and under `dontAsk`. Prompt UI / "always allow" bypass untestable. |
| 6 | async hooks deliver `additionalContext`, no `hook error`, no duplicates | **confirmed** | Async post-edit / post-git context reached Claude on the very next model request (same turn); 0 hook errors in 10 runs; 3 parallel Reads → 3 distinct `tool_use_id`s, no duplicate firings. |
| 7 | `sessionTitle` on resume/fork; ≤ 6 KB inline; `fork` new id | **confirmed** | `customTitle` written on startup, `resume` and `fork`; 5,977-char context delivered inline (`provided additionalContext (5977 chars)`, full text in transcript); `source:"fork"` with a new `session_id`. |
| 8 | `if: "Bash(git *)"` | **confirmed** | Fired for `git add -A && git commit --allow-empty -m x`; not for `pnpm --version` (control hook without `if` fired for both). |
| 9 | TaskCreated/TaskCompleted, CwdChanged, `prompt_id` on Stop | **partial** | Task events fire with `task_id`, `task_subject`, `task_description`; `prompt_id` present on Stop (and on SessionEnd). CwdChanged untestable (`/cd isn't available in this environment` under `-p`). |
| 10 | `CLAUDE_ENV_FILE` exports reach later Bash | **confirmed** | SessionStart hook appended `export RELAYEXP_ENV=fromhook`; later `printenv RELAYEXP_ENV` → `fromhook`. |
| 11 | `systemMessage` on UserPromptSubmit shown to user | **confirmed (JSON path)** | stream-json emits `{"type":"system","subtype":"informational","content":"UserPromptSubmit says: Relay: 1 impact, 1 note (…)","level":"notice"}`; it is routed to the user channel, not to Claude. Interactive rendering untestable. |
| 13 | `${CLAUDE_PLUGIN_ROOT}` in exec-form args; basename = commit SHA | **confirmed / refuted** | Placeholder substitutes in both `hooks.json` and `.mcp.json` args (plugin-dir and cache installs). **Basename is `plugin.json.version` (`…/relayexp/0.0.1`), or `unknown` when absent — not the SHA.** The SHA is `gitCommitSha` in `~/.claude/plugins/installed_plugins.json`. |
| 16 | MCP server `ppid` == Claude PID == `CLAUDE_PID` in hooks | **confirmed (CLI)** | MCP `ppid=15992`; every hook's `CLAUDE_PID=15992` and `ppid=15992`. Desktop untestable (see §2.8 for Desktop env evidence). |
| 17 | Detached `bg` worker survives `-p` teardown | **confirmed** | `spawn(..., {detached:true, stdio:'ignore'}).unref()` from SessionEnd and Stop hooks: workers re-parented to `ppid 1`, wrote `done` 4 s after the CLI had exited. |

## 2. Details, evidence and implications for the build

### 2.1 Item 1 — liveness through the install path (headless analogue)

Rig: `mktsrc/` git repo with `.claude-plugin/marketplace.json` (`name: relaymkt`, plugin source `./plugins/relayexp`),
bare clone `mkt.git`; scratch `repo2/` with `.claude/settings.json`
`{"extraKnownMarketplaces":{"relaymkt":{"source":{"source":"git","url":"file:///…/mkt.git"},"autoUpdate":true}},"enabledPlugins":{"relayexp@relaymkt":true}}`.

- **Repo settings alone in a never-trusted folder (`-p`)**: nothing happens. Debug:
  `Skipping orphaned enabledPlugins entry relayexp@relaymkt: marketplace not registered`. Matches plugins-mcp.md §8.5.
- **Same keys passed via `--settings '<json>'` (a trusted settings source; closest headless analogue of
  "trust dialog accepted")**, with an empty cache:
  - Session 1: `[reconcile] 1 marketplace(s): relaymkt(install)` → `git pull: cwd=~/.claude/plugins/marketplaces/temp_…`
    → `Added marketplace source: relaymkt` → `Synced autoUpdate=true from settings for marketplace: relaymkt` →
    `installPluginsForHeadless: installed marketplace relaymkt`. But: `Plugin not available for MCP: relayexp@relaymkt -
    error type: plugin-cache-miss` and `Plugin "relayexp" not cached at ~/.claude/plugins/marketplaces/relaymkt — run
    /plugin to refresh`. No hooks fired, tool absent ("NO TOOL").
  - Session 2: `Copying source directory ./plugins/relayexp for plugin relayexp@relaymkt` →
    `Successfully cached plugin relayexp@relaymkt at ~/.claude/plugins/cache/relaymkt/relayexp/0.0.1` →
    `Added relayexp@relaymkt with scope user`. Still `plugin-cache-miss` for MCP/hooks in that same session (the loader
    ran before the cache fill). No hooks fired, tool absent.
  - Session 3: hooks fired with `CLAUDE_PLUGIN_ROOT=~/.claude/plugins/cache/relaymkt/relayexp/0.0.1`,
    `CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/relayexp-relaymkt`; the MCP server was spawned from the cache (it then
    crashed only because the throwaway server imports `@modelcontextprotocol/sdk` from the scratch dir's
    `node_modules`, which the cached copy cannot see — this is exactly why §9.1 bundles `dist/mcp.mjs`).
- `file://` **git URLs work as a settings `source: "git"`** (clone succeeded: `~/.claude/plugins/marketplaces/relaymkt`
  has `origin file:///…/mkt.git`, HEAD = marketplace commit `33ebdd39…`). The CLI `claude plugin marketplace add
  file:///…/mkt.git` is **rejected** (`Invalid marketplace source format. Try: owner/repo, https://..., or ./path`);
  a bare-repo path is rejected too (`Marketplace file not found at …/mkt.git/.claude-plugin/marketplace.json`).
  `claude plugin marketplace add <working-tree dir> --scope project` registers a **`directory`** source and **rewrites
  the project `.claude/settings.json`** (it replaced the git entry and dropped `autoUpdate`). With a directory source the
  plugin runs **in place** (`CLAUDE_PLUGIN_ROOT=…/mktsrc/plugins/relayexp`), not from the cache.
- `autoUpdate: true` from a settings source is synced into `known_marketplaces.json` (`"autoUpdate": true`). The
  startup auto-update step ran but logged `Plugin autoupdate: skipped (auto-updater disabled)` because
  `DISABLE_AUTOUPDATER=1` was inherited from this machine's environment — item 3 stays open.

**Implication.** In the headless path the plugin is live only on the **third** session after the settings first appear
(register → cache → load). The interactive post-trust path may collapse steps, but the onboarding note must not promise
"you are in": say *"run `/reload-plugins` (or `/exit` and `claude` again) once the trust dialog is accepted; if
`/relay:doctor` is missing, do it once more"*, and have the M0 demo script verify liveness before continuing. The M0 rig
in §12 should use a **non-bare working clone** if it wants to register through the CLI, or keep the bare `file://` repo
and rely on the settings file (which the CLI cannot write for a `file://` URL).

### 2.2 Item 4 — permission rule form

`--settings '{"permissions":{"allow":["<rule>"]}}'`, default permission mode, no `--allowedTools`:

| rule | result |
|---|---|
| `mcp__plugin_relayexp_relayexp` | tool ran, `permission_denials: []` |
| `mcp__plugin_relayexp_relayexp__*` | tool ran, `permission_denials: []` |
| `mcp__nothing_here` (control) | `permission_denials: [{tool_name: "mcp__plugin_relayexp_relayexp__ping"}]`, result "Claude requested permissions to use mcp__plugin_relayexp_relayexp__ping, but you haven't granted it yet." |

**Implication.** Either form suppresses the prompt; `init-project` can write just the bare server rule
`mcp__plugin_relay_relay` (keep both if paranoid — they do not conflict).

### 2.3 Item 5 — `ask` / `deny` semantics headless, in subagents, under `dontAsk`

- `ask` + `permissionDecisionReason` under `--permission-mode acceptEdits` (`-p`): stream-json shows
  `{"subtype":"permission_denied","tool_name":"Edit","decision_reason_type":"hook","decision_reason":"RELAYEXP_ASK_REASON_555: …"}`;
  the tool result Claude sees is the reason text as an error; the run's `permission_denials[]` lists the call; Claude did
  not retry. `additionalContext` from the same hook output (`RELAYEXP_PRE_EDIT_CTX_444`) was still delivered.
- Same under `--permission-mode dontAsk`, inside a `Task` subagent: stdin carried
  `"permission_mode":"dontAsk","agent_id":"a9f0ebe306947b568","agent_type":"general-purpose"` (same `session_id` as
  the parent); `ask` → denial with the reason as the error text.
- `deny` + reason on `--resume`: denial, reason shown to Claude verbatim (`RELAYEXP_DENY_REASON_901: …`).
- `allow` + `additionalContext`: edit proceeded, context delivered next to the tool result.
- **`permission_mode` in stdin was `acceptEdits`, not `dontAsk`, for the plain headless run** — so §4.0 rule 14's
  downgrade (only on `dontAsk|bypassPermissions|agent_id|RELAY_INTERACTIVE=0`) would have turned Relay's soft `ask`
  into a hard block in `claude -p`. Hook env in `-p` runs carries **`CLAUDE_CODE_ENTRYPOINT=sdk-cli`**.

**Implication.** Add `CLAUDE_CODE_ENTRYPOINT === "sdk-cli"` (and, defensively, any value other than `cli` /
`claude-desktop`) to the `ask → context-only` downgrade list. `agent_id`/`agent_type` are reliable subagent markers.
The reason string is what Claude reads on a denial, so keep it factual (§4.0 rule 15).

### 2.4 Item 6 — async hooks and parallelism

- `PostToolUse` `async: true` on `Bash` (`if: "Bash(git *)"`): its `additionalContext` (`RELAYEXP_ASYNC_POSTGIT_CTX_10`)
  was listed by Claude in the same turn's final answer → async context is delivered on the **next model request**, not
  necessarily the next user turn. Same for async post-edit (`RELAYEXP_ASYNC_POSTEDIT_CTX_9`).
- Async `Stop` context arrives after `result` in `-p` and is therefore lost there (fine: nothing to deliver to).
- 10 runs, every hook `exit_code: 0, outcome: success`; no `hook error` anywhere. Only exceptions: hooks still running
  at `-p` teardown are `cancelled` (see §2.7).
- Three parallel `Read` calls in one assistant message → three `PreToolUse:Read` firings with three distinct
  `tool_use_id`s, none duplicated. (Eight-way parallelism not exercised.)

### 2.5 Item 7 — SessionStart sources, `sessionTitle`, context size

- `source: "startup"` → transcript `customTitle: "Relay exp title"`; debug: `Hook SessionStart (…) provided sessionTitle
  (15 chars)`, `Hook sessionTitle cached`.
- `--resume <id>` → `source: "resume"`, same `session_id`, `customTitle: "Relay resumed title"`.
- `--resume <id> --fork-session` → `source: "fork"`, **new** `session_id` (`cb4a5ef6…` from `b6edd4e1…`),
  `customTitle: "Relay forked title"`; `CLAUDE_ENV_FILE` present again on the fork's SessionStart.
- 5,977-char `additionalContext` → `provided additionalContext (5977 chars)`, full text in the transcript's
  system-reminder, Claude quoted the final token; no file spill.
- SessionStart stdin: `{session_id, transcript_path, cwd, hook_event_name, source}` — **no `permission_mode`, no
  `model`** on 2.1.236 headless runs (model absent as hooks.md warns). SessionEnd stdin: `{…, prompt_id, hook_event_name,
  reason: "other"}` for `-p`.

### 2.6 Items 8, 9, 10 — `if` matcher, task events, env file

- `if: "Bash(git *)"` → fired for the `&&` chain `git add -A && git commit --allow-empty -m x`, not for `pnpm --version`
  (the sibling `Bash` handler without `if` fired for both, proving the matcher path itself was active).
- `TaskCreated` stdin: `{…, prompt_id, hook_event_name:"TaskCreated", task_id:"1", task_subject:"Relay exp task",
  task_description:"…"}`; `TaskCompleted` identical shape. A `TaskCreated` hook's `additionalContext` was delivered.
  Claude reached the Task tools via `ToolSearch select:TaskCreate,TaskUpdate` (deferred tools) — the events still fired.
- `prompt_id` present on UserPromptSubmit, PreToolUse, PostToolUse, TaskCreated/Completed, Stop and SessionEnd.
- `CLAUDE_ENV_FILE` = `~/.claude/session-env/<session_id>/sessionstart-hook-1.sh`; appended `export` lines are visible
  to later Bash tool calls (`printenv` → `fromhook`). Present only on SessionStart in these runs (never on prompt /
  tool / stop / end).
- Bash permission gotcha seen on the way: `echo "$VAR"` under `Bash(echo *)` was denied with `Contains
  simple_expansion` (Claude Code's own rule, not a hook) — demo prompts should use `printenv`.

### 2.7 Item 17 and the SessionEnd budget

- Detached workers spawned from `Stop` and `SessionEnd` (`detached: true, stdio: 'ignore', unref()`) logged `start`
  with `ppid: 1` and `done` 4 s later, after the CLI process had exited (`-p` teardown).
- A `SessionEnd` hook that sleeps 2.5 s is `cancelled` exactly 1.5 s after start (debug:
  `SessionEnd:other [/opt/homebrew/bin/node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.js session-end] cancelled`), and an async
  `Stop` hook still running at teardown is `cancelled` with `exit_code: 1`. Because the worker was spawned *after* the
  sleep, no worker ran.

**Implication.** Confirms §4.9's 600 ms DEADLINE and the rule that `session-end` must fork the detached worker **first**
(before any git/fetch work) — anything after 1.5 s never happens.

### 2.8 Item 16 and process/env facts for `mcp.mjs` and `hook.sh`

- MCP server process: `ppid` = Claude Code PID (15992 / 18781 in two runs) = `CLAUDE_PID` seen by every hook of that
  session. Server env: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE=1`; **no `CLAUDE_PID` and no `CLAUDE_CODE_CHILD_SESSION`** in the server env
  (tool result `CLAUDE_PID: null`). `process.ppid` is therefore the only pid source for `current/<pid>.json` — as §9.1
  says.
- **Claude Code spawned the stdio server twice at startup** (two processes ~200 ms apart, both `ppid` = Claude PID;
  only the second served the tool call; the debug log shows a single "Starting connection"). Both receive **SIGINT** at
  teardown (`Sending SIGINT to MCP server process`), stdin is not closed first. `mcp.mjs` must be idempotent at startup
  (no exclusive locks, no "already running" assumptions) and exit cleanly on SIGINT.
- Hook env (CLI `-p`): `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/relayexp-inline` for
  `--plugin-dir`, `…/relayexp-relaymkt` for a marketplace install), `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli`,
  `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`; `CLAUDE_ENV_FILE` only on
  SessionStart. Server name in logs/`mcp_tool` hooks: `plugin:relayexp:relayexp`. Tool name as seen by Claude and in
  `PreToolUse.tool_name`: **`mcp__plugin_relayexp_relayexp__ping`** (matcher `mcp__plugin_relayexp_relayexp__.*` fired).
- Desktop evidence (not a headless run — the environment of the Claude Code session that ran these experiments, which
  was launched by Claude Desktop): binary `~/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/
  MacOS/claude`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_PID` set, `CLAUDE_CODE_CHILD_SESSION=1`,
  `DISABLE_AUTOUPDATER=1`, and a full login-shell `PATH` (includes `/opt/homebrew/bin` and an nvm node) on this Mac.
  Item 2 proper (SessionEnd on tab close, minimal PATH on other machines) remains untestable here.

### 2.9 Item 13 — placeholders and the version directory

- `${CLAUDE_PLUGIN_ROOT}` substituted in exec-form `args` for hooks and for `.mcp.json` in all three load modes
  (`--plugin-dir`, directory-source marketplace, git-source cache). The `.mcp.json` `env` map also works
  (`RELAYEXP_DIR` reached the server).
- Cache layout for a git/cloned marketplace: `~/.claude/plugins/cache/<marketplace>/<plugin>/<plugin.json version>`
  (`…/relaymkt/relayexp/0.0.1`; the user's `github@claude-plugins-official` sits at `…/github/unknown` because that
  plugin has no version). `installed_plugins.json` records `{scope, installPath, version, gitCommitSha, projectPath?}`.
  Marketplace clone: `~/.claude/plugins/marketplaces/<name>` with the git remote intact (`git -C … rev-parse HEAD` = the
  `gitCommitSha`; `git ls-remote origin HEAD` will work there — item 15 partially answered).

**Implication.** Replace "`basename(CLAUDE_PLUGIN_ROOT)` is the commit SHA" (§3.4, `X-Relay-Plugin`) with: read
`~/.claude/plugins/installed_plugins.json` → `plugins["relay@relay"][*].gitCommitSha` (fallback: `plugin.json`
`version`, i.e. the basename). Bump `plugin.json.version` on every publish or the cache dir name never changes.

### 2.10 Item 11 — `systemMessage`

UserPromptSubmit hook output `{"hookSpecificOutput":{…"additionalContext":"<relay-inbox…>"},"systemMessage":"Relay: 1
impact, 1 note (…)"}` produced, in the stream, a separate `{"type":"system","subtype":"informational","content":
"UserPromptSubmit says: Relay: 1 impact, 1 note (…)","level":"notice"}` event *before* the assistant turn, while
`additionalContext` went into Claude's context (Claude listed `RELAYEXP_INBOX_TOKEN_777`, never the systemMessage token
as its own context item). This is the documented `SDKInformationalMessage`; interactive Claude Code renders these as a
user-visible notice line. **Implication:** the prompt hook can emit `systemMessage` for inbox items as §4.2 proposes;
note the `"<event> says: "` prefix Claude Code prepends.

## 3. Items not covered

- 2 (Desktop lifecycle), 3 (project-scope `autoUpdate` background pull), 12 (status line), 14/15 (GitHub source, SSH),
  18 (Neon): untestable headless or out of scope for this box; §2.1 and §2.9 give partial evidence for 3 and 15.
- Everything above is CLI 2.1.236 only; Desktop 2.1.260 is present on this Mac but was not driven.

## 4. Cleanup performed

`claude plugin uninstall relayexp@relaymkt` (user and project scopes), `claude plugin marketplace remove relaymkt`,
removed `~/.claude/plugins/cache/relaymkt`, `~/.claude/plugins/marketplaces/relaymkt`,
`~/.claude/plugins/data/relayexp-*`. `known_marketplaces.json` and `installed_plugins.json` are back to their previous
entries. Throwaway transcripts remain under `~/.claude/projects/-private-tmp-claude-501-…-scratchpad-exp-repo*/`.

## 5. Real-claude verification of the M0 rig (2026-09-12, CLI 2.1.236 headless, after the build)

The built plugin (`packages/plugin`, marketplace copy under `/tmp/relay-demo/mkt.git`) was driven through
`claude -p --input-format stream-json --output-format stream-json --include-hook-events` in the two demo clones
against the PGlite hub (`scripts/demo.sh up`). Facts that add to or sharpen the items above:

- **Install path, headless.** With the clone's own `.claude/settings.json` passed as `--settings`: session 1
  `[reconcile] … Added marketplace source: relay` (file:// git URL cloned into `~/.claude/plugins/marketplaces/relay`),
  session 2 `Copying source directory ./plugin … Successfully cached plugin relay@relay at
  ~/.claude/plugins/cache/relay/relay/<marketplace version>` + `Added relay@relay with scope project`, session 3
  `Loading hooks from plugin: relay` and `MCP server "plugin:relay:relay": Successfully connected (stdio) in 258ms`.
  The install record in `installed_plugins.json` is **project-scoped** (`projectPath: …/app-priya`): the second clone
  logged `plugin-cache-miss` although the cache directory existed, and needed one `--settings` session of its own
  (record) plus one more (load). Setting `projects[<dir>].hasTrustDialogAccepted: true` in `~/.claude.json` makes the
  project `permissions.allow` and `env` apply (the CLI's own stderr suggests it) but does **not** run the headless
  installer for `extraKnownMarketplaces`/`enabledPlugins` — only `--settings` did. Whether the interactive trust dialog
  collapses register/cache/load into one session is still unobserved.
- **Every hook fired as designed** (SessionStart digest 699–1,600 chars inline, UserPromptSubmit `<relay-inbox>` +
  `systemMessage` → stream `informational` event, PreToolUse Edit `additionalContext`, async PostToolUse edit/git,
  Stop `turn_end`, SessionEnd → detached worker → handoff on the hub within 1 s). Timings from `log/stats.jsonl`:
  session-start p50 197 / max 426 ms, prompt p50 8 ms, pre-edit p50 6 / max 26 ms, post-edit ≤ 141 ms, post-git
  ≤ 132 ms, stop ≤ 172 ms, session-end ≤ 13 ms.
- **`NODE_USE_SYSTEM_CA=1` + Node 24.7.0 = SIGSEGV on `process.exit()`.** Claude Code exports that variable to hook and
  MCP processes. Node 24.7 then reads the macOS keychain on a background thread at startup
  (`node::crypto::ReadMacOSKeychainCertificates` → `X509_get_subject_name` on a null cert, crash report in
  `~/Library/Logs/DiagnosticReports/node-*.ips`) and an early `process.exit()` crashes the process: 8/40 direct
  `pre-edit` runs, 1/40 `node -e 'process.exit(0)'`, 0/40 with the variable unset, 0/40 on Node 22.19. Claude Code
  reports it as `hook_response … exit_code: 1, outcome: "error"` (stdout JSON is still honoured). `hook.sh` and
  `mcp.sh` now `unset NODE_USE_SYSTEM_CA` before resolving Node.
- **`ask` in `-p`.** The collision verdict was HOT and the hook logged `HOT -> context (non-interactive)`: the
  entrypoint is `sdk-cli` and neither `--settings '{"env":{"CLAUDE_CODE_ENTRYPOINT":"cli"}}'` nor the variable in the
  parent environment changes what hooks see (Claude Code sets it itself; the billing header still said
  `cc_entrypoint=sdk-cli`). The prompt UI therefore stays interactive-only.
- **Stop hook lifetime.** In a one-shot `-p` run the async Stop hook is cancelled ~200 ms after registration (teardown);
  in a `--input-format stream-json` session that stays open it completes (`stop: POST /v1/events (turn_end) ok`).
- **Claude Code's own cross-session tools.** Without Relay loaded, arjun's Claude used `ListAgents` + `SendMessage`
  (peer sessions on this Mac) to interrogate priya's session directly and polluted it; the verification runs used
  `--disallowedTools ListAgents SendMessage`. With Relay loaded Claude preferred the Relay tools on its own.
- **Demo script.** With priya's commit unpushed, "rename status to orderStatus" makes arjun's Claude read the file,
  find no `status`, and decline before any Edit — the pre-edit hook never runs. The script now says
  "Commit and push" (A) and "Pull, then rename …" (B).
