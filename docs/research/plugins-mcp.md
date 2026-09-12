# Claude Code Plugins + MCP contract (for a private, auto-installing team plugin)

Extracted 2026-09-12 from the raw markdown of the official docs (`https://code.claude.com/docs/en/*.md`).
Pages read: `plugins`, `plugins-reference`, `plugin-marketplaces`, `discover-plugins`, `mcp`, `settings`,
`settings-reference` (plugin + MCP sections), `hooks` (matchers, exec form, `mcp_tool`, SessionStart),
`permissions` (workspace trust), `channels`, `plugin-dependencies`, `settings-example`.

Version references below (e.g. "v2.1.195+") are the Claude Code versions the docs cite.

---

## 0. TL;DR recipe for "private plugin that teammates get automatically"

1. Create a **private GitHub repo** that is *both* the marketplace and the plugin host:

   ```text
   acme-claude-plugins/                      <- marketplace root (git repo)
   ├── .claude-plugin/
   │   └── marketplace.json                  <- catalog
   └── plugins/
       └── acme-tools/                       <- the plugin (relative-path source)
           ├── .claude-plugin/plugin.json
           ├── .mcp.json                     <- MCP server(s)
           ├── hooks/hooks.json              <- SessionStart etc.
           ├── skills/<name>/SKILL.md
           ├── agents/<name>.md
           └── scripts/, servers/, ...
   ```

2. Use a **relative-path plugin source** (`"source": "./plugins/acme-tools"`), NOT a `github` source.
   Reason: since v2.1.195, a plugin from an *external* source (github/npm/url) that is only enabled by the
   project's `.claude/settings.json` is **not** installed for teammates; they see "not installed" plus the
   `claude plugin install ...` command. In-marketplace (relative path) plugins are fetched into the cache
   "at session start when an enabled plugin isn't cached yet, such as on a new machine" (plugins-reference).

3. Commit this to the *product* repo's `.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "acme-tools": {
         "source": { "source": "github", "repo": "acme-corp/acme-claude-plugins" }
       }
     },
     "enabledPlugins": {
       "acme-tools@acme-tools": true
     }
   }
   ```

4. Prompt behavior: teammate opens the repo interactively -> accepts the **workspace trust dialog** for that
   folder -> Claude Code registers the marketplace "without a further prompt" and caches the enabled plugin.
   Before trust (or in `claude -p` / SDK with the folder never trusted), `extraKnownMarketplaces` from the repo
   is ignored silently. Plugin MCP servers start automatically when the plugin is enabled (no per-server
   approval prompt for marketplace-installed plugins).

5. Private-repo auth: users need working git creds (`gh auth setup-git` or SSH key in `ssh-agent`).
   `owner/repo` shorthand clones over **SSH by default**; set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` for HTTPS.
   Background auto-update disables credential helpers for HTTPS pulls; set
   `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` and/or a scoped `git config url.<...>.insteadOf` rewrite.

6. Updates: omit `version` in `plugin.json` and the marketplace entry -> version = commit SHA -> every push is
   a new version. Or set explicit semver and bump it on every release. Third-party marketplaces have
   `autoUpdate` **off by default**; users toggle in `/plugin > Marketplaces`, or admins set `"autoUpdate": true`
   on the `extraKnownMarketplaces` entry in **managed** settings. Manual: `claude plugin marketplace update acme-tools`
   then `claude plugin update acme-tools@acme-tools`.

7. Yes, one plugin can ship a `SessionStart` hook AND an MCP server together (the docs' own example of
   `${CLAUDE_PLUGIN_DATA}` does exactly this). Caveat: `type: "mcp_tool"` hooks on `SessionStart` are skipped at
   launch (servers not yet up); use `type: "command"` for launch-time work.

---

## 1. Plugin directory layout

