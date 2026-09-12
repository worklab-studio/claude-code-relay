# Claude Code Hooks: Exact Contract (research notes)

Extracted 2026-09-12 from the live docs:

- Reference: https://code.claude.com/docs/en/hooks (raw: https://code.claude.com/docs/en/hooks.md)
- Guide: https://code.claude.com/docs/en/hooks-guide (raw: https://code.claude.com/docs/en/hooks-guide.md)
- Cross-checked: https://code.claude.com/docs/en/env-vars.md, https://code.claude.com/docs/en/plugins-reference.md, https://code.claude.com/docs/en/settings-reference.md

Version notes in the docs reference Claude Code v2.1.x (up to v2.1.267). Where a behavior is version-gated the version is noted inline.

---

## 1. Complete event list (35 events)

Cadence summary from the reference: per session = `SessionStart`, `SessionEnd`; per turn = `UserPromptSubmit`, `Stop`, `StopFailure`; per tool call inside the agentic loop = `PreToolUse`, `PostToolUse` (except `EndConversation` calls, which fire neither).

| Event | Fires when | Matcher filters on | Can block? |
|---|---|---|---|
| `SessionStart` | session begins or resumes (`startup`, `resume`, `clear`, `compact`, `fork`) | source | No (context only) |
| `Setup` | `claude --init-only`, or `-p --init` / `-p --maintenance` | `init`, `maintenance` | No (all output discarded) |
| `UserPromptSubmit` | user submits a prompt, before Claude processes it | none | Yes |
| `UserPromptExpansion` | a typed `/command` (skill/custom cmd/MCP prompt) expands into a prompt | command name | Yes |
| `PreToolUse` | before a tool call executes | tool name | Yes (allow/deny/ask/defer) |
| `PermissionRequest` | Claude Code is about to ask the user for permission | tool name | via `decision` object only (exit 2 ignored) |
| `PermissionDenied` | auto mode denies a tool call | tool name | No (`retry: true` only) |
| `PostToolUse` | after a tool call succeeds | tool name | No (feedback / rewrite output) |
| `PostToolUseFailure` | after a tool call that started fails | tool name | No (context only) |
| `PostToolBatch` | once after a whole batch of parallel tool calls resolves, before next model call | none | Yes (stops loop) |
| `Notification` | Claude Code sends a notification | notification type | No |
| `MessageDisplay` | while assistant message text streams (display-only rewrite) | none | No |
| `SubagentStart` | subagent spawned / resumed / teammate handles new message | agent type | No (context only) |
| `SubagentStop` | subagent finishes | agent type | Yes |
| `TaskCreated` | `TaskCreate` tool creates a task | none | Yes (rolls back) |
| `TaskCompleted` | task marked completed via `TaskUpdate`, or teammate finishes turn with in-progress tasks | none | Yes |
| `Stop` | main agent finishes responding (not on user interrupt) | none | Yes |
| `StopFailure` | turn ends due to API error | error type | No (all output ignored except `terminalSequence`) |
| `TeammateIdle` | agent-team teammate about to go idle | none | Yes |
| `InstructionsLoaded` | CLAUDE.md / `.claude/rules/*.md` loaded (eager or lazy) | load reason | No (async, observability) |
| `ConfigChange` | settings/managed/skill file changes mid-session | config source | Yes (except `policy_settings`) |
| `CwdChanged` | working dir changes (e.g. `cd`) | none | No |
| `DirectoryAdded` | `/add-dir` or SDK `register_repo_root` | `slash_command`, `register_repo_root` | No (already added, runs in background) |
| `FileChanged` | a watched file changes on disk (fs watcher, any writer) | literal filenames (builds watch list) | No |
| `WorktreeCreate` | worktree being created (`--worktree`, `isolation: "worktree"`, background session). Replaces git behavior | none | Yes (any non-zero exit fails creation) |
| `WorktreeRemove` | worktree being removed | none | Yes (non-zero exit fails removal if dir still exists) |
| `PreCompact` | before compaction | `manual`, `auto` | Yes |
| `PostCompact` | after compaction | `manual`, `auto` | No |
| `PreModelSwitch` | before a user/client-requested model switch (v2.1.251+) | canonical target model name | Yes (allow/deny/ask) |
| `PostModelSwitch` | after the session's model changes, incl. automatic (v2.1.251+) | canonical target model name | No (context only) |
| `Elicitation` | MCP server requests user input | MCP server name | Yes (accept/decline/cancel) |
| `ElicitationResult` | after user responds to MCP elicitation, before it's sent back | MCP server name | Yes (override/decline) |
| `SessionEnd` | session terminates | reason | No |

Events with **no matcher support** (matcher silently ignored): `UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `MessageDisplay`.

### Which hook types each event supports

- All five types (`command`, `http`, `mcp_tool`, `prompt`, `agent`): `PermissionDenied`, `PermissionRequest`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`, `PreToolUse`, `Stop`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`, `UserPromptSubmit`.
- `command` + `http` + `mcp_tool` only (no `prompt`/`agent`): `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `Elicitation`, `ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `MessageDisplay`, `Notification`, `PostCompact`, `PostModelSwitch`, `PreCompact`, `PreModelSwitch`, `SessionEnd`, `StopFailure`, `SubagentStart`, `WorktreeCreate`, `WorktreeRemove`.
- `command` + `mcp_tool` only: `SessionStart`, `Setup`. (`mcp_tool` on `SessionStart` is SKIPPED at launch because MCP servers aren't available yet; it runs on `/clear`/compact re-fires. `Setup` always skips `mcp_tool`. No `http`, `prompt`, `agent` on these two.)

---

## 2. Configuration schema

Three levels of nesting: event -> matcher group -> handler list.

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<pattern or omitted>",
        "hooks": [
          { "type": "command", "command": "...", "args": [], "timeout": 60, "if": "Bash(git *)", "async": false, "statusMessage": "...", "once": false, "shell": "bash" }
        ]
      }
    ]
  }
}
```

### 2.1 Hook locations and scope

| Location | Scope | Shareable |
|---|---|---|
| `~/.claude/settings.json` | all your projects | no |
| `.claude/settings.json` | single project | yes (commit to repo) |
| `.claude/settings.local.json` | single project | no (gitignored) |
| Managed policy settings (`managed-settings.json`, `managed-settings.d/`) | org-wide | admin-controlled |
| Plugin `hooks/hooks.json` (or inline in `plugin.json`) | while plugin enabled | bundled with plugin |
| Skill frontmatter `hooks:` | rest of session once skill invoked | yes |
| Subagent frontmatter `hooks:` | only while that subagent runs | yes |