Plugin root = the plugin's own directory (never `~/.claude/`). Only `plugin.json` goes inside `.claude-plugin/`;
every other component dir lives at the plugin root.

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json           # manifest (optional if components are in default locations)
├── skills/                   # <name>/SKILL.md  (preferred over commands/)
│   └── code-review/SKILL.md
├── commands/                 # flat .md skills (legacy; use skills/)
├── agents/                   # subagent .md files
├── workflows/                # workflow scripts
├── output-styles/
├── themes/                   # experimental
├── monitors/monitors.json    # experimental background monitors
├── hooks/hooks.json          # hook config (optional extra files e.g. security-hooks.json)
├── bin/                      # added to Bash PATH while enabled (NOT allowed for claude.ai org distribution)
├── settings.json             # only `agent` and `subagentStatusLine` keys supported
├── .mcp.json                 # MCP servers
├── .lsp.json                 # LSP servers
├── scripts/                  # your hook/util scripts
├── package.json + package-lock.json   # optional; deps auto-installed into cache (npm ci --ignore-scripts)
├── LICENSE, CHANGELOG.md, README.md
```

Notes:
- A `CLAUDE.md` at plugin root is NOT loaded. Ship instructions as skills.
- Single-skill plugin: `SKILL.md` at root (no `skills/`), set frontmatter `name`.
- Plugin files are **copied** into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Paths like
  `../shared` don't work (path-escapes-plugin-directory error). Symlinks within the same marketplace are
  dereferenced on copy; symlinks outside the marketplace are skipped.
- Backslashes in component paths are rejected on macOS/Linux.

### File locations reference

| Component   | Default location          |
|-------------|---------------------------|
| Manifest    | `.claude-plugin/plugin.json` |
| Skills      | `skills/`                 |
| Commands    | `commands/`               |
| Agents      | `agents/`                 |
| Workflows   | `workflows/`              |
| Output styles | `output-styles/`        |
| Themes      | `themes/`                 |
| Hooks       | `hooks/hooks.json`        |
| MCP servers | `.mcp.json`               |
| LSP servers | `.lsp.json`               |
| Monitors    | `monitors/monitors.json`  |
| Executables | `bin/`                    |
| Settings    | `settings.json`           |

---

## 2. `.claude-plugin/plugin.json` — full schema

`name` is the only required field (kebab-case, no spaces). Unknown top-level fields are ignored (warning in
`claude plugin validate`; `--strict` makes them errors).

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": { "name": "Author Name", "email": "author@example.com", "url": "https://github.com/author" },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "metadata": { "catalogId": "cat-123", "tier": "pro" },
  "defaultEnabled": true,
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "workflows": "./custom/workflows/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": { "themes": "./themes/", "monitors": "./monitors.json", "evals": "quality/evals" },
  "userConfig": { },
  "channels": [ ],
  "dependencies": [ "helper-lib", { "name": "secrets-vault", "version": "~2.1.0" } ]
}
```

Field notes:
- `version`: optional. If set, users only get updates when you bump it (`plugin.json` wins over the marketplace
  entry, silently). If omitted, falls back to marketplace entry version -> git commit SHA -> archive digest -> `unknown`.
- `defaultEnabled: false` installs the plugin disabled; user's `enabledPlugins` entry always wins.
- `hooks` / `mcpServers` / `lspServers`: `string | array | object` — path(s) to JSON file(s) or inline config.
- Path fields must be relative and start with `./` (`skills` also accepts `"."`).
- `commands`, `agents`, `workflows`, `outputStyles`, `experimental.*` **replace** the default dir when set;
  `skills` **adds to** the default `skills/` scan.
- Plugin agents support `name, description, model, effort, maxTurns, tools, disallowedTools, skills, memory,
  background, isolation`; **`hooks`, `mcpServers`, `permissionMode` are NOT supported** in plugin-shipped agents.

### `userConfig` (prompted at enable time; secrets go to Keychain)

```json
{
  "userConfig": {
    "api_endpoint": { "type": "string", "title": "API endpoint", "description": "Your team's API endpoint" },
    "api_token":    { "type": "string", "title": "API token", "description": "API auth token", "sensitive": true, "required": true }
  }
}
```

- `type`: `string | number | boolean | directory | file`; `title`, `description` required; optional `sensitive`,
  `required`, `default`, `multiple`, `min`/`max`.
- Substitute as `${user_config.KEY}` in MCP/LSP server configs and **exec-form** hook commands; non-sensitive
  values also in skill/agent content. Exported to hook processes as `CLAUDE_PLUGIN_OPTION_<KEY>` (uppercased).
- **Rejected** in shell-form hook commands, monitor commands, and MCP `headersHelper` (shell injection risk).
  Put `${user_config.KEY}` in MCP `headers` (not shell-parsed) or read `CLAUDE_PLUGIN_OPTION_<KEY>` in the script.
- Non-sensitive values are stored in **user** `~/.claude/settings.json` under `pluginConfigs["<plugin>@<marketplace>"].options`.
  Sensitive: macOS Keychain (~2 KB total shared with OAuth tokens) or `~/.claude/.credentials.json`.
- `pluginConfigs` is read ONLY from user settings, `--settings`, and managed settings. Project/local files are ignored (v2.1.207+).
- CLI: `claude plugin install foo@mkt --config api_endpoint=https://... --config api_token=...`

### `channels`

```json
{
  "channels": [
    {
      "server": "telegram",
      "userConfig": {
        "bot_token": { "type": "string", "title": "Bot token", "description": "Telegram bot token", "sensitive": true },
        "owner_id":  { "type": "string", "title": "Owner ID",  "description": "Your Telegram user ID" }
      }
    }
  ]
}
```