Merge rules:
- Hook entries **merge across settings levels** (user + project + local + managed all add; nothing replaces). `disableAllHooks` outside managed settings can't disable managed hooks.
- All matching hooks run **in parallel**. If the identical handler is defined in more than one settings file it runs **once**; a plugin's or skill's copy of the same handler stays separate (runs additionally).
- Plugin hooks: "When a plugin is enabled, its hooks merge with your user and project hooks." Plugin `hooks/hooks.json` may have a top-level `description` field.
- `allowManagedHooksOnly: true` (managed only): blocks user/project/local/plugin hooks (except plugins force-enabled via managed `enabledPlugins`); also narrows statusLine/fileSuggestion/subagentStatusLine.
- `allowedHttpHookUrls` (any level, merged): HTTP hook runs only if its URL matches. `httpHookAllowedEnvVars`: only listed env vars get interpolated into HTTP headers.
- Cloud sessions (Claude Code on the web) don't read local `~/.claude/settings.json`; hooks come from repo + server-managed settings.
- Settings-file hooks also run inside subagents (tool events fire the same hooks; input carries `agent_id`/`agent_type`).
- Skill frontmatter hooks: registered when skill is invoked; persist for rest of session; `once: true` removes after first successful run. Subagent frontmatter hooks: `Stop` is converted to `SubagentStop`.
- Workspace trust: interactive sessions hold back ALL settings-file hooks (even `~/.claude/settings.json`) until the trust dialog is accepted. `-p`/SDK sessions treat the folder as trusted and RUN repo `.claude/settings.json` hooks. Project subagent frontmatter hooks require trust accepted (v2.1.218+).
- Disable: `"disableAllHooks": true` (value after settings precedence; project can override user). One-run override: `claude --settings '{"disableAllHooks": true}'`. No way to disable a single hook. `--safe-mode` / `CLAUDE_CODE_SAFE_MODE=1` also disables hooks. File-watcher picks up settings edits automatically.
- `/hooks` menu is read-only; shows source labels `User Settings`, `Project Settings`, `Local Settings`, `Plugin Hooks`, `Session Hooks`.

### 2.2 Matcher syntax

| Matcher value | Evaluated as |
|---|---|
| `"*"`, `""`, or omitted | match all |
| only letters, digits, `_`, `-`, spaces, `,`, `\|` | exact string, or list of exact strings separated by `\|` or `,` (whitespace tolerated). `Bash`; `Edit\|Write`; `Edit, Write`; `code-reviewer` |
| any other character | JavaScript regex, **unanchored** (`RegExp.prototype.test`). `^Notebook`; `mcp__memory__.*`; `Edit.*` matches `NotebookEdit` too, so use `^Edit$` for whole-string |

- Comma separators need v2.1.191+. Hyphens in the exact-match set need v2.1.195+ (earlier: `code-reviewer` is an unanchored regex).
- `FileChanged` and `StopFailure` use a narrower exact set (letters, digits, `_`, `|` only); hyphen/space/comma push to regex path.
- Matchers are case-sensitive.
- Matcher on an event without matcher support is silently ignored.

**MCP tool matching.** MCP tools are named `mcp__<server>__<tool>`. Examples: `mcp__memory__create_entities`, `mcp__github__search_repositories`.
- All tools from a server: `mcp__memory__.*` (the `.*` is REQUIRED: `mcp__memory` alone is exact-match and matches nothing).
- Hyphenated server: `mcp__brave-search__.*`.
- Cross-server: `mcp__.*__write.*`.
- Plugin-bundled MCP server tools are scoped: `mcp__plugin_<plugin-name>_<server-name>__<tool>` (e.g. `mcp__plugin_my-plugin_db__query`; matcher `mcp__plugin_my-plugin_db__.*`). A matcher on the bare server key never fires for them.
- MCP tools appear in `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`.

Per-event matcher values:
- Tool events: tool name (`Bash`, `PowerShell`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `Agent`, `Workflow`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`, MCP names). Never `EndConversation`.
- `SessionStart`: `startup`, `resume`, `clear`, `compact`, `fork`
- `Setup`: `init`, `maintenance`
- `SessionEnd`: `clear`, `resume`, `logout`, `prompt_input_exit`, `other` (`bypass_permissions_disabled` removed in v2.1.234)
- `Notification`: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`
- `SubagentStart`/`SubagentStop`: `general-purpose`, `Explore`, `Plan`, custom agent `name` (frontmatter, not filename), plugin-scoped `^my-plugin:reviewer$` (colon forces regex path; anchor it)
- `PreCompact`/`PostCompact`: `manual`, `auto`
- `PreModelSwitch`/`PostModelSwitch`: canonical model name (`claude-opus-5`, `claude-opus-4-6|claude-opus-5`, `.*opus.*`); `[1m]` suffix ignored; if canonical name can't be determined, every hook runs regardless of matcher
- `ConfigChange`: `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`
- `DirectoryAdded`: `slash_command`, `register_repo_root`
- `FileChanged`: literal filenames split on `|` (`.envrc|.env`), registered in the working directory; also filters hook groups against changed file's basename
- `StopFailure`: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error` (v2.1.267+), `unknown`
- `InstructionsLoaded`: `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`
- `UserPromptExpansion`: command/skill name
- `Elicitation`/`ElicitationResult`: MCP server name

### 2.3 The `if` field (per-handler, tool events only)

- Permission-rule syntax: `"Bash(git *)"`, `"Edit(*.ts)"`, `"Edit(src/**)"` (single-segment dir pattern matches only `src` under cwd since v2.1.214; use `"Edit(**/src/**)"` for any depth).
- Exactly ONE rule; no `&&`/`||`/lists. Use multiple handlers for multiple conditions.
- Only evaluated on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`. **On any other event a handler with `if` set never runs.**
- Bash matching: leading `VAR=value` stripped; each `&&`-chained subcommand checked; commands inside `$()` and backticks checked; if Claude Code can't determine the command (`$TOOL git push`, or pattern more specific than the command name with `$()`/backticks/`$VAR` present) it runs the hook anyway. Best-effort: use permission rules, not `if`, for hard enforcement.

### 2.4 Common handler fields (all types)

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, `"agent"` |
| `if` | no | see above |
| `timeout` | no | seconds. Defaults: **600** for `command`/`http`/`mcp_tool`; **30** for `prompt`; **60** for `agent`. Lowered to **30** for `command`/`http`/`mcp_tool` on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`; to **10** on `MessageDisplay`. `SessionEnd` hooks share a **1.5 s budget**, raised to the highest per-hook `timeout` in settings files up to 60 s (plugin timeouts don't raise it); override with `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. Not enforced on `async: true` command hooks (still enforced on `asyncRewake`). |
| `statusMessage` | no | custom spinner text while hook runs |
| `once` | no | remove hook after first **successful** run (failure/exit 2/timeout leaves it in place). **Only honored in skill frontmatter**; ignored in settings files and agent frontmatter. |

### 2.5 Command hook fields

| Field | Notes |
|---|---|
| `command` (req) | shell command (shell form) or executable (exec form when `args` present) |
| `args` | when present -> **exec form**: `command` resolved on PATH, spawned directly, no shell, each arg passed verbatim; placeholders substituted as plain strings into `command` and each arg. `"args": []` is the idiom to force exec form. |
| `async` | `true` -> background, non-blocking; decision fields have no effect |
| `asyncRewake` | `true` -> background AND wakes Claude on exit 2 (stderr, or stdout if stderr empty, shown as system reminder). Timeout still enforced. |
| `shell` | `"bash"` (default) or `"powershell"`; ignored when `args` set |

Shell form: `sh -c` on macOS/Linux, Git Bash on Windows, PowerShell if no Git Bash. Shell profile output can corrupt JSON stdout (see gotchas). Windows exec form needs a real `.exe` (not `.cmd`/`.bat` shims; use `"command": "node", "args": [".../eslint.js"]`).

Plugin hooks: `${user_config.*}` substituted in **exec form only**; shell-form reference errors. Use `$CLAUDE_PLUGIN_OPTION_<KEY>` env var from shell form.

### 2.6 HTTP hook fields

| Field | Notes |
|---|---|
| `url` (req) | POST target |
| `headers` | key/value; values support `$VAR` / `${VAR}` interpolation, only for names in `allowedEnvVars` (unlisted -> empty string) |
| `allowedEnvVars` | list of env var names permitted for interpolation |

Body: the hook's JSON input, `Content-Type: application/json`. Response body: same JSON output schema as command hooks.

HTTP response handling: 2xx + empty body = success/no-op; 2xx + JSON object = parsed as JSON output (schema failure = non-blocking error); 2xx + non-JSON body = non-blocking error (text NOT added to context); non-2xx = non-blocking error; connection failure = non-blocking error; timeout = canceled. **HTTP hooks cannot block via status codes; must return 2xx with decision JSON.** Subject to `allowedHttpHookUrls` allowlist.

### 2.7 MCP tool hook fields

| Field | Notes |
|---|---|
| `server` (req) | configured MCP server name; plugin-bundled: `plugin:<plugin-name>:<server-name>`. Must already be connected; never triggers OAuth/connect. |
| `tool` (req) | tool name |
| `input` | args; string values support `${path}` substitution from hook input, e.g. `"${tool_input.file_path}"` |

Tool text content treated like command stdout (same parsing rule). Server not connected or `isError: true` -> non-blocking error.

### 2.8 Prompt / agent hook fields

| Field | Notes |
|---|---|
| `prompt` (req) | `$ARGUMENTS` = hook input JSON placeholder (appended if absent). Escape `\$` for literal. |
| `model` | defaults to a fast model (Haiku) |
| `timeout` | prompt 30 s, agent 60 s |
| `continueOnBlock` | prompt hooks only; default `false` |

Response schema the model must return: `{"ok": true|false, "reason": "...", "impossible": true|false}`. `reason` required when `ok:false`. `impossible` (prompt hooks only) lets `Stop`/`SubagentStop` end the turn instead of feeding reason back.

`ok:false` behavior by event: `Stop`/`SubagentStop` -> reason fed back, turn continues (unless `impossible`); `PreToolUse` -> denied; by default turn ENDS with warning line (v2.1.210+), `continueOnBlock:true` returns reason to Claude as tool error and continues; `PostToolUse` -> turn ends by default, `continueOnBlock:true` feeds back and continues; `PostToolBatch`/`UserPromptSubmit`/`UserPromptExpansion` -> turn ends; `PostToolUseFailure`/`TaskCreated` -> reason returned as tool error, continues; `TaskCompleted` -> tool error + continue (TaskUpdate) or halts teammate (teammate stop); `TeammateIdle` -> teammate stops by default, `continueOnBlock:true` keeps working; `PermissionRequest` and `PermissionDenied` -> `ok:false` has NO effect (use command hooks).

Agent hooks (experimental): subagent with Read/Grep/Glob, up to 50 turns, returns `{ok}`; `ok:false` handled like prompt hook with `continueOnBlock:true`; no `continueOnBlock` or `impossible` fields.

### 2.9 Path placeholders

- `${CLAUDE_PROJECT_DIR}`: project root where session started. **Stays put when Claude enters a worktree**; use input `cwd` to follow Claude.
- `${CLAUDE_PLUGIN_ROOT}`: plugin install dir (changes on each update).
- `${CLAUDE_PLUGIN_DATA}`: plugin persistent data dir (`~/.claude/plugins/data/{id}/`).
- All three are also exported as env vars to the spawned process in both forms. Prefer exec form; in shell form wrap in double quotes. PowerShell shell form: `${CLAUDE_PROJECT_DIR}` rewritten to `${env:NAME}` (v2.1.198+) or write `$env:CLAUDE_PROJECT_DIR`; never bare `$CLAUDE_PROJECT_DIR` in PowerShell.

---

## 3. Environment variables available to hook processes

Hook processes inherit the parent environment (minus `OTEL_*` exporter vars, and minus credentials when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`). Set by Claude Code:

| Var | Meaning |
|---|---|
| `CLAUDE_PROJECT_DIR` | project root (see above) |
| `CLAUDE_PLUGIN_ROOT` | plugin install dir (plugin hooks) |
| `CLAUDE_PLUGIN_DATA` | plugin persistent dir |
| `CLAUDE_PLUGIN_OPTION_<KEY>` | plugin user_config values (uppercased key) |
| `CLAUDE_ENV_FILE` | path to a shell script Claude Code sources before each Bash command. **Only present for `SessionStart`, `Setup`, `CwdChanged`, `FileChanged`.** Append `export ...` lines (`>>`). CwdChanged/FileChanged writes persist until the next `CwdChanged` clears them. |
| `CLAUDE_CODE_SESSION_ID` | current session id (matches `session_id`; updated on `/clear`) |
| `CLAUDE_EFFORT` | `low`/`medium`/`high`/`xhigh`/`max` (matches `effort.level`) |
| `CLAUDECODE` | `1` in every subprocess Claude Code spawns |
| `CLAUDE_CODE_CHILD_SESSION` | `1` for Bash/PowerShell/Monitor/hook/statusline subprocesses (not stdio MCP) |
| `CLAUDE_PID` | Claude Code's own PID |
| `CLAUDE_CODE_REMOTE` | `"true"` in cloud/web sessions; unset locally |
| `CLAUDE_CODE_BRIDGE_SESSION_ID` | Remote Control session id while connected (v2.1.199+) |
| `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` | inbox socket path/token when cross-session messaging is on |
| `TRACEPARENT` | when trace propagation is enabled |

There is NO `$CLAUDE_MODEL`. Model comes only via `SessionStart.model` (sometimes omitted) and `PreModelSwitch`/`PostModelSwitch` `from_model`/`to_model`.

User-settable knobs affecting hooks: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8; `0` disables), `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS=1`, `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`, `CLAUDE_CODE_SHELL_PREFIX` (wraps shell-form hooks), `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `CLAUDE_CODE_SAFE_MODE=1` / `CLAUDE_CODE_SIMPLE=1` (disable hooks), `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY=1`.

Hooks run with no controlling terminal (`/dev/tty` unavailable); use `terminalSequence` for bells/notifications.

---

## 4. Input contract (stdin JSON / HTTP POST body)

### 4.1 Common input fields

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "scratchpad_dir": "/tmp/claude-1000/-home-user-my-project/abc123/scratchpad",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PreToolUse",
  "agent_id": "…",
  "agent_type": "…"
}
```

- `session_id`: always.
- `prompt_id`: UUID of current user prompt (v2.1.196+); absent until first user input; matches OTel `prompt.id`.
- `transcript_path`: JSONL path; written asynchronously, may lag. Use `last_assistant_message` on Stop/SubagentStop instead of parsing it.
- `cwd`: current working dir (follows `cd` and worktrees).
- `scratchpad_dir`: v2.1.257+; may be absent.
- `permission_mode`: `"default"` (Manual arrives as `default`), `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`. Not on every event (check per-event example).
- `effort.level`: present on tool-context events (PreToolUse, PostToolUse, Stop, SubagentStop) when model supports it.
- `hook_event_name`: always.
- `agent_id` (only inside a subagent), `agent_type` (with `--agent` or inside subagent; subagent type wins).
- `model`: only `SessionStart`, and not always.

### 4.2 Per-event input fields

**SessionStart**: `source` (`startup|resume|clear|compact|fork`), optional `model`, `agent_type`, `session_title`. On `resume`/`fork` with at least one Claude response (v2.1.251+): `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`.

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "hook_event_name": "SessionStart", "source": "resume", "model": "claude-opus-5", "seconds_since_last_response": 5400, "context_tokens": 182340, "prompt_cache_likely_expired": true, "estimated_cache_write_usd": 1.1396 }
```

**Setup**: `trigger` (`"init"` | `"maintenance"`).

**UserPromptSubmit**: `prompt` (submitted text). Includes `permission_mode`.

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "permission_mode": "default", "hook_event_name": "UserPromptSubmit", "prompt": "Write a function to calculate the factorial of a number" }
```

**UserPromptExpansion**: `expansion_type` (`slash_command` | `mcp_prompt`), `command_name`, `command_args`, `command_source`, `prompt`.

**PreToolUse**: `tool_name`, `tool_input`, `tool_use_id`. File tools' `file_path` always absolute (`~`/relative expanded; Windows backslashes).

```json
{ "session_id": "abc123", "prompt_id": "…", "transcript_path": "…", "cwd": "…", "scratchpad_dir": "…", "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "npm test", "description": "Run test suite", "timeout": 120000, "run_in_background": false }, "tool_use_id": "toolu_01ABC123..." }
```

`tool_input` shapes: Bash/PowerShell `{command, description?, timeout?, run_in_background?}`; Write `{file_path, content}`; Edit `{file_path, old_string, new_string, replace_all?}`; Read `{file_path, offset?, limit?}`; Glob `{pattern, path?}`; Grep `{pattern, path?, glob?, output_mode?, -i?, multiline?}`; WebFetch `{url, prompt}`; WebSearch `{query, allowed_domains?, blocked_domains?}`; Agent `{prompt, description, subagent_type, model?}`; AskUserQuestion `{questions:[{question, header, options:[{label}], multiSelect}], answers?}`; ExitPlanMode `{plan, planFilePath, allowedPrompts(deprecated)}` (injected by Claude Code).

**PermissionRequest**: `tool_name`, `tool_input` (NO `tool_use_id`), optional `permission_suggestions[]` (permission update entries).

**PostToolUse**: `tool_name`, `tool_input`, `tool_response` (tool's structured Output object, e.g. Write -> `{filePath, type:"create"}`; Bash -> `{stdout, stderr, interrupted, isImage}`; Agent -> `{status, agentId, content[], resolvedModel, modelsUsed?, totalTokens, totalDurationMs, totalToolUseCount, usage}` or `{status:"async_launched", agentId, description, prompt, outputFile, resolvedModel}`; ExitPlanMode -> `{plan, filePath, ...}`), `tool_use_id`, optional `duration_ms`.

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "permission_mode": "default", "hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": { "file_path": "/path/to/file.txt", "content": "file content" }, "tool_response": { "filePath": "/path/to/file.txt", "type": "create" }, "tool_use_id": "toolu_01ABC123...", "duration_ms": 12 }
```

**PostToolUseFailure**: `tool_name`, `tool_input`, `tool_use_id`, `error` (string; Bash first line `Exit code N`), optional `is_interrupt`, optional `duration_ms`. Doesn't fire for validation rejections or permission denials.

**PostToolBatch**: `tool_calls[]` of `{tool_name, tool_input, tool_use_id, tool_response}` where `tool_response` is the serialized `tool_result` content the model sees (string or content-block array), NOT the structured object.

**PermissionDenied**: `tool_name`, `tool_input`, `tool_use_id`, `reason` (e.g. `"[Irreversible Local Destruction]"`, or starts with `Auto mode could not evaluate…`, or `Classifier unavailable`). `permission_mode` is `"auto"`. Only fires in auto mode.

**Notification**: `message`, optional `title`, `notification_type`.

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "hook_event_name": "Notification", "message": "Claude needs your permission", "title": "Permission needed", "notification_type": "permission_prompt" }
```

Timing: `permission_prompt` fires only after prompt has waited ~6 s without typing; `idle_prompt` ~60 s after response; in SDK/`canUseTool` hosts (Desktop, VS Code) `permission_prompt` fires ~6 s after ask regardless of typing (v2.1.233+). For an immediate signal use `PermissionRequest`.

**MessageDisplay**: `turn_id`, `message_id`, `index`, `final`, `delta`. In `-p`/SDK: one call per message with full text, `index:0`, `final:true`.

**SubagentStart**: `agent_id`, `agent_type`.

**SubagentStop**: `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path` (subagent's own transcript under `subagents/`), `last_assistant_message`, `background_tasks[]`, `session_crons[]` (both scoped to parent session).

```json
{ "session_id": "abc123", "transcript_path": "~/.claude/projects/.../abc123.jsonl", "cwd": "…", "permission_mode": "default", "hook_event_name": "SubagentStop", "stop_hook_active": false, "agent_id": "def456", "agent_type": "Explore", "agent_transcript_path": "~/.claude/projects/.../abc123/subagents/agent-def456.jsonl", "last_assistant_message": "Analysis complete. Found 3 potential issues...", "background_tasks": [], "session_crons": [] }
```

**TaskCreated / TaskCompleted**: `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name` (deprecated).

**Stop**: `stop_hook_active` (true when already continuing because of a stop hook; cap = 8 consecutive blocks), `last_assistant_message`, `background_tasks[]` (`{id, type, status, description, command?, agent_type?, server?, tool?, name?}`), `session_crons[]` (`{id, schedule, recurring, prompt}`).

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "permission_mode": "default", "hook_event_name": "Stop", "stop_hook_active": true, "last_assistant_message": "I've completed the refactoring. Here's a summary...", "background_tasks": [ { "id": "task-001", "type": "shell", "status": "running", "description": "tail logs", "command": "tail -f /var/log/syslog" } ], "session_crons": [ { "id": "cron-001", "schedule": "0 9 * * 1-5", "recurring": true, "prompt": "check the build" } ] }
```