- `server` must match a key in the plugin's `mcpServers`. The MCP server declares the `claude/channel` capability.
- Channels are a **research preview**: user must opt in per session with `--channels <plugin>`; only plugins on the
  Anthropic allowlist or the org's `allowedChannelPlugins` (managed settings, requires `channelsEnabled: true`) register.
  Test custom ones with `--dangerously-load-development-channels`. Being in `.mcp.json` alone doesn't push messages.
- Scaffold: `claude plugin init my-chan --with channel` (creates `server.ts`, `.mcp.json`, `package.json`; needs Bun).

---

## 3. Hooks in a plugin — `hooks/hooks.json`

Same shape as the `hooks` object in settings.json, plus an optional top-level `description`.

```json
{
  "description": "Automatic code formatting",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/session-start.js"] }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/format-code.sh" }
        ]
      }
    ]
  }
}
```

- Hook types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- **Exec form** (with `args`) vs **shell form** (no `args`). Prefer exec form whenever you reference
  `${CLAUDE_PLUGIN_ROOT}` (no quoting issues, no shell). Shell form needs `"${CLAUDE_PLUGIN_ROOT}"` in double quotes.
- Scripts must be `chmod +x` with a shebang. Hook receives JSON on stdin.
- `SessionStart` supports only `command` and `mcp_tool`. Matchers: `startup | resume | clear | compact | fork`.
  Stdout is added to Claude's context; JSON `hookSpecificOutput` supports `additionalContext`, `initialUserMessage`,
  `sessionTitle`, `watchPaths`, `reloadSkills`.
- `mcp_tool` hooks on `SessionStart` are **skipped at launch** (no MCP client context yet); they run after `/clear`
  or compaction. `Setup` always skips them. Use a `command` hook for first-turn needs.
- Plugin hooks merge with user/project hooks when enabled; a plugin's copy of an identical handler stays separate.
- Plugin hooks also run inside subagents.
- Hooks that target the plugin's own MCP server must use scoped names (see §5).
- All events: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest,
  PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart,
  SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange,
  CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact,
  PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.

### SessionStart hook that installs deps into the persistent data dir (docs' example)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

---

## 4. MCP servers in a plugin — `.mcp.json`

Standard `mcpServers` map. Plugin servers start automatically when the plugin is enabled; you add/remove them by
installing/uninstalling the plugin (can still toggle off in `/mcp`).

```json
{
  "mcpServers": {
    "acme-api": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/servers/acme-api.js"],
      "env": {
        "ACME_API_URL": "${ACME_API_URL:-https://api.acme.internal}",
        "ACME_TOKEN": "${ACME_TOKEN}",
        "NODE_PATH": "${CLAUDE_PLUGIN_DATA}/node_modules"
      }
    },
    "acme-remote": {
      "type": "http",
      "url": "https://mcp.acme.internal/mcp",
      "headers": { "Authorization": "Bearer ${user_config.api_token}" }
    },
    "acme-placeholder": {
      "type": "http",
      "url": ""
    }
  }
}
```

Transport types and JSON fields:

| `type`                     | Fields                                             | Notes |
|----------------------------|----------------------------------------------------|-------|
| `stdio` (default if no type) | `command`, `args`, `env`                        | Local process. Gets `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` in env. |
| `http` (alias `streamable-http`) | `url`, `headers`, `headersHelper`, `timeout`, `alwaysLoad`, `oauth` | Recommended remote transport; supports OAuth (`/mcp` to auth). |
| `sse`                      | same as http                                       | **Deprecated**. v2.1.265+ tries http first then falls back to sse automatically. |
| `ws`                       | same as http, header-only auth                     | No OAuth; not in `claude mcp add --transport`; use JSON/`add-json`. |

- An entry with `url` but no `type` is an **error** (read as stdio and skipped).
- Empty `url` = "not configured" placeholder (v2.1.208+), no error — useful for a connector users fill in later.
- Per-server `timeout` (ms, >=1000) = hard wall-clock per tool call.

### Placeholder substitution (plugin configs)

| Server type          | Fields where `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` resolve |
|----------------------|----------------------------------------------------------------------------------------------|
| stdio                | `command`, `args`, `env`                                                                     |
| http / sse / ws      | `url`, `headers`, `headersHelper`                                                            |