**StopFailure**: `error` (type), optional `error_details`, optional `last_assistant_message` (the API error string).

**TeammateIdle**: `teammate_name`, `team_name`.

**ConfigChange**: `source`, optional `file_path`.

**CwdChanged**: `old_cwd`, `new_cwd`.

**DirectoryAdded**: `directory`, `source`.

**FileChanged**: `file_path`, `event` (`change|add|unlink`).

**WorktreeCreate**: `name` (slug, e.g. `bold-oak-a3f2`).

**WorktreeRemove**: `worktree_path`.

**PreCompact**: `trigger` (`manual|auto`), `custom_instructions` (string for manual `/compact <text>`, else `null`).

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "hook_event_name": "PreCompact", "trigger": "manual", "custom_instructions": null }
```

**PostCompact**: `trigger`, `compact_summary`.

**PreModelSwitch**: `from_model`, `to_model`, `requested_model` (alias/ID/`null`), `source` (`command|picker|sdk`), `context_tokens`, `prompt_cache_warm`, `cache_ttl` (`5m|1h`), `estimated_cache_write_usd`, `pricing` (`configured|catalog|default`).

**PostModelSwitch**: same as PreModelSwitch plus `source` values `auto` and `resume`.

**SessionEnd**: `reason` (`clear|resume|logout|prompt_input_exit|other`).

```json
{ "session_id": "abc123", "transcript_path": "…", "cwd": "…", "hook_event_name": "SessionEnd", "reason": "other" }
```

**Elicitation**: `mcp_server_name`, `message`, optional `mode` (`form|url`), `url`, `elicitation_id`, `requested_schema`.

**ElicitationResult**: `mcp_server_name`, `action`, optional `mode`, `elicitation_id`, `content`.

---

## 5. Output contract

### 5.1 Exit codes (command hooks)

- **Exit 0**: success. Stdout parsed per the rule below. For `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch`, plain-text stdout is ADDED to Claude's context; for all other events plain stdout goes to the debug log only. **Stderr on exit 0 goes to debug log only; Claude never sees it.** Exit 0 with no output on `PreToolUse` = no decision (normal permission flow; silence does NOT approve).
- **Exit 2**: blocking error on blockable events (see table). Blocks even if JSON says `allow`. Blocking message = the JSON blocking decision's reason if present, else **stderr**. JSON output is still read (except `hookSpecificOutput` is ignored on `Elicitation`/`ElicitationResult`). Exit 2 + schema-invalid JSON still blocks using stderr (v2.1.214+).
- **Any other exit code (e.g. 1)**: does NOT block on its own for most events.
  - If stdout is a valid, schema-passing JSON object: exit code ignored, JSON alone decides (all supported fields honored, no error shown).
  - If JSON fails schema validation or looks like JSON but doesn't parse: non-blocking error, action proceeds, transcript shows `<hook name> hook error` with the message (v2.1.248+ for parse failures; previously treated as plain text).
  - If plain text / empty stdout: non-blocking error, action proceeds, transcript shows `<hook name> hook error` + `Failed with non-blocking status code: <first stderr line>`.
  - A script that can't start (127) lands here too: a mistyped path leaves a policy gate silently disabled.
  - Exceptions: `WorktreeCreate` fails on ANY non-zero; `WorktreeRemove` fails on non-zero if dir still exists; `StopFailure` ignores everything except `terminalSequence`.

Stdout parsing rule (surrounding whitespace ignored): starts with `{` and ends with `}` -> parsed as JSON (multi-line where each line is its own JSON and none sets a field -> plain text; if one line sets a field -> parse failure). Starts with `{` but doesn't end with `}` -> plain text. Anything else (array, quoted string) -> plain text.

Output strings (`additionalContext`, `systemMessage`, plain stdout) capped at **10,000 chars**; excess saved to a file and replaced with preview + path.

### 5.2 Exit code 2 behavior per event

| Event | Can block? | Effect of exit 2 |
|---|---|---|
| PreToolUse | Yes | blocks tool call; stderr shown to Claude as denial reason |
| PermissionRequest | No | exit 2 not honored; use `decision` object; stderr discarded |
| UserPromptSubmit | Yes | blocks prompt processing and erases the prompt; stderr shown to user (not context) |
| UserPromptExpansion | Yes | blocks expansion; stderr to user |
| Stop | Yes | prevents stopping; stderr fed to Claude as reason to continue |
| SubagentStop | Yes | prevents subagent stopping; stderr as next instruction |
| TeammateIdle | Yes | teammate keeps working; stderr as feedback |
| TaskCreated | Yes | rolls back task; stderr returned to Claude as tool error |
| TaskCompleted | Yes | task not completed; stderr fed to model |
| ConfigChange | Yes | blocks change (except `policy_settings`); no message shown anywhere |
| StopFailure | No | everything ignored except `terminalSequence` |
| PostToolUse | No | stderr shown to Claude (tool already ran) |
| PostToolUseFailure | No | stderr shown to Claude |
| PostToolBatch | Yes | stops agentic loop before next model call |
| PermissionDenied | No | exit code and stderr ignored |
| Notification | No | ignored |
| SubagentStart | No | stderr to user only (subagent's transcript) |
| SessionStart | No | stderr to user only (rendered as hook error notice; Claude doesn't see it) |
| Setup | No | ignored |
| SessionEnd | No | stderr to user only |
| CwdChanged | No | stderr to user only |
| DirectoryAdded | No | stderr to debug log |
| FileChanged | No | stderr to user only |
| PreCompact | Yes | blocks compaction; stderr shown to user for manual `/compact` |
| PostCompact | No | stderr to user only |
| PreModelSwitch | Yes | blocks switch; stderr to user |
| PostModelSwitch | No | stderr to user only |
| Elicitation | Yes | denies elicitation; stderr not shown anywhere |
| ElicitationResult | Yes | action becomes `decline`; stderr not shown |
| WorktreeCreate | Yes | ANY non-zero fails creation |
| WorktreeRemove | Yes | ANY non-zero fails removal if dir still exists |
| InstructionsLoaded | No | ignored |
| MessageDisplay | No | original text displayed |

### 5.3 Timeouts

A `command`/`http`/`mcp_tool` hook reaching `timeout` is canceled and its output discarded -> no decision on most events. **On `PreToolUse` a timed-out command hook does NOT block** (tool proceeds through normal permission flow). Exception: `PreModelSwitch` timeout BLOCKS the switch. Agent SDK callback hooks that time out DO block (PreToolUse, UserPromptSubmit). `UserPromptSubmit` timeout -> prompt still reaches Claude without the context, with a transcript notice.

### 5.4 JSON output (stdout / HTTP body): universal fields

```json
{
  "continue": true,
  "stopReason": "…",
  "suppressOutput": false,
  "systemMessage": "…",
  "terminalSequence": "…",
  "decision": "block",
  "reason": "…",
  "hookSpecificOutput": { "hookEventName": "<Event>", "…": "…" }
}
```

| Field | Default | Semantics |
|---|---|---|
| `continue` | `true` | `false` = Claude stops processing entirely after the hook; takes precedence over any event-specific decision. For Pre/PostToolUse applies even if the tool fails or completes mid-stream. Discarded on many events (Setup, InstructionsLoaded, MessageDisplay, Notification, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate/Remove, PreCompact, PostCompact, SessionEnd, Elicitation*, TaskCreated ignores it). |
| `stopReason` | none | message shown to user when `continue:false`; stays in conversation so Claude sees it if conversation continues |
| `suppressOutput` | `false` | **No effect** (accepted, ignored). Successful hook stdout is never shown in transcript anyway. |
| `systemMessage` | none | warning shown to user (SDK/stream-json: `SDKInformationalMessage`). Discarded/rerouted on some events (see per-event). Async hooks deliver it to Claude, not the user. |
| `terminalSequence` | none | escape sequence Claude Code emits for you: OSC `0/1/2` (titles), `9` (iTerm2/WezTerm/Windows Terminal notifications incl. `9;4` progress), `99` (Kitty), `777` (urxvt/Ghostty/Warp), bare BEL. Anything else -> field ignored. Interactive sessions only; ignored in `-p`/SDK. Works even on events that discard `systemMessage` (Notification, StopFailure). Not from `WorktreeCreate` command hooks. |
| `decision` / `reason` | none | top-level; only value is `"block"`. Reference's decision-control table lists it for UserPromptSubmit, UserPromptExpansion, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop, ConfigChange, PreCompact (and TaskCreated). Note: the PostToolUseFailure section itself documents only `additionalContext`, so treat `decision` there as unverified. Omit to allow. |
| `hookSpecificOutput` | none | nested; **requires `hookEventName` set to the event name**. Fields placed at top level instead of inside are silently ignored (debug log: `Hook JSON output had unrecognized keys`). |

Stop hook cap: after 8 consecutive blocks without progress Claude Code overrides and ends the turn (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

### 5.5 `hookSpecificOutput` fields by event

| Event | Fields |
|---|---|
| `PreToolUse` | `permissionDecision` (`allow`/`deny`/`ask`/`defer`), `permissionDecisionReason`, `updatedInput` (replaces ENTIRE input object), `additionalContext` |
| `PermissionRequest` | `decision: { behavior: "allow"|"deny", updatedInput?, updatedPermissions?[], message? (deny), interrupt? (deny) }` |
| `PermissionDenied` | `retry: true` |
| `PostToolUse` | `additionalContext`, `classifierContext` (v2.1.236+, <=2000 chars shared across hooks, sync only), `updatedToolOutput` (must match tool output shape; invalid -> ignored for built-ins; MCP passthrough), `updatedMCPToolOutput` (legacy) |
| `PostToolUseFailure` | `additionalContext` |
| `PostToolBatch` | `additionalContext` |
| `UserPromptSubmit` | `additionalContext`, `sessionTitle`, `suppressOriginalPrompt` (with top-level `decision:"block"`) |
| `UserPromptExpansion` | `additionalContext` |
| `SessionStart` | `additionalContext`, `initialUserMessage` (`-p` only: becomes first user turn), `sessionTitle` (startup/resume/fork only), `watchPaths[]`, `reloadSkills: true` |
| `SubagentStart` | `additionalContext` |
| `Stop` / `SubagentStop` | `additionalContext` (non-error feedback; conversation continues; labeled "Stop hook feedback" rather than hook error; same loop protections) |
| `PostModelSwitch` | `additionalContext` |
| `PreModelSwitch` | `permissionDecision` (`allow`/`deny`/`ask` only), `permissionDecisionReason` (top-level `decision:"block"` also works) |
| `MessageDisplay` | `displayContent` |
| `CwdChanged` / `FileChanged` | `watchPaths[]` (replaces dynamic watch list; matcher paths always watched) |
| `WorktreeCreate` (HTTP only) | `worktreePath` (command hooks print the path as last non-empty stdout line) |
| `Elicitation` / `ElicitationResult` | `action` (`accept`/`decline`/`cancel`), `content` (object) |

### 5.6 `additionalContext` delivery

Wrapped in a system reminder inserted where the hook fired; read on next model request; not shown as a chat message. Placement: SessionStart/SubagentStart -> start of conversation before first prompt; UserPromptSubmit/UserPromptExpansion -> alongside the prompt; PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch -> next to the tool result; Stop/SubagentStop -> end of turn (conversation continues); PostModelSwitch -> with next request. Multiple hooks -> all values delivered. >10,000 chars -> written to a file, path + preview passed.

Write it as factual statements ("This repo uses `bun test`"), not imperative system commands: imperative out-of-band phrasing can trip prompt-injection defenses and Claude surfaces it to the user instead of using it.

**Persistence / replay:** injected text is saved in the transcript. On `--continue`/`--resume`, mid-session hook context (PostToolUse, UserPromptSubmit) is REPLAYED from the transcript, not re-run (timestamps/SHAs go stale). `SessionStart` hooks DO re-run on resume (`source: "resume"`, or `"fork"`).

### 5.7 Decision-control precedence and combination

- All matching hooks run to completion in parallel; one `deny` does not stop siblings' side effects.
- `PreToolUse`: most restrictive wins: `deny` > `defer` > `ask` > `allow`. `additionalContext` from every hook is kept.
- `PreModelSwitch`: `deny` > `ask` > `allow`.
- Multiple hooks returning `updatedInput`: last to finish wins (non-deterministic). Don't have >1 hook rewrite the same tool's input.
- PreToolUse `allow` skips the prompt but deny/ask permission rules are STILL evaluated (hooks can tighten, never loosen). `deny` from a hook blocks even in `bypassPermissions` / `--dangerously-skip-permissions` / `dontAsk`.
- `allow` cannot skip: actions no mode auto-approves; `AskUserQuestion`/`ExitPlanMode` (need `allow` + `updatedInput`); MCP tools flagged `_meta["anthropic/requiresUserInteraction"]` (v2.1.199+); connector tools org-set to `ask`.
- `ask` from a hook forces a prompt even in auto mode (classifier can still deny; can't silently approve) (v2.1.211+). Prompt shows source label `[settings]`, `[plugin:<name>]`, or `[skill]`.
- `defer`: `-p` mode only (interactive: warning + ignored); single tool call per turn only; process exits with `stop_reason: "tool_deferred"` and `deferred_tool_use {id, name, input}`; resume with `claude -p --resume <id>` and the same permission host; hook then returns `allow` + `updatedInput`.
- Permission rules and Bash auto-background eligibility are evaluated against the `updatedInput` the hook returns, not what Claude sent.

---

## 6. Key questions answered

**Can `PreToolUse` ADD context on allow?** Yes. `hookSpecificOutput.additionalContext` is honored alongside `permissionDecision: "allow"` (and `"deny"`/`"ask"`); it is added to Claude's context next to the tool result. Ignored only when `permissionDecision` is `"defer"`. Official example combines `allow` + `updatedInput` + `additionalContext` in one response.

**Does `SessionStart` `additionalContext` persist across compaction?** Not automatically. Compaction summarizes the conversation and can drop it. The designed mechanism: `SessionStart` fires AGAIN after every auto or manual compaction with `source: "compact"` (matcher `compact`), so a hook with no matcher (or `matcher: "compact"`) re-injects context after each compaction. The guide's "Re-inject context after compaction" pattern exists precisely because the context does not survive. Note `sessionTitle` is ignored on `compact`/`clear` sources. For subagents the docs explicitly say auto-compaction discards the injected SubagentStart copy and the next run re-injects it. `InstructionsLoaded` also re-fires with `load_reason: "compact"` (CLAUDE.md re-load), and `PostCompact` gives you `compact_summary`.

**Can `PreToolUse` timeouts gate?** No. Timed-out command hooks let the tool continue. Only a hook that returns a decision or exits 2 within the timeout gates.

**Does exit 1 block?** No. Only exit 2 blocks (except worktree events). Exit 1 without valid JSON = non-blocking error and the action proceeds.

**Do plugin hooks merge with user/project hooks?** Yes: additive merge across user/project/local/managed/plugin/skill/agent sources; identical handler across settings files runs once; plugin/skill copies run separately; `allowManagedHooksOnly` can suppress non-managed ones.

---

## 7. Async / background hooks

- `"async": true` on `type: "command"` only. Claude continues immediately; same stdin JSON. Decision fields (`decision`, `permissionDecision`, `continue`) have no effect. `timeout` not enforced once running.
- After exit, `additionalContext` and `systemMessage` from its JSON are delivered to Claude on the NEXT conversation turn (neither shown to the user). Idle session -> waits for next user interaction. Malformed field types are dropped (v2.1.202+ no crash).
- `asyncRewake: true`: background + exit 2 wakes Claude immediately (even idle) with stderr (or stdout) as a system reminder; timeout still enforced.
- No dedup across firings; each firing is a separate process.
- In `-p` mode, async hooks still running at teardown are killed (`cancelled`); detach fully if work must outlive the run.
- `classifierContext` from async hooks is ignored.
- Completion notifications hidden unless verbose (`Ctrl+O` / `--verbose`).
- `InstructionsLoaded` and `DirectoryAdded` run asynchronously by design. `/clear` SessionStart hooks run in background but first response waits for them.

---

## 8. Per-event notes for the events the team asked about

### SessionStart
- Types: `command`, `mcp_tool` (mcp_tool skipped at launch; runs on clear/compact). Keep fast: runs every session.
- Plain stdout -> Claude's context. JSON form for combining with `sessionTitle`, `watchPaths`, `reloadSkills`, `initialUserMessage`.
- `CLAUDE_ENV_FILE` available: append `export` lines to persist env into later Bash commands.
- On `/clear`, hooks run in background; first response waits; another `/clear`/`/resume` cancels them.
- `--init-only` runs Setup + SessionStart(`startup`) then exits.

### UserPromptSubmit
- Default timeout 30 s (command/http/mcp_tool). Stuck hook stalls session.
- Add context via plain stdout OR `hookSpecificOutput.additionalContext` (both injected as system reminders; no visible transcript entry). Cannot replace the prompt.
- Block: `{"decision":"block","reason":"…"}` erases the prompt; `reason` shown to user, not context. `suppressOriginalPrompt: true` hides the prompt text from the block message. Also `sessionTitle`.

### PreToolUse
- Fires before ANY permission-mode check, in every mode. Doesn't fire for `@file` references or `EndConversation`.
- Output: `permissionDecision`, `permissionDecisionReason` (allow/ask -> shown to user not Claude; deny -> shown to Claude; defer -> ignored), `updatedInput`, `additionalContext`.
- Deprecated: top-level `decision`/`reason` with `"approve"`/`"block"` (map to allow/deny). Don't use.
- `ExitPlanMode` input has `plan`/`planFilePath` injected by Claude Code.

### PostToolUse
- `decision: "block"` + `reason` adds reason next to the tool result (Claude still sees original output). `updatedToolOutput` replaces what Claude sees (tool already ran; telemetry captured original). `additionalContext`. `classifierContext` for auto-mode classifier. Exit 2 -> stderr shown to Claude.
- Doesn't fire when a Bash command rewrites a file -> use `FileChanged`.

### Stop / SubagentStop
- Not on user interrupt; API errors -> `StopFailure`. `decision:"block"` requires `reason`. `additionalContext` = softer continuation. Check `stop_hook_active` to avoid loops; cap 8. `/goal` is a built-in prompt Stop hook.
- SubagentStop `reason` becomes the subagent's next instruction. To feed the parent after a subagent, use `PostToolUse` on `Agent`.

### PreCompact
- Exit 2 or `decision:"block"` blocks compaction. Blocking auto-compact triggered by a context-limit error surfaces that error and fails the request. `systemMessage`/`continue` discarded.

### SessionEnd
- No decision control; JSON fields discarded. 1.5 s shared budget (raise via per-hook `timeout` up to 60 s, or `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`).

### Notification
- No decision control; `systemMessage`/`continue` discarded; `terminalSequence` honored. Fires even with desktop notifications disabled.

### WorktreeCreate / WorktreeRemove
- Create: command hook prints worktree path as last non-empty stdout line (ANSI stripped); HTTP returns `hookSpecificOutput.worktreePath`. Replaces git behavior entirely (`.worktreeinclude` not processed). Relative path resolved against hook cwd; absolute paths with `.`/`..` or symlinks under repo root rejected (v2.1.216+). Any non-zero exit fails.
- Remove: receives `worktree_path`; non-zero exit fails removal if dir still exists; JSON discarded.

### PermissionRequest
- Only the `decision` object matters; exit 2 ignored. `updatedPermissions` entries: `addRules`/`replaceRules`/`removeRules` (`rules:[{toolName, ruleContent?}]`, `behavior`, `destination`), `setMode` (`mode`, `destination`), `addDirectories`/`removeDirectories`. `destination`: `session`, `localSettings`, `projectSettings`, `userSettings`. `setMode: bypassPermissions` only if bypass was already available at launch; never persisted as defaultMode.
- In plain `-p` runs (no `canUseTool` host), the prompt doesn't exist -> use `PreToolUse` for automation. Background subagents in `-p`: if no hook decides, call is denied.

---

## 9. Gotchas (production checklist)

1. Exit 1 does not block. Use exit 2 or JSON. A missing/non-executable script (127) = non-blocking = gate silently open. Watch first-run `hook error` notices.
2. Silence on PreToolUse is not approval; `allow` can't override deny/ask rules; `ask` forces prompt.
3. Timeouts fail OPEN on PreToolUse (tool proceeds). Only `PreModelSwitch` fails closed. SDK callback hooks fail closed.
4. `hookSpecificOutput` fields must be nested AND include `hookEventName`; misplaced fields are silently ignored.
5. Stdout must be ONLY the JSON object; shell profile `echo`s prepend text and break parsing (wrap profile output in `[[ $- == *i* ]]`). Build JSON with `jq -n --arg`, never string concatenation.
6. Stderr on exit 0 is invisible to Claude and user (debug log only). To warn Claude from PostToolUse, exit 2.
7. `suppressOutput` does nothing.
8. `if` on a non-tool event makes the handler never run. `if` holds exactly one rule. `if` matching is best-effort.
9. Matcher: `mcp__server` without `.*` matches nothing; `Edit.*` matches `NotebookEdit`; regex unanchored; case-sensitive; hyphens need v2.1.195+.
10. On Windows without Git Bash there is no `Bash` tool: match `Bash|PowerShell`. File paths arrive with backslashes; normalize before comparing.
11. `once` only works in skill frontmatter.
12. `${CLAUDE_PROJECT_DIR}` does not follow worktrees; `cwd` does. Prefer exec form (`"args": []`) for placeholder paths.
13. `CLAUDE_ENV_FILE` only on SessionStart/Setup/CwdChanged/FileChanged; CwdChanged clears prior dynamic exports.
14. `mcp_tool` hooks on SessionStart are skipped at launch (no MCP context); Setup always skips them.
15. `updatedInput` replaces the whole input object; include unchanged fields. Multiple rewriters race.
16. `updatedToolOutput` must match the tool's output schema for built-ins (Bash: `{stdout, stderr, interrupted, isImage}`) or it's ignored.
17. `PostToolBatch.tool_response` is the serialized model-visible string/blocks, not the structured object PostToolUse gets.
18. `transcript_path` lags; use `last_assistant_message`.
19. Stop hooks: check `stop_hook_active`; 8-block cap; they fire on every response end, not just task completion.
20. `-p`/SDK sessions treat folders as trusted and run repo hooks without a dialog; review `.claude/settings.json` or pass `--settings '{"disableAllHooks": true}'` / `--bare`.
21. Resume replays mid-session hook context rather than re-running hooks; SessionStart re-runs with `source: "resume"`.
22. Async hooks can't decide anything; output lands on next turn; `classifierContext` ignored; killed at `-p` teardown.
23. HTTP hooks can't block via status code; need 2xx + JSON; plain-text 2xx body = error. Header env interpolation requires `allowedEnvVars`; `allowedHttpHookUrls` may gate the URL.
24. `PermissionRequest` ignores exit 2 and stderr; only `decision.behavior` counts.
25. `ConfigChange` blocks surface no message anywhere; `policy_settings` can't be blocked.
26. Prompt hooks on `PreToolUse`/`PostToolUse` END THE TURN on `ok:false` by default (v2.1.210+); set `continueOnBlock: true` to behave like a command-hook deny.
27. `FileChanged` matcher is a literal filename list (regex is useless there); `"*"` registers a file literally named `*`.
28. Output strings cap at 10,000 chars; `classifierContext` at 2,000.
29. `terminalSequence` only in interactive sessions; allowlisted OSC codes only.
30. `SessionEnd` has 1.5 s total; long cleanup needs an explicit per-hook `timeout` (settings files only) or the env override.

---

## 10. Copy-paste snippets

### 10.1 Deny destructive Bash (PreToolUse, exec form, `if` prefilter)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "args": [],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/block-rm.sh
COMMAND=$(jq -r '.tool_input.command')
if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Destructive command blocked by hook"
    }
  }'
else
  exit 0  # no decision; normal permission flow applies
fi
```

### 10.2 PreToolUse allow + rewrite input + add context

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Auto-approved by policy",
    "updatedInput": { "command": "npm run lint", "description": "Lint" },
    "additionalContext": "Current environment: production. Proceed with caution."
  }
}
```

### 10.3 PreToolUse ask (escalate to user)

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "Writes outside src/ need confirmation" } }
```

### 10.4 Exit-2 style block (any blockable event)

```bash
#!/bin/bash
input=$(cat)
command=$(jq -r '.tool_input.command' <<<"$input")
if [[ "$command" == rm* ]]; then
  echo "Blocked: rm commands are not allowed" >&2
  exit 2
fi
exit 0
```

### 10.5 PostToolUse: add context, redact output, note for classifier

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "This file is generated. Edit src/schema.ts and run `bun generate` instead.",
    "classifierContext": "This query ran against the staging database, not production.",
    "updatedToolOutput": { "stdout": "[redacted]", "stderr": "", "interrupted": false, "isImage": false }
  }
}
```

### 10.6 PostToolUse block-with-feedback (top-level decision)

```json
{ "decision": "block", "reason": "Test suite must pass before proceeding" }
```

### 10.7 UserPromptSubmit: inject context / block prompt

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "Current branch: release-42. Deploy freeze until Friday." } }
```