All three are also exported as env vars to the server subprocess. Plugin configs substitute `${CLAUDE_PROJECT_DIR}`
directly (a project `.mcp.json` needs `${CLAUDE_PROJECT_DIR:-.}` because it's only set in the child env).

### `${VAR}` env expansion (project `.mcp.json` and plugin `.mcp.json`)

- `${VAR}` and `${VAR:-default}`; expands in `command`, `args`, `env`, `url`, `headers`.
- Missing var with no default: server still loads with literal `${VAR}` text + warning in `claude mcp list` / `/mcp`.
- Plugin servers have "access to the same environment variables as manually configured servers" (the user's shell env).

### Secrets: three options for plugin MCP servers

1. `${VAR}` from the user's environment (e.g. `"ACME_TOKEN": "${ACME_TOKEN}"`) — simplest, needs each user to export it.
2. `userConfig` with `"sensitive": true` -> `${user_config.api_token}` in `env` (stdio) or `headers` (http).
   Stored in Keychain. Prompted at enable; or `--config key=value` on install.
3. `headersHelper` (http/sse/ws): shell command printing a JSON object of headers; runs fresh on each connect;
   re-run once on 401/403. For plugin servers it runs from the plugin root, with `CLAUDE_PLUGIN_ROOT`,
   `CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL` set, and **credential-looking env vars stripped**
   (names containing TOKEN/SECRET/PASSWORD/KEY/AUTH). Cannot reference `${user_config.*}`. Read creds from a file/keychain.

### Project `.mcp.json` vs plugin `.mcp.json`

| | Project `.mcp.json` (repo root) | Plugin `.mcp.json` |
|-|-|-|
| Who writes it | `claude mcp add --scope project` or by hand | plugin author |
| Approval | Interactive: **per-server approval prompt** on first use (`claude mcp reset-project-choices` to reset). `-p`/SDK: loaded without prompt. Repo-committed `enableAllProjectMcpServers`/`enabledMcpjsonServers` ignored until folder trusted. | Starts automatically when plugin enabled; trust is at plugin-install level. (Exception: project-scope `@skills-dir` plugins get the same per-server approval as project `.mcp.json`.) |
| Tool name | `mcp__<server>__<tool>` | `mcp__plugin_<plugin>_<server>__<tool>` |
| Precedence | Local > Project > User > **Plugin** > claude.ai connectors (managed `managedMcpServers` above all). Scopes dedupe by name; plugins/connectors dedupe by endpoint. |

---

## 5. Plugin MCP tool names and server names (exact)

- Tool callable name: **`mcp__plugin_<plugin-name>_<server-name>__<tool-name>`**, with any char outside
  `A-Z a-z 0-9 _ -` replaced by `_`.
  Example: plugin `my-plugin`, server key `database-tools`, tool `query` -> `mcp__plugin_my-plugin_database-tools__query`.
- Use that full name in permission rules, skill `allowed-tools`, subagent `tools`, and hook matchers / `if` fields.
- Matcher for every tool from that server: `mcp__plugin_my-plugin_database-tools__.*` (the `.*` is required;
  a matcher against the bare server key `mcp__database-tools__.*` **never fires** for plugin servers).
- Server registers as **`plugin:<plugin-name>:<server-name>`** (e.g. `plugin:my-plugin:database-tools`) — use this in an
  `mcp_tool` hook's `server` field and anywhere a configured server name is expected.
- Plugin subagents are `plugin-name:agent-name`; match `SubagentStart` with `^my-plugin:reviewer$`.
- Plugin skills are `/plugin-name:skill-name`.

---

## 6. Environment variables available to plugin components

| Variable                | Resolves to | Use for |
|-------------------------|-------------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path of the installed (cached) plugin version dir. **Changes on every update.** | Bundled scripts, binaries, config. |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/` where id = `plugin-marketplace` sanitized (e.g. `formatter-my-marketplace`). Survives updates; created on first reference; deleted on uninstall from last scope (`--keep-data` to keep). | node_modules, venvs, caches, generated state. |
| `${CLAUDE_PROJECT_DIR}` | Project root. | Project-local scripts/config. |

Exported to hook processes, MCP and LSP server subprocesses. Inline substitution: skill/agent content (anywhere),
hook & monitor commands (anywhere), MCP fields per §4 table, LSP `command/args/env/workspaceFolder`.
Don't write state to `${CLAUDE_PLUGIN_ROOT}` (old version dirs are swept ~14 days after update).

Node deps: if plugin root has `package.json` + `package-lock.json`/`npm-shrinkwrap.json` (or `bun.lock[b]`),
Claude Code runs `npm ci --ignore-scripts` (or `bun install --frozen-lockfile --ignore-scripts`) into the cached copy
on install/update/first-session-on-new-machine, 60 s timeout, no lifecycle scripts. `yarn.lock`/`pnpm-lock.yaml`
are skipped. Can't be disabled. For anything needing postinstall/python, use a SessionStart hook + `${CLAUDE_PLUGIN_DATA}`.

---

## 7. Marketplace — `.claude-plugin/marketplace.json`

Lives at `<repo>/.claude-plugin/marketplace.json`. Relative sources resolve against the **repo root** (the dir
containing `.claude-plugin/`), not the `.claude-plugin/` dir.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "acme-tools",
  "owner": { "name": "Acme DevTools", "email": "devtools@acme.com", "url": "https://github.com/acme-corp" },
  "description": "Acme internal Claude Code plugins",
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    {
      "name": "acme-tools",
      "source": "./plugins/acme-tools",
      "description": "Acme MCP server, session hooks, and skills",
      "author": { "name": "Acme DevTools" },
      "category": "productivity",
      "tags": ["internal"]
    },
    {
      "name": "acme-external-example",
      "source": { "source": "github", "repo": "acme-corp/some-plugin", "ref": "main" },
      "description": "External-source example (teammates must run claude plugin install)"
    }
  ],
  "renames": { }
}
```

Schema:
- Required: `name` (kebab-case, public-facing; one marketplace per name per user — a second add with the same name
  replaces the first), `owner` (`name` required; `email`, `url` optional), `plugins` (array).
- Optional: `$schema`, `description`, `version`, `metadata.pluginRoot` (v2.1.239+, lets bare names resolve under a
  dir), `allowCrossMarketplaceDependenciesOn`, `renames` (old-name -> new-name or `null`; append-only history; v2.1.193+).
- Reserved names (can't use): `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`,
  `claude-plugins-community`, `claude-community`, `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`,
  `anthropic-agent-skills`, `knowledge-work-plugins`, `life-sciences`, `claude-for-legal`,
  `claude-for-financial-services`, `financial-services-plugins`, `first-party-plugins`, `claude-tag-plugins`,
  `healthcare`, plus anything impersonating official.

Plugin entry fields:
- Required: `name`, `source`.
- Optional: any `plugin.json` field (`displayName`, `description`, `version`, `author`, `homepage`, `repository`,
  `license`, `keywords`, `metadata`, `defaultEnabled`, `skills`, `commands`, `agents`, `hooks`, `mcpServers`,
  `lspServers`) plus marketplace-only: `category`, `tags`, `strict` (default `true`), `relevance`, `headers`,
  `headersHelper` (archive auth).
- Entry `displayName`/`description`/etc. override `plugin.json`'s for display. Entry `defaultEnabled` overrides plugin.json.
- `strict: true` (default): `plugin.json` is authoritative, entry can add components. `strict: false`: entry is
  the whole definition; a `plugin.json` that also declares components = conflict, plugin fails to load.

### Plugin `source` types

| Source        | Shape | Notes |
|---------------|-------|-------|
| Relative path | `"./plugins/foo"` (or bare `"foo"` with `metadata.pluginRoot`) | Inside the marketplace repo. **Only this type auto-installs for teammates from project settings.** Doesn't work when the marketplace is added via a direct `marketplace.json` URL. |
| `github`      | `{ "source": "github", "repo": "owner/repo", "ref?": "v2.0.0", "sha?": "<40-hex>" }` | `sha` wins over `ref` if both set. |
| `url` (git)   | `{ "source": "url", "url": "https://gitlab.com/team/plugin.git", "ref?", "sha?" }` | Any git host; `.git` suffix optional; `git@` SSH ok. |
| `git-subdir`  | `{ "source": "git-subdir", "url": "...", "path": "tools/claude-plugin", "ref?", "sha?" }` | Sparse clone of a monorepo subdir; `url` accepts `owner/repo` shorthand. |
| `npm`         | `{ "source": "npm", "package": "@acme/plugin", "version?", "registry?" }` | `npm install`; version `unknown` unless set. |
| `archive`     | `{ "source": "archive", "url": "https://.../plugin.zip", "sha256?" }` | v2.1.224+; no git/npm needed; `headers`/`headersHelper` for auth. |
| `command`     | `{ "source": "command", "command": "...", "timeout?", "mode?": "copy"\|"link" }` | v2.1.229+; re-run once per session; version = content hash; user must accept (`--yes` non-TTY). |

Marketplace source (in `extraKnownMarketplaces` / `marketplace add`) supports `ref` but **not** `sha`;
plugin sources support both. They're pinned independently.

### Hosting / private repos

- GitHub recommended: users `claude plugin marketplace add owner/repo` (append `@ref` for branch/tag).
  Other git: full URL with `.git` suffix (`#ref` to pin). Direct URL to `marketplace.json` also works but breaks
  relative-path sources. Local dir for dev: `./my-marketplace`.
- **Private repo auth (commands you run)**: uses your git credential helpers (`gh auth setup-git`, macOS Keychain,
  `git-credential-store`) or SSH (`known_hosts` + key in `ssh-agent`; interactive prompts are suppressed).
  `owner/repo` shorthand clones over **SSH by default**; `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` switches to HTTPS.
  `GITHUB_TOKEN` alone does nothing unless a credential helper reads it (gh's helper reads `GH_TOKEN`/`GITHUB_TOKEN`).
- **Background auto-updates**: HTTPS pulls run with credential helpers **disabled** -> fail on private repos -> Claude
  Code re-clones (which does use creds, but may time out). SSH remotes are fine. Fixes:
  - `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` (keep clone on pull failure; manual update still works)
  - `gh auth setup-git` so the re-clone can auth
  - Scoped URL rewrite so the pull itself authenticates:
    `git config --global url."https://x-access-token:YOUR_TOKEN@github.com/acme-corp/plugins".insteadOf "https://github.com/acme-corp/plugins"`
    (GitLab: `oauth2:TOKEN@`, Bitbucket: `x-token-auth:TOKEN@`; use a read-only token; scope to the repo/org path.)
  - `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS=300000` if clones time out (default 120 s).
- CI: export a PAT/app token as `GH_TOKEN` then `gh auth setup-git` before `claude plugin install`.
- **Org-settings distribution (Team/Enterprise)**: claude.ai Admin settings > Plugins syncs a private/internal GitHub
  marketplace repo via the Claude GitHub App; plugin sources must be `github`/`url`/`git-subdir` or `./relative`
  (no bare `pluginRoot` names); private plugin sources allowed only if same github.com owner or GHE app. Plugins must
  **not** have a top-level `bin/` dir. Puts plugin under `managed` scope for users.
- Containers/CI: `CLAUDE_CODE_PLUGIN_SEED_DIR` (read-only pre-populated `~/.claude/plugins` mirror), build it with
  `CLAUDE_CODE_PLUGIN_CACHE_DIR=/opt/claude-seed claude plugin marketplace add ... && ... plugin install ...`.
- Managed lockdown: `strictKnownMarketplaces` (allowlist; `[]` = block all), `blockedMarketplaces`,
  `disableSideloadFlags`, `disableCommandPluginSources`, `pluginSuggestionMarketplaces`.
- State: `~/.claude/plugins/known_marketplaces.json` (per user), cache at `~/.claude/plugins/cache/`.

---

## 8. Team auto-install: `.claude/settings.json` keys and behavior

### Exact keys

```json
{
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": { "source": "github", "repo": "acme-corp/acme-claude-plugins" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "acme-tools@acme-tools": true
  }
}
```

- `extraKnownMarketplaces`: object keyed by marketplace name -> `{ source: {...}, autoUpdate?: boolean }`.
  Alias `additionalMarketplaces` (v2.1.232+; older versions ignore the alias). Scope: any file, but repo files
  honored **only after the workspace trust dialog is accepted** for that folder (silently ignored otherwise,
  including in `-p` runs). Same-name entries: highest-precedence file wins whole (no field merge, v2.1.228+).
  `autoUpdate` from a repo file: docs say admins set it "in managed settings"; third-party marketplaces default `false`.
- Marketplace `source.source` values: `github` (`repo`, optional `skipLfs`), `git` (`url`, optional `skipLfs`),
  `url` (`url`, `headers?`, `headersHelper?` — direct `marketplace.json`), `file` (`path`), `directory` (`path`, dev only),
  `settings` (inline: `name` + `plugins[]`, plugins must be external sources).
- `enabledPlugins`: object `"<plugin>@<marketplace>": true|false`. Scope: any file. Project > user precedence;
  to opt out locally use `.claude/settings.local.json` (`false`). Managed `false` blocks install everywhere.
  A plugin with no entry anywhere follows its `defaultEnabled`.

### What actually happens for a teammate (interactive)

1. Clone repo, run `claude`. Trust dialog appears (lists allow rules etc.). Accept.
2. Claude Code registers `acme-tools` marketplace "without a further prompt" (clones the private repo with the
   user's git creds — if auth fails, marketplace isn't available).
3. For each `enabledPlugins` entry: if the plugin's source is a **relative path in that marketplace**, it's copied
   into the cache at session start ("at session start when an enabled plugin isn't cached yet, such as on a new
   machine") and loads. If the source is **external** (github/npm/url/...), v2.1.195+ reports "not installed" and
   prints the `claude plugin install <plugin>@<marketplace>` command; it doesn't load until the user runs it.
4. Plugin hooks and MCP servers activate with the plugin. No per-server MCP approval prompt for marketplace plugins.
   If a `userConfig` is declared, the user is prompted for values at enable time.
5. Non-interactive (`claude -p`, SDK) in a never-trusted folder: `extraKnownMarketplaces` from the repo is **not used**
   at all. Trust by hand: `projects["<repo-root>"].hasTrustDialogAccepted: true` in `~/.claude.json`, or `--bare` /
   `--setting-sources user` to opt out.
6. Cloud sessions / Cowork: read committed `.claude/settings.json`; declare under `enabledPlugins` there if `/plugin` isn't available.

### Alternative: install via CLI to project scope (writes the same keys)

```bash
claude plugin marketplace add acme-corp/acme-claude-plugins --scope project   # writes extraKnownMarketplaces
claude plugin install acme-tools@acme-tools --scope project                    # writes enabledPlugins
```

Scopes: `user` (`~/.claude/settings.json`, default), `project` (`.claude/settings.json`), `local`
(`.claude/settings.local.json`), `managed` (read-only, update only).

---

## 9. CLI cheat sheet

```bash
# Marketplaces
claude plugin marketplace add <owner/repo | git-url[.git][#ref] | https://.../marketplace.json | ./dir> [--scope user|project|local] [--sparse <paths...>]
claude plugin marketplace add acme-corp/claude-plugins@v2.0        # pin ref
claude plugin marketplace list [--json]
claude plugin marketplace update [name]                            # refresh catalog (respects pinned ref)
claude plugin marketplace remove <name> [--scope ...]              # last scope removal also uninstalls its plugins

# Plugins
claude plugin init <name> [--with skills agents hooks mcp lsp output-style channel] [--description] [--author] [-f]   # -> ~/.claude/skills/<name>/ as <name>@skills-dir
claude plugin install <plugin>[@marketplace] [-s user|project|local] [--config k=v]... [-y] [--json]
claude plugin uninstall <plugin>[@marketplace] [-s scope] [--keep-data] [--prune] [-y] [--json]
claude plugin enable <plugin>[@marketplace] [-s scope] [--json]
claude plugin disable [plugin] [-a|--all] [-s scope] [--json]
claude plugin update <plugin>[@marketplace] [-s user|project|local|managed] [-y] [--json]
claude plugin list [--json] [--available]
claude plugin details <plugin>                                     # component inventory + token cost
claude plugin validate <path> [--strict]                           # plugin dir OR marketplace dir; exit 0/1/2
claude plugin eval ...                                             # run eval prompts with/without plugin
claude plugin prune

# Dev loop
claude --plugin-dir ./my-plugin [--plugin-dir ./other]             # also accepts .zip or a folder of plugins (v2.1.265+)
claude --plugin-url https://example.com/my-plugin.zip
/reload-plugins  [--force]                                         # in-session; reloads hooks, MCP, LSP, skills, agents
claude --debug                                                     # plugin load / MCP init details

# MCP (non-plugin)
claude mcp add --transport http <name> <url> [--header "Authorization: Bearer ..."] [--scope local|project|user]
claude mcp add --transport sse <name> <url>                        # deprecated transport
claude mcp add [--env K=V ...] [--transport stdio] <name> -- <command> [args...]
claude mcp add-json <name> '<json>' [--scope user] [--client-secret]
claude mcp list | claude mcp get <name> | claude mcp remove <name> [--scope ...]
claude mcp reset-project-choices
/mcp                                                               # status, OAuth, toggle
```

---

## 10. Versioning and updates (how teammates get new versions)

Version resolution order (all sources except `command`):
1. `plugin.json` `version` (wins silently over marketplace entry)
2. marketplace entry `version`
3. git commit SHA of the plugin source (github / url / git-subdir / relative path in a git-hosted marketplace)
4. sha256 digest (archive)
5. `unknown` (npm, non-git local dir)

`command` sources: always content-hash (`<version>-<hash>` if version set).

| Strategy | How | Update behavior |
|----------|-----|-----------------|
| Explicit semver | `"version": "2.1.0"` in plugin.json | Users get updates **only when you bump it**; pushing without bump = "already at latest". |
| Commit-SHA | omit `version` in both places | Every new commit = new version. Best for internal/active plugins. |
| Digest | archive source, no version | Changes when `sha256` pin or zip bytes change. |

Delivery:
- Background check after session start (random delay <=10 min) for marketplaces with auto-update on;
  notification to `/reload-plugins`, else new version loads next launch. Third-party marketplaces: auto-update
  **off by default** (toggle in `/plugin > Marketplaces`, or managed `extraKnownMarketplaces[..].autoUpdate: true`).
- `claude plugin install plugin@marketplace` refreshes that marketplace first (v2.1.232+).
- Manual: `claude plugin marketplace update acme-tools` then `claude plugin update acme-tools@acme-tools`.
- `DISABLE_AUTOUPDATER=1` also stops plugin updates; add `FORCE_AUTOUPDATE_PLUGINS=1` to keep plugin updates only.
- After update mid-session, hooks/MCP keep the old `${CLAUDE_PLUGIN_ROOT}` until `/reload-plugins`; old version dir
  swept ~14 days later.
- Release channels: two marketplaces pointing at different `ref`s of the same repo, assigned per group via managed
  settings; each must resolve to a distinct version.
- Renaming/removing a plugin: add `renames` map in marketplace.json (never change `name` without it).
- Plugin-to-plugin deps: `dependencies` in plugin.json with semver ranges; marketplace maintainers tag releases as
  `{plugin-name}--v{version}`.

---

## 11. Full copy-paste starter for the team plugin

### `plugins/acme-tools/.claude-plugin/plugin.json`

```json
{
  "name": "acme-tools",
  "displayName": "Acme Tools",
  "description": "Acme internal MCP server, session context hook, and skills",
  "author": { "name": "Acme DevTools", "email": "devtools@acme.com" },
  "repository": "https://github.com/acme-corp/acme-claude-plugins",
  "license": "UNLICENSED",
  "keywords": ["acme", "internal"],
  "userConfig": {
    "api_token": {
      "type": "string",
      "title": "Acme API token",
      "description": "Personal token from https://acme.internal/tokens",
      "sensitive": true,
      "required": true
    }
  }
}
```
(No `version` -> commit-SHA versioning -> every push to the marketplace repo is an update.)

### `plugins/acme-tools/.mcp.json`

```json
{
  "mcpServers": {
    "api": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/servers/api/index.js"],
      "env": {
        "ACME_API_TOKEN": "${user_config.api_token}",
        "ACME_API_URL": "${ACME_API_URL:-https://api.acme.internal}"
      }
    }
  }
}
```
-> tools appear as `mcp__plugin_acme-tools_api__<tool>`; server name `plugin:acme-tools:api`.

### `plugins/acme-tools/hooks/hooks.json`

```json
{
  "description": "Acme session bootstrap",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/session-start.js"] }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__plugin_acme-tools_api__.*",
        "hooks": [
          { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/audit-mcp-call.js"] }
        ]
      }
    ]
  }
}
```

### `.claude-plugin/marketplace.json` (repo root)

```json
{
  "name": "acme-tools",
  "owner": { "name": "Acme DevTools", "email": "devtools@acme.com" },
  "plugins": [
    {
      "name": "acme-tools",
      "source": "./plugins/acme-tools",
      "description": "Acme internal MCP server, session context hook, and skills",
      "category": "productivity"
    }
  ]
}
```

### Product repo `.claude/settings.json`

```json
{
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": { "source": "github", "repo": "acme-corp/acme-claude-plugins" }
    }
  },
  "enabledPlugins": {
    "acme-tools@acme-tools": true
  },
  "permissions": {
    "allow": ["mcp__plugin_acme-tools_api__*"]
  }
}
```

### Validate before pushing

```bash
claude plugin validate ./plugins/acme-tools --strict
claude plugin validate .            # from marketplace root
claude --plugin-dir ./plugins/acme-tools
claude plugin marketplace add ./ && claude plugin install acme-tools@acme-tools
```

---

## 12. Gotchas checklist

- Don't put `skills/`, `hooks/`, `.mcp.json` inside `.claude-plugin/`. Only `plugin.json` lives there.
- `~/.claude/.mcp.json` is not read; plugin root is the plugin dir.
- External-source plugins (`github`/`npm`/...) in `enabledPlugins` do NOT auto-install for teammates (v2.1.195+);
  use relative-path sources inside the marketplace repo.
- `extraKnownMarketplaces` from a repo file waits for the **folder's own** trust dialog; parent-folder trust and
  `-p`/SDK don't count.
- `pluginConfigs` is never read from project/local settings; `userConfig` answers live in user settings/Keychain.
- `${user_config.*}` is rejected in shell-form hooks, monitors, and `headersHelper`.
- Hook matchers for plugin MCP tools must use `mcp__plugin_<plugin>_<server>__...`; bare `mcp__<server>__` never fires.
- `mcp_tool` hooks on `SessionStart` don't run at launch.
- Setting `version` in `plugin.json` and forgetting to bump = no one gets updates.
- `plugin.json` `version` silently overrides marketplace `version`.
- Third-party marketplace auto-update is off by default; private HTTPS background pulls fail without a URL rewrite.
- `owner/repo` shorthand = SSH clone by default.
- Direct-URL marketplaces (`https://.../marketplace.json`) can't use relative-path plugin sources.
- Removing a marketplace from its last scope uninstalls its plugins.
- `bin/` at plugin root is rejected by claude.ai org distribution; use `scripts/` + `${CLAUDE_PLUGIN_ROOT}/scripts/...`.
- Plugin agents can't declare `hooks`, `mcpServers`, or `permissionMode`.
- `CLAUDE.md` inside a plugin is ignored.
- MCP JSON entry with `url` but no `type` is skipped as an error.
- Plugin MCP `headersHelper` runs with credential-like env vars stripped.
- Node deps auto-install needs `package-lock.json`/`npm-shrinkwrap.json` (yarn/pnpm lockfiles skipped), 60 s cap, no scripts.
- The docs' "own merge rules" for hooks/MCP/LSP across `plugin.json` + default files aren't spelled out in detail;
  keep hooks in one `hooks/hooks.json` and MCP in one `.mcp.json` to avoid ambiguity.