```json
{
  "decision": "block",
  "reason": "Explanation for decision",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "My additional context here",
    "sessionTitle": "My session title"
  }
}
```

### 10.8 SessionStart: context + title + env persistence + re-inject after compaction

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/session-context.sh", "args": [] }
        ]
      },
      {
        "matcher": "compact",
        "hooks": [
          { "type": "command", "command": "echo 'Reminder: use Bun, not npm. Run bun test before committing. Current sprint: auth refactor.'" }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# session-context.sh
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
jq -nc --arg ctx "Current branch: $BRANCH" --arg title "$BRANCH" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx, sessionTitle: $title}}'
```

### 10.9 Stop: continue with reason / soft feedback

```json
{ "decision": "block", "reason": "Must be provided when Claude is blocked from stopping" }
```

```json
{ "hookSpecificOutput": { "hookEventName": "Stop", "additionalContext": "Please run the test suite before finishing" } }
```

```bash
#!/bin/bash
INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0  # already continued once; allow stop
fi
# ... checks ...
```

### 10.10 Stop everything (universal)

```json
{ "continue": false, "stopReason": "Build failed, fix errors before continuing" }
```

### 10.11 PermissionRequest: auto-allow + set mode

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { "command": "npm run lint" },
      "updatedPermissions": [ { "type": "setMode", "mode": "acceptEdits", "destination": "session" } ]
    }
  }
}
```

Deny: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Not allowed by policy","interrupt":false}}}`

### 10.12 PermissionDenied: allow retry

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionDenied", "retry": true } }
```

### 10.13 Notification -> desktop notification via terminalSequence

```bash
#!/bin/bash
input=$(cat)
title="Claude Code"
body=$(jq -r '.message // "Needs your attention"' <<<"$input")
seq=$(printf '\033]777;notify;%s;%s\007' "$title" "$body")
jq -nc --arg seq "$seq" '{terminalSequence: $seq}'
```

### 10.14 MCP tool matchers

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__memory__.*", "hooks": [ { "type": "command", "command": "echo 'Memory operation initiated' >> ~/mcp-operations.log" } ] },
      { "matcher": "mcp__.*__write.*", "hooks": [ { "type": "command", "command": "/home/user/scripts/validate-mcp-write.py" } ] }
    ]
  }
}
```

### 10.15 HTTP hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8080/hooks/pre-tool-use",
            "timeout": 30,
            "headers": { "Authorization": "Bearer $MY_TOKEN" },
            "allowedEnvVars": ["MY_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

### 10.16 MCP tool hook

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "mcp_tool", "server": "my_server", "tool": "security_scan", "input": { "file_path": "${tool_input.file_path}" } }
        ]
      }
    ]
  }
}
```

### 10.17 Prompt hook (Stop) and agent hook

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are evaluating whether Claude should stop working. Context: $ARGUMENTS\n\nAnalyze the conversation and determine if:\n1. All user-requested tasks are complete\n2. Any errors need to be addressed\n3. Follow-up work is needed\n\nRespond with JSON: {\"ok\": true} to allow stopping, or {\"ok\": false, \"reason\": \"your explanation\"} to continue working.",
            "timeout": 30
          },
          { "type": "agent", "prompt": "Verify that all unit tests pass. Run the test suite and check the results. $ARGUMENTS", "timeout": 120 }
        ]
      }
    ]
  }
}
```

### 10.18 Async test runner (PostToolUse)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/run-tests-async.sh", "args": [], "async": true }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# run-tests-async.sh
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.js ]]; then exit 0; fi
RESULT=$(npm test 2>&1); EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then MSG="Tests passed after editing $FILE_PATH"; else MSG="Tests failed after editing $FILE_PATH: $RESULT"; fi
jq -nc --arg msg "$MSG" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $msg}}'
```

### 10.19 Plugin `hooks/hooks.json`

```json
{
  "description": "Automatic code formatting",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh", "args": [], "timeout": 30 }
        ]
      }
    ]
  }
}
```

### 10.20 Skill frontmatter hook with `once`

```yaml
---
name: secure-operations
description: Perform operations with security checks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/security-check.sh"
          once: true
---
```

### 10.21 WorktreeCreate / WorktreeRemove (non-git VCS)

```json
{
  "hooks": {
    "WorktreeCreate": [ { "hooks": [ { "type": "command", "command": "bash -c 'NAME=$(jq -r .name); DIR=\"$HOME/.claude/worktrees/$NAME\"; svn checkout https://svn.example.com/repo/trunk \"$DIR\" >&2 && echo \"$DIR\"'" } ] } ],
    "WorktreeRemove": [ { "hooks": [ { "type": "command", "command": "bash -c 'jq -r .worktree_path | xargs rm -rf'" } ] } ]
  }
}
```

### 10.22 direnv reload (SessionStart + CwdChanged + FileChanged)

```json
{
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "direnv export bash > \"$CLAUDE_ENV_FILE\"" } ] } ],
    "CwdChanged":   [ { "hooks": [ { "type": "command", "command": "direnv export bash > \"$CLAUDE_ENV_FILE\"" } ] } ],
    "FileChanged":  [ { "matcher": ".envrc|.env", "hooks": [ { "type": "command", "command": "direnv export bash > \"$CLAUDE_ENV_FILE\"" } ] } ]
  }
}
```

### 10.23 ConfigChange audit log

```json
{
  "hooks": {
    "ConfigChange": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "jq -c '{timestamp: now | todate, source: .source, file: .file_path}' >> ~/claude-config-audit.log" } ] }
    ]
  }
}
```

### 10.24 Elicitation auto-respond

```json
{ "hookSpecificOutput": { "hookEventName": "Elicitation", "action": "accept", "content": { "username": "alice" } } }
```

### 10.25 MessageDisplay strip markdown

```bash
#!/bin/bash
jq '{hookSpecificOutput: {hookEventName: "MessageDisplay", displayContent: (.delta | gsub("\\*\\*"; "") | gsub("`"; ""))}}'
```

---

## 11. Debugging

- `claude --debug-file /tmp/claude.log` (or `claude --debug` -> `~/.claude/debug/<session-id>.txt`; `/debug` mid-session). `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` for matcher counts.
- Test scripts manually: `echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./my-hook.sh; echo $?`
- `Ctrl+O` transcript: success shows nothing; blocking error shows the reason/stderr; non-blocking shows `<hook name> hook error`.
- Search debug log for `Hook JSON output had unrecognized keys` to catch misplaced fields.
- `--init-only` prints nothing; use `--debug-file` to confirm Setup/SessionStart ran.
- With `-p --output-format stream-json --verbose`, hook stdout/stderr/exit appear as `hook_response` events.
