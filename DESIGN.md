# Relay — Design (v1.1, implementation-ready)

**Status:** final synthesis, 2026-09-12, revised the same day after three independent refutations (hook mechanics, distributed behaviour, adoption). Base architecture = the "hosted edition" proposal (highest combined judge score, 113/120 vs 107/103/98), with the judges' required fixes applied and the best runner-up mechanisms grafted in (Appendix A lists every graft and its source). The v1.1 changes are listed in Appendix A under "Refutation fixes"; the ones that changed the shape of the client are: author-filtered git attribution, an append-only journal with race-free marker files, write-ahead outbox before every POST, no synchronous git or network on the edit path, a per-developer plugin repo, a status line, and prose-only assistant turns by default.
**Working name:** Relay. **Implementation dir:** `~/relay` (pnpm monorepo). **Plugin marketplace:** a second, tiny private repo `your-org/relay-plugin` published from this monorepo by CI (§2.3). **Org placeholder:** `exampleteam` (replace with the real GitHub org; nothing else depends on the name).
**Ground truth:** Claude Code hooks/plugins/MCP/platform contracts as verified on 2026-09-12 (`docs/research/*.md`). Local CLI is 2.1.236, Desktop engine is 2.1.260; the design uses only fields and flags present in both.

---

## 1. Vision and non-goals

Relay is an intelligence layer for a 4-developer shop where every developer works through Claude Code and two developers usually share one client project (same repo or two repos). It makes each developer's Claude aware of the rest of the team with zero manual effort: at session start Claude receives a compact digest of what teammates changed in *this developer's* area (contracts, files, decisions, blockers, messages); while working, it sees who is live on which branch and objective, is warned (or asked, or blocked) before editing a file a teammate is actively editing, and is told about a contract/API/schema change at the exact moment it touches a dependent file; when a session ends, a structured handoff is generated from the session's own event stream — never from transcripts — and routed to the teammates it affects. Everything is built on documented Claude Code primitives (command hooks with `hookSpecificOutput`, plugin auto-install after the workspace-trust dialog, a plugin-bundled stdio MCP server, a `statusLine`) plus one tiny hosted service on Vercel. Every hook fails open, the latency-critical hooks never touch the network or git, and a developer joins by opening the repo, running `claude`, and accepting the trust dialog.

**Non-goals (already solved elsewhere; Relay will not rebuild them):**

| We will NOT build | Because | What Relay does instead |
|---|---|---|
| A long-form, git-backed team knowledge base with hybrid search, wraps, quests, soul/culture documents (Egregore) | Egregore does this; it is not the gap | Structured handoffs/decisions live in the Relay DB and are queryable by MCP tools; a markdown export of handoffs is a one-line M2 add-on if the team wants an archive |
| Session transcript capture linked to commits, checkpoint refs, rewind (Entire CLI) | Entire does this; it is a record, not coordination | Relay records structured summaries only; `entire enable` can coexist (its hooks are independent) |
| Distribution of skills/rules/hooks/MCP config via a synced repo (TeamAI) | The native plugin marketplace + `.claude/settings.json` `extraKnownMarketplaces`/`enabledPlugins` already do this with one trust prompt | Relay *is* a plugin in a private marketplace |
| Single-user multi-session orchestration (Agent Teams, cross-session messaging, `claude agents`) | All scoped to one Anthropic account and one machine; never cross-developer | Relay crosses developers via the hub |
| File locks | Locks fight the developer; hooks cannot see IDE edits anyway | Relay informs: warn / ask / deny for Claude-driven edits, all advisory and time-limited |
| Channels push into idle sessions (research preview, needs `--dangerously-load-development-channels`) | Violates "no --dangerously flags" for core behaviour | Delivery at the next prompt / next tool call / next session start, plus a status line the human can see; Channels is an optional M2 add-on |
| Support for Cursor/Codex in v0 | Different hook contracts | M2 spike; the hub API is editor-agnostic by construction |

---

## 2. Architecture and components

### 2.1 Topology

```
 Dev A (Mac: CLI and/or Desktop app)                     Dev B (Mac)
 ┌─────────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ claude  (repo has .claude/settings.json:     │        │ claude                       │
 │   marketplace ref, enabledPlugins, statusLine)│        │  └ plugin relay@relay        │
 │  └ plugin relay@relay  (auto-cached from     │        │                              │
 │     ~/.claude/plugins/cache/relay/relay/…)   │        │                              │
 │     hooks/hooks.json → /bin/sh hook.sh ────┐ │        │                              │
 │     .mcp.json        → /bin/sh mcp.sh      │ │        │                              │
 │     team.json (hub url, team token, members)│ │        │                              │
 │                                            ▼ │        │                              │
 │  dist/hook.mjs   (zero-dep, single file)     │        │                              │
 │   sync path reads ONLY local files:          │        │                              │
 │   ~/.relay/cache/<repo>/snapshot.json ◄──────┼──┐     │  ~/.relay/…                  │
 │   ~/.relay/sessions/<sid>/{meta,events,marks}│  │     │                              │
 │   detached bg workers: WAL → POST → drain ───┼──┤     │                              │
 │  dist/mcp.mjs (stdio MCP, bundled SDK) ──────┼──┤     │                              │
 │  statusline.sh (10 s refresh, reads cache)   │  │     │                              │
 └─────────────────────────────────────────────┘  │     └──────────────┬───────────────┘
                                                  │ HTTPS (team token + X-Relay-Dev)    │
                                                  ▼                                     ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 │ Relay Hub — apps/api — Hono on Vercel Functions (Node 20, fluid compute)                │
 │  POST /v1/session/start  → {digest, snapshot}      GET /v1/snapshot (in-memory cache)   │
 │  POST /v1/events         → {snapshot, inbox[]}     POST /v1/session/end                 │
 │  POST /v1/depindex       GET /v1/query/*           POST /v1/{notify,claim,release,       │
 │                                                          decide,ack,handoff}            │
 │  lazy sweep on every request (≤1/min, conditional-update lock): presence decay,         │
 │  idle handoffs, auto-end, purge; waitUntil(): impact fan-out, handoff synthesis         │
 │  (Anthropic API, Haiku 4.5 by default, advisory-locked per session)                     │
 └───────────────────────────────┬─────────────────────────────────────────────────────────┘
                                 │ Drizzle ORM (one schema)
 ┌───────────────────────────────▼─────────────────────────────────────────────────────────┐
 │ Postgres: Neon (Vercel Marketplace) in prod   |   PGlite file in `pnpm dev` and demos   │
 └─────────────────────────────────────────────────────────────────────────────────────────┘

 GitHub (private): exampleteam/relay        = this monorepo (hub, sources, docs, tests)
                   your-org/relay-plugin = marketplace repo: .claude-plugin/marketplace.json + plugin/ (published by CI)
 Client repos: commit .claude/settings.json (marketplace + enabledPlugins + permissions + statusLine) and .relay.json (area map)
```

**Why hosted, not git-backed or daemon-based (decision):** presence and collision detection need sub-minute freshness and zero contention. A git store (proposal 1) is 20–60 s behind and cannot deliver "actively editing" warnings inside that window; a per-developer daemon (proposal 3) adds a process lifecycle (stale sockets, version skew after plugin updates) that a 4-person team would have to think about. A single Hono function that returns the whole team snapshot on every response makes the latency-critical hooks (PreToolUse, UserPromptSubmit) local file reads, correct even while Vercel is down.

**What the human sees (decision, v1.1):** hook `additionalContext` is injected as a system reminder with no visible transcript entry, and async-hook output is delivered to Claude on the next turn, not shown to the user. Relay therefore has exactly two human-visible surfaces: the collision permission prompt (§4.3) and a **status line** written into the project settings by `init-project` (`● priya app feat/currency 09:41 · 1 impact · 1 note`, §4.11) that re-renders every 10 s from the local snapshot at zero token cost. Everything else is context for Claude, and the demo script (§12) asks questions that make Claude use it.

### 2.2 Components

| Component | Where | Runtime | Responsibility |
|---|---|---|---|
| **Plugin** `relay` | `packages/plugin/` (published verbatim to `your-org/relay-plugin`, then copied into each dev's plugin cache) | none at install (no `package.json`, no `npm ci`) | hooks.json, `.mcp.json`, `team.json`, node-resolver shell scripts, `statusline.sh`, committed bundles `dist/hook.mjs` + `dist/mcp.mjs`, skills |
| **Hook script** `dist/hook.mjs` | built from `packages/hooks/` + `packages/core/` | Node ≥ 18 (uses `fetch`, `AbortSignal.timeout`; version verified once by `hook.sh`), zero runtime deps | verbs `session-start`, `prompt`, `pre-edit`, `pre-read`, `post-edit`, `post-git`, `task-created`, `task-completed`, `cwd`, `stop`, `session-end`, `mute`, `bg <job>` |
| **MCP server** `dist/mcp.mjs` | built from `packages/mcp/` + `packages/core/` (bundles `@modelcontextprotocol/sdk` via esbuild) | Node ≥ 18 | 13 tools (`mcp__plugin_relay_relay__<tool>`) that call the hub; read tools fall back to the local snapshot when the hub is down; resolves the *live* session id per call (§9.1) |
| **Core lib** | `packages/core/` | TS, no deps except `zod` for schemas | `.relay.json` loading + defaults, git helpers (async `execFile` with `AbortSignal.timeout`, author filters), repo identity, area/objective derivation, contract globs + symbol extraction, dependency index builder, secret redaction + prose stripping, journal (append-only + marker files), cache, outbox WAL, HTTP client with circuit breaker, protocol types shared with the API |
| **Hub** | `apps/api/` | Hono on Vercel Functions, Drizzle, Neon/PGlite | auth (dual-token grace), snapshot builder (in-memory per-repo cache), digest renderer, impact routing (change sets, debounce, retract), presence/claims, handoff synthesis, sweep |
| **Dashboard** (M2) | `apps/web/` | Next.js or static + polling | live board, manager view across projects |
| **Demo fixture** | `examples/demo-repo/` | git repo template | monorepo with `packages/contracts`, `apps/app`, `apps/dashboard`, `prisma/schema.prisma`, `.relay.json` |
| **Admin CLI** | `scripts/relay-admin.mjs` | Node | `init-project`, `doctor`, `demo up|down`, `token rotate`, `plugin publish` |

### 2.3 Repository layout (pnpm monorepo) and the plugin repo

```
~/relay/               git: exampleteam/relay (private). Hub + sources + docs + tests.
├── package.json                                 workspaces + scripts: build, dev, demo, test, test:hooks, lint, plugin:publish
├── pnpm-workspace.yaml                          packages: ["packages/core","packages/hooks","packages/mcp","apps/*"]
├── tsconfig.base.json  .gitignore (must NOT ignore packages/plugin/dist)  .github/workflows/{ci.yml,publish-plugin.yml}
├── packages/
│   ├── plugin/                                  ← THE PLUGIN. Self-contained; no package.json; committed build output.
│   │   ├── .claude-plugin/plugin.json           {"name":"relay","description":"Team presence, collision warnings, impact routing, handoffs"}
│   │   │                                        (no "version" field → commit-SHA versioning in the plugin repo)
│   │   ├── hooks/hooks.json                     exact content in §4.0
│   │   ├── .mcp.json                            {"mcpServers":{"relay":{"type":"stdio","command":"/bin/sh",
│   │   │                                          "args":["${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh"]}}}
│   │   ├── team.json                            {"hub":"https://relay-exampleteam.vercel.app","team":"exampleteam","token":"rt_…",
│   │   │                                         "marketplace":"your-org/relay-plugin",
│   │   │                                         "members":{"deepak":{"name":"Deepak","emails":["deepak@example.com"],"github":"…"},…}}
│   │   ├── scripts/hook.sh                      POSIX sh node resolver (verifies Node ≥ 18 once) → exec dist/hook.mjs "$@"   (§4.0)
│   │   ├── scripts/mcp.sh                       same resolver → exec dist/mcp.mjs
│   │   ├── scripts/guard-read.sh                ~6 ms guard for the PreToolUse Read hook (§4.4)
│   │   ├── scripts/statusline.sh                ~5 ms status line renderer (§4.11); copied to ~/.relay/statusline.sh at SessionStart
│   │   ├── dist/hook.mjs                        esbuild bundle of packages/hooks (committed, ~60 KB)
│   │   ├── dist/mcp.mjs                         esbuild bundle of packages/mcp + MCP SDK (committed, ~500 KB)
│   │   └── skills/{status,handoff,doctor,iam,mute}/SKILL.md   /relay:status /relay:handoff /relay:doctor /relay:iam <handle> /relay:mute <target>
│   ├── core/src/                                config.ts git.ts repo.ts area.ts objective.ts contracts.ts symbols.ts
│   │                                            depindex.ts redact.ts prose.ts journal.ts cache.ts outbox.ts http.ts protocol.ts ulid.ts
│   ├── hooks/src/                               main.ts (dispatch + crash guards + watchdog) verbs/*.ts  → build: esbuild → ../plugin/dist/hook.mjs
│   └── mcp/src/                                 server.ts tools/*.ts session.ts               → build: esbuild → ../plugin/dist/mcp.mjs
├── apps/
│   ├── api/                                     Hono app
│   │   ├── api/[[...route]].ts                  Vercel entry (hono/vercel)
│   │   ├── src/{app.ts,auth.ts,sweep.ts,snapshot.ts,digest.ts,impact.ts,presence.ts,handoff.ts,llm.ts}
│   │   ├── src/routes/{session.ts,events.ts,query.ts,actions.ts,depindex.ts,admin.ts}
│   │   ├── src/db/{schema.ts,client.ts,migrate.ts}   Drizzle; DATABASE_URL → @neondatabase/serverless, else PGlite
│   │   ├── scripts/dev.ts                       `pnpm dev`: @hono/node-server :8787 + PGlite (.data/) + seed
│   │   └── vercel.json                          {"functions":{"api/[[...route]].ts":{"maxDuration":60}}}   (no crons — the sweep is lazy, §6.2)
│   └── web/                                     M2
├── examples/demo-repo/                          template monorepo (see §12 M0)
├── scripts/relay-admin.mjs  scripts/demo.sh  scripts/publish-plugin.sh  scripts/smoke/*.json (hook stdin fixtures)
└── docs/research/                               existing notes (hooks.md, plugins-mcp.md, prior-art.md, platform.md)

your-org/relay-plugin (private; what client repos point at; a few hundred KB)
├── .claude-plugin/marketplace.json              {"name":"relay","owner":{"name":"Parallel Connect"},
│                                                 "plugins":[{"name":"relay","source":"./plugin","description":"…"}]}
└── plugin/                                      = packages/plugin/ of the monorepo, copied verbatim by scripts/publish-plugin.sh
```

**Build/versioning rules.** `pnpm build` writes the two bundles into `packages/plugin/dist/`; CI fails if `git diff --exit-code packages/plugin/dist` is dirty after build, so the committed bundles always match the sources. `plugin.json` never gets a `version` field (a forgotten bump would stop updates). The plugin directory contains no `package.json`, so Claude Code's plugin installer runs no `npm ci` and the first session needs no network beyond the marketplace clone.

**Why a separate plugin repo (decision, v1.1).** Only relative-path plugins inside the registered marketplace repo auto-install for teammates, so the marketplace repo *is* what every developer clones and pulls in the background. If that were this monorepo, every dev would clone the hub, docs and tests, the committed 560 KB of bundles would make the clone grow with every build, and every hub-only commit would be a plugin update prompt. `scripts/publish-plugin.sh` (run by `.github/workflows/publish-plugin.yml` on pushes to `main` that touch `packages/plugin/**`, and manually via `pnpm plugin:publish`) copies `packages/plugin/` to `relay-plugin/plugin/`, commits with the monorepo SHA in the message, and pushes. A plugin update therefore corresponds to a plugin change, and the developer-side clone stays a few hundred KB.

**Runtime requirements on a dev machine.** git, Node ≥ 18 anywhere on disk (PATH, Homebrew, nvm, volta, fnm — resolved and version-checked by `hook.sh`), Claude Code ≥ 2.1.224, and *one* per-developer git-auth prerequisite for the private plugin repo (§3.2). No global installs, no daemons, no tokens to paste.

---

## 3. Onboarding

### 3.1 Admin (Deepak), once for the shop (~25 min)

```bash
# 0. Push this monorepo and create the plugin marketplace repo; give the 4 devs read access to relay-plugin
cd "~/relay"
pnpm install && pnpm build && pnpm test
gh repo create exampleteam/relay --private --source=. --push
gh repo create your-org/relay-plugin --private
for u in <gh-login-1> <gh-login-2> <gh-login-3>; do gh api -X PUT repos/your-org/relay-plugin/collaborators/$u -f permission=pull; done

# 1. Deploy the hub (Vercel account already exists; see the plan note below)
cd apps/api
vercel link                                   # new project "relay"
vercel integration add neon                   # Vercel Marketplace Postgres; injects DATABASE_URL
vercel env add RELAY_TEAM_TOKEN production    # paste output of: node ../../scripts/relay-admin.mjs token new   (48 random chars)
vercel env add RELAY_ADMIN_TOKEN production   # another random string; used only by the admin CLI
vercel env add ANTHROPIC_API_KEY production   # OPTIONAL: enables LLM handoff synthesis (§8). Without it, heuristic handoffs.
pnpm db:push                                  # drizzle-kit push against DATABASE_URL (pulled with `vercel env pull`)
vercel deploy --prod                          # → https://relay-exampleteam.vercel.app

# 2. Fill packages/plugin/team.json (hub URL, the same team token, members with emails/github logins), commit, publish the plugin
node scripts/relay-admin.mjs team set --hub https://relay-exampleteam.vercel.app --token rt_… \
  --marketplace your-org/relay-plugin \
  --member deepak=deepak@example.com:deepak-gh --member priya=priya@example.com:priya-gh …
git commit -am "relay: team config" && git push          # CI publishes packages/plugin → relay-plugin (or: pnpm plugin:publish)

# 3. Per client repo (2 min each; repeat in BOTH repos of a two-repo project with the same --project id)
cd ~/code/acme-app
node "~/relay/scripts/relay-admin.mjs" init-project --project acme-portal \
  --area app=apps/app/** --area dashboard=apps/dashboard/** --owner app=priya --owner dashboard=deepak
#   writes/merges .claude/settings.json:
#     {"extraKnownMarketplaces":{"relay":{"source":{"source":"github","repo":"your-org/relay-plugin"},"autoUpdate":true}},
#      "enabledPlugins":{"relay@relay":true},
#      "permissions":{"allow":["mcp__plugin_relay_relay","mcp__plugin_relay_relay__*"]},   # both rule forms; M0 verifies which matches
#      "statusLine":{"type":"command","command":"/bin/sh -c 'f=\"${RELAY_HOME:-$HOME/.relay}/statusline.sh\"; [ -r \"$f\" ] && exec /bin/sh \"$f\" || true'","refreshInterval":10}}
#   writes .relay.json (§5.4) with areas inferred from apps/*, packages/*, src/* when no --area is given
#   --local writes .claude/settings.local.json instead (client-owned repos, see below); --no-statusline skips the statusLine key
git add .claude/settings.json .relay.json && git commit -m "Add Relay" && git push
```

Nothing in a client repo contains a secret: the hub URL and team token live only in the private plugin repo. `.relay.json` contains an area map and teammate handles (see open question 3 if a client would object to that).

**Marketplace source (decision, v1.1):** the `{"source":"github","repo":"your-org/relay-plugin"}` shorthand is used instead of a per-repo SSH or HTTPS URL because git auth is per developer, not per repo: the shorthand clones over SSH by default and over HTTPS for a developer who exports `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`, so each dev's own credential setup applies. `init-project` has no `--ssh/--https` flag any more.

**Client-owned repos (rule, v1.1):** repos that live in a *client's* GitHub org get `init-project --local` by default (writes `.claude/settings.local.json`, gitignored, plus `.relay.json`; each of our developers runs that one command once per clone — it is the only per-project step Relay ever asks of a developer). Repos in our own org get the committed variant. If the committed variant is used in a client repo anyway, a client engineer who opens it in Claude Code and accepts trust will see Claude Code try to clone `your-org/relay-plugin`, fail (no access) and report the `relay@relay` plugin as not installed at every session start — an operational annoyance for them, not a security problem.

**Vercel plan (v1.1):** the design assumes Vercel **Pro** (one seat, ≈ $20/month) because Hobby is non-commercial under Vercel's fair-use terms and client delivery is commercial; nothing in the code depends on Pro (no crons — the sweep is lazy, §6.2; `maxDuration: 60` on the single function for the handoff synthesis in `waitUntil`). Neon: the design assumes the Vercel-Marketplace Neon **Launch** tier with compute auto-suspend **off** (≈ $19/month) so the first request after a quiet stretch does not pay a 0.5–1.5 s compute resume; on the free tier everything still works, but the budgets in §4.2 and the two-failure breaker rule in §4.0 exist precisely to absorb those resumes. Both are open question 6.

### 3.2 Developer (2 steps, honestly)

1. **Once per machine:** make sure `git clone git@github.com:your-org/relay-plugin.git` would succeed non-interactively — an SSH key registered on GitHub and loaded in `ssh-agent`, **or** `gh auth setup-git` plus `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the shell profile. (Already true for most; it is the same prerequisite as cloning any private repo. Desktop-launched sessions inherit the launchd `ssh-agent`, so a passphrase-protected key must have been used once in a terminal since the last reboot.)
2. `cd ~/code/acme-app && git pull && claude` → accept the **workspace trust dialog** (the one install prompt). Claude Code registers the `relay` marketplace from `.claude/settings.json` with no further prompt and fetches the relative-path plugin into `~/.claude/plugins/cache` at session start (documented behaviour for relative-path plugins; external-source plugins would not auto-install). Whether `hooks/hooks.json` and `.mcp.json` become live in that same session or only in the next one is not documented; it is the **first M0 experiment** (Appendix B.1) and the developer note will say either "you are in" or "run `/exit` and `claude` once more" — never "timing is not documented". The SessionStart hook resolves identity from `git config user.email` (§3.3) and prints the first digest; the status line shows `relay ●`.

If nothing appears (no status line segment, no `<relay-digest>` when asked "what does Relay say?"), the developer note gives two commands that need no plugin: `claude plugin marketplace add your-org/relay-plugin && claude plugin install relay@relay`, whose error output names the failing step (usually git auth); `/relay:doctor` exists only after the plugin is installed. If the digest says `Relay identity for this session is unknown`, type `/relay:iam <handle>` once (or let Claude call `whoami` with `iam`).

### 3.3 Identity resolution (client-side, cached, no secrets)

Evaluated once per session by `hook.mjs` and by `mcp.mjs`, in order; the first hit wins and is cached in `~/.relay/identity.json` `{dev, source, at}` (re-evaluated when `git config user.email` changes or every 24 h):

1. `RELAY_DEV` env var (demo / two identities on one machine).
2. `~/.relay/identity.json` written by `/relay:iam <handle>` or the `whoami` tool with `iam: "<handle>"`.
3. `git config user.email` (from the session `cwd`) matched case-insensitively against `team.json.members[*].emails`.
4. GitHub noreply pattern `<id>+<login>@users.noreply.github.com` matched against `members[*].github`.
5. Local part of the git email, if it equals a member handle.
6. `$USER`, if it equals a member handle.
7. Otherwise a **per-machine placeholder** `unknown-<sha1(hostname + $USER).slice(0,6)>` (v1.1; a single shared `unknown` would merge two new developers into one hub identity and classify their collisions as SAME_DEV). The session is tracked under the placeholder (host shown), and the digest's first line is the fact *"Relay identity for this session is unknown (git email x@y is not in the team list). The whoami tool accepts iam=<handle>; /relay:iam <handle> sets it for this machine."* When `whoami iam=<handle>` is called, the hub merges the placeholder's sessions, heat and impacts into the real handle (`POST /v1/session/start` carries `placeholder` so the merge is exact).

Authentication to the hub is the shared **team token** from `team.json` (`Authorization: Bearer`), and the developer handle is self-declared in `X-Relay-Dev`. Trust model: anyone who can clone the private plugin repo is a teammate; teammates could impersonate each other. This is accepted for a 4-person shop (open question 2 offers per-dev invite tokens as the alternative).

**Rotation (v1.1, no longer routed through plugin updates):** `node scripts/relay-admin.mjs token rotate` → sets `RELAY_TEAM_TOKEN_PREV` to the current value and `RELAY_TEAM_TOKEN` to the new one on Vercel (both accepted for 14 days; requests that authenticate with the previous token get an `X-Relay-Warn: token-rotated` header, which the client turns into one digest line), writes the new value into `team.json`, commits, and publishes the plugin. A developer whose plugin has not updated within 14 days starts getting `401`, which the client treats as a configuration error (§4.0 rule 5): one digest line *"Relay plugin needs an update: `claude plugin marketplace update relay && claude plugin update relay@relay`"* and a 10-minute breaker, never an outbox backlog.

### 3.4 How updates reach teammates

- `plugin.json` has no version → every commit to `your-org/relay-plugin` is a new plugin version, and commits there happen only when `packages/plugin/**` changes (§2.3).
- `extraKnownMarketplaces.relay.autoUpdate: true` is written by `init-project`. The docs describe this flag in managed settings and default third-party marketplaces to auto-update OFF; whether a *project* `.claude/settings.json` flag is honoured is **unverified** and is M0 experiment 3 (Appendix B.3). If it is not honoured, the developer note documents the one-time toggle `/plugin` → Marketplaces → relay → auto-update, and Relay never *depends* on background updates: token rotation has a 14-day dual-token grace (§3.3), and protocol changes are guarded by `minClient`/`426`.
- **Behind-detection is client-side (v1.1):** the `bg session-start` worker compares the cached plugin commit (`basename(CLAUDE_PLUGIN_ROOT)` is the version directory, a commit SHA for relative-path plugins; sent to the hub as `X-Relay-Plugin` for `/relay:doctor` and the M2 dashboard) with `git -C <marketplace clone> ls-remote origin HEAD` (the clone Claude Code keeps for the registered marketplace, Appendix B.15; fallback: the URL derived from `team.json.marketplace`; ≤ 1 s, cached 24 h in `~/.relay/plugin-remote.json`) and writes *"Relay plugin is N commits behind; `claude plugin marketplace update relay && claude plugin update relay@relay` updates it"* into the next digest when they differ. `401` and `426` print the same two commands.
- Background HTTPS pulls of private marketplaces run with git credential helpers disabled; SSH is unaffected. Developers on HTTPS should also set `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` (in the developer note) so a failed background pull does not unregister the marketplace, and rely on the manual command pair.
- After an update, hooks and the MCP server keep using the old `${CLAUDE_PLUGIN_ROOT}` until `/reload-plugins` or the next session. Relay stores no state under `CLAUDE_PLUGIN_ROOT`; all state is in `~/.relay/` (overridable with `RELAY_HOME`).
- Hub deploys are independent (`vercel deploy --prod`); the protocol carries `v: 1` and the hub answers `426` with a message for clients older than its minimum, which the hook prints once as a digest line.

---

## 4. Hook-by-hook specification

### 4.0 Wiring, shared runtime rules, and the node resolver

`packages/plugin/hooks/hooks.json` (exact):

```json
{
  "description": "Relay: team presence, collision warnings, contract impact routing, automatic handoffs",
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "session-start"],
                     "timeout": 8, "statusMessage": "Relay: loading team digest" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "prompt"], "timeout": 5 } ] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "pre-edit"], "timeout": 3 } ] },
      { "matcher": "Read",
        "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/guard-read.sh"], "timeout": 2 } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "post-edit"], "async": true } ] },
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "if": "Bash(git *)", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "post-git"], "async": true } ] }
    ],
    "TaskCreated": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "task-created"], "timeout": 2 } ] }
    ],
    "TaskCompleted": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "task-completed"], "timeout": 2 } ] }
    ],
    "CwdChanged": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "cwd"], "timeout": 3 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "stop"], "async": true } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "/bin/sh", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "session-end"] } ] }
    ]
  }
}
```

Notes on the wiring: exec form (`command` + `args`) so `${CLAUDE_PLUGIN_ROOT}` substitutes without shell quoting and no exec bit is needed on cached files; `/bin/sh` is an absolute path because Desktop-launched sessions can have a minimal `PATH` (v1.1); matchers contain only `[A-Za-z|]` so they are exact-name lists, not regexes (`Edit.*` would also match `NotebookEdit` — irrelevant here since we list it); **SessionStart has no matcher (v1.1)** so all five sources fire — `startup|resume|clear|compact|fork` — and the verb branches on `source` (a `/fork` or `--fork-session` session would otherwise never get a journal); `if` is only used on a tool event (it never runs on other events); `async: true` only where no decision is needed (async hooks cannot decide, and their `additionalContext` lands on the next turn — that is the intended delivery for post-edit/post-git); task capture uses the documented **`TaskCreated`/`TaskCompleted` events** (`task_id`, `task_subject`; no matcher) instead of guessing the `TaskCreate|TaskUpdate` tool-input shape (v1.1); `CwdChanged` keeps the journal's repo root honest after `/cd` (v1.1). No hook uses `once`, `prompt`/`agent` types, `updatedInput`, or `decision: "block"`.

`packages/plugin/scripts/hook.sh` (POSIX sh; Desktop-launched sessions may have no login-shell PATH):

```sh
#!/bin/sh
# usage: hook.sh <verb>   stdin: Claude Code hook JSON.  Every path this script controls exits 0.
D="${RELAY_HOME:-$HOME/.relay}"; [ -d "$D" ] || mkdir -p "$D" 2>/dev/null
v18() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' >/dev/null 2>&1; }
N=""
if [ -n "$RELAY_NODE" ] && v18 "$RELAY_NODE"; then N="$RELAY_NODE"
elif [ -r "$D/node-path" ]; then N=$(cat "$D/node-path" 2>/dev/null); [ -x "$N" ] || N=""; fi
if [ -z "$N" ]; then
  IFS='
'
  for c in node /opt/homebrew/bin/node /usr/local/bin/node \
           $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node \
                   "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -rV); do
    p=$(command -v "$c" 2>/dev/null) || continue
    v18 "$p" && N="$p" && break            # skips Node < 18 (no global fetch / AbortSignal.timeout) — v1.1
  done
  [ -n "$N" ] && printf '%s' "$N" > "$D/node-path" 2>/dev/null
fi
[ -z "$N" ] && { echo "relay: node >= 18 not found" >> "$D/last-error" 2>/dev/null; exit 0; }
exec "$N" --no-warnings "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/dist/hook.mjs" "$@"
exit 0
```

The version probe costs one extra ~40 ms Node start the first time only; the cached `node-path` is trusted afterwards (re-resolved when it stops being executable). `mcp.sh` is identical except for the bundle name.

`packages/plugin/scripts/guard-read.sh` (spawns Node only when just-in-time impact notes are pending **for this session** — v1.1; the marker used to be one global file that two repos' refreshes would clear for each other):

```sh
#!/bin/sh
D="${RELAY_HOME:-$HOME/.relay}"
[ -n "$CLAUDE_CODE_SESSION_ID" ] && [ -s "$D/sessions/$CLAUDE_CODE_SESSION_ID/pending" ] || exit 0
exec /bin/sh "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/hook.sh" pre-read
exit 0
```

Rules every verb of `dist/hook.mjs` obeys:

1. **Watchdog, and nothing blocks it (v1.1).** `main.ts` first registers `process.on('uncaughtException' | 'unhandledRejection', () => process.exit(0))`, then arms `setTimeout(() => process.exit(0), DEADLINE)` (not unref'd), then runs `main()` inside `try/catch/finally → process.exit(0)`. DEADLINE is always below the declared hook `timeout` (§4.x tables). The watchdog only proves a deadline for a process whose event loop is free, so **Relay never calls `spawnSync`/`execSync`**: git runs through async `execFile` with `{timeout}`, HTTP through `fetch` with `AbortSignal.timeout`, and on every synchronous hook Σ(child timeouts + fetch budgets) < DEADLINE. Expiry = print nothing, exit 0 = fail open, proven by the script.
2. **Exit code.** Always 0 from every path the script controls (rule 1 covers exceptions; `hook.sh` exits 0 when Node is missing or too old). Deny/ask are expressed only as JSON (`hookSpecificOutput.permissionDecision`). Exit 2 is never used (on `TaskCreated` it would even roll the task back). The one remaining non-zero path — the Node binary itself failing to start on a corrupt bundle — shows a single `hook error` line that `/relay:doctor` explains.
3. **Stdout.** Either nothing, or exactly one JSON object built with `JSON.stringify` (never string concatenation). Total ≤ 9,000 chars (Claude Code spills > 10,000-char outputs to a file that Claude must Read); PreToolUse context is capped at 4,000 chars (§4.3).
4. **Stderr.** Debug only (goes to Claude Code's debug log on exit 0). `RELAY_DEBUG=1` also appends to `~/.relay/log/relay.log`.
5. **Network and the circuit breaker (v1.1).** The only synchronous fetches in the whole plugin are SessionStart's `POST /v1/session/start` (3 s budget, §4.1) and the throttled snapshot refresh in `prompt` (§4.2); PreToolUse never fetches. Background workers (§4.12) POST with a 3 s budget (5 s for `session-end`). A *sync-path* timeout never opens the breaker — it keeps the cached snapshot and writes `refresh-wanted` for the next worker. A *worker* failure increments `down-count`; two consecutive failures write `down-until = now + 60 s` (every verb checks it first and skips the network while it is in the future); any success resets the count. `401`, `426` and `413` are configuration errors, not outages: `down-until = now + 10 min`, `config-error.json {status, message}` (rendered as one digest line and by `/relay:doctor`), and the body is **not** enqueued.
6. **Outbox = write-ahead log (v1.1).** Before every POST the body is written to `outbox/<ulid>.json {sessionId, at, kind, body}`; it is deleted on 2xx. A hook killed mid-request therefore leaves its body behind instead of losing it. Drain (any worker, oldest first, cap 200 per run): skip entries younger than 30 s (may still be in flight), drop `prompt`/`edit`/`turn_end`/presence-only entries older than 24 h and everything older than 7 days, send the rest with `replay: true` and their **own** `sessionId` and `at` (the hub never revives a session from a replay, §10.4).
7. **Git.** `execFile('git', ['-C', cwd, ...], {timeout, env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'}})`, where `cwd` is the hook's stdin `cwd` (follows worktrees; `CLAUDE_PROJECT_DIR` does not and is never used for paths). Synchronous verbs may only run `rev-parse`-class commands (`--show-toplevel`, `--abbrev-ref HEAD`, `HEAD`, `--git-dir`; ≤ 50 ms each, 300 ms timeout, and only when the journal is missing or stale). `status`, `diff`, `log`, `grep`, `merge-base`, `hash-object`, `show` run only in async hooks and background workers. **Commit attribution is always author-filtered (v1.1):** `git log --author=<regex of this dev's emails> --no-merges`, never a raw range — a `git pull`, `merge`, `rebase` or `checkout` moves HEAD by other people's commits and must not be reported as this developer's change.
8. **Snapshot cache.** `~/.relay/cache/<repoKey>/snapshot.json`, `repoKey = sha1(repoSlug).slice(0,12)`, written atomically (`tmp` + `rename`) and **only if the incoming `serverTime` ≥ the cached one** (a slow response must not overwrite a fresher snapshot). The same write renders `cache/<repoKey>/statusline.txt` (§4.11) and `sessions/<sid>/pending` (§4.4). Read by the sync hooks in 1–2 ms.
9. **Journal = per-session directory, append-only + marker files (v1.1).** `~/.relay/sessions/<session_id>/` holds `meta.json` (identity, repo, `repoRoot`, `cwd`, branch, worktree, `startSha`, `lastStopSha`, client, pid, `startedAt`; written by `session-start` or lazily, rewritten only under the lock when cwd/branch change), `events.jsonl` (one line ≤ 4 KB per hook via `O_APPEND` — `edit`, `prompt`, `objective`, `contract`, `commit`, `task`, `turn`, `cwd`, `end`; readers fold it in ~1 ms; a worker rotates it by `rename` and folds into `fold.json` under the lock when it passes 64 KB), `marks/` (files created with `fs.openSync(p, 'wx')`, which is atomic and race-free: `seen.<notificationId>`, `jit.<changeSetId>`, `noted.<sha1(path|dev)>`, `asked.<sha1(path|dev)>`, `snooze.<sha1(path|dev)>` whose content is the expiry, `stop.<promptId>`, `ended`), `pending` (§4.4), `draft.json` (last heuristic handoff). The lock is `mkdir sessions/<sid>/.lock` with a 50 ms spin and a 300 ms give-up (then proceed lock-free — fail open). No hook ever read-modify-writes a shared JSON file without the lock, and no dedup or snooze decision ever depends on such a file — marks decide. (Hooks for one session run in parallel: parallel tool calls, async post-edit overlapping the next pre-edit, subagents; a rewritten single JSON file would lose updates and repeat notices.)
10. **Self-healing journal (v1.1).** Every verb that finds `meta.json` missing, or stdin `cwd` outside `meta.repoRoot`, (re)creates it from stdin plus three `rev-parse` calls (≤ 100 ms total, once). This covers `fork` sessions, a SessionStart that was killed by its timeout, Node found later than the first session, `/cd` into another repo, and worktree entry mid-session.
11. **Liveness file (v1.1).** Every verb writes `~/.relay/current/<CLAUDE_PID>.json {sessionId, cwd, repoKey, dev, at, statusline}` (tmp + rename). It is how `mcp.mjs` learns the *live* session id (`process.ppid`, §9.1), how `statusline.sh` finds its line, and what the local liveness sweep uses: any worker that finds a `current/<pid>.json` whose pid fails `process.kill(pid, 0)` and whose session has no `marks/ended` POSTs `/v1/session/end {reason: "crash"}` for it and writes the mark — crashed or Ctrl-C'd sessions are ended in seconds, not by the hub's 2 h sweep.
12. **Recursion guard.** If `RELAY_DISABLE=1` is set, every verb exits 0 immediately (used if a background `claude -p` is ever added).
13. **Subagents.** Tool hooks also fire inside subagents (`agent_id` present); they use the same session directory. Inside a subagent Relay never emits `ask` (context only — a subagent has nobody to answer) and never sets `sessionTitle`.
14. **Interactivity (v1.1).** `ask` is downgraded to context-only when `permission_mode` is `dontAsk` or `bypassPermissions` (a `dontAsk` session auto-denies prompts and a headless `claude -p` run has no prompt at all, so an `ask` would become a hard block — the opposite of fail-open), when `agent_id` is present, or when `RELAY_INTERACTIVE=0`. `deny` (hard claims, `collision.hot: deny`) is unaffected: it is the explicitly configured block.
15. **Phrasing (v1.1).** Every injected string is a factual statement with an absolute timestamp (`at=2026-09-12T09:41Z`), never an imperative ("priya (feat/currency) is editing this file; the notify tool reaches her at her next prompt" — not "Coordinate first"). Out-of-band imperatives can trip prompt-injection defences and get quoted to the user instead of used. How-to guidance lives in the MCP server `instructions` and the skills, not in hook context.
16. **Time (v1.1).** The hub stamps `serverAt` on everything it stores and `serverTime` on every snapshot; the client records `fetchedAt` (its own clock) when it writes the cache. Ages are `(serverTime − item.serverAt) + (Date.now() − fetchedAt)` — two same-clock differences — never a server timestamp compared with the local wall clock, so a laptop whose clock is minutes off cannot suppress a HOT verdict or manufacture one.

Stdin fields used across verbs (all in the verified contract; every read is defensive): `session_id`, `prompt_id` (v2.1.196+; absent before the first prompt), `cwd`, `hook_event_name`, `permission_mode` (optional — not carried on every event; absent → treated as `default`), `transcript_path` (never read), `source` (SessionStart), `model` (SessionStart only), `prompt` (UserPromptSubmit), `tool_name`, `tool_input`, `tool_use_id`, `tool_response` (PostToolUse), `stop_hook_active`, `last_assistant_message` (Stop), `reason` (SessionEnd: `clear|resume|logout|prompt_input_exit|other`), `task_id`, `task_subject` (TaskCreated/TaskCompleted), `old_cwd`, `new_cwd` (CwdChanged), `agent_id` (inside subagents). Env used: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_ENV_FILE` (SessionStart and CwdChanged), `CLAUDE_CODE_ENTRYPOINT` (`claude-desktop` → client=desktop), `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `RELAY_HOME`, `RELAY_DEV`, `RELAY_HUB` and `RELAY_TOKEN` (override `team.json`; used by the demo and by CI), `RELAY_NODE`, `RELAY_DEBUG`, `RELAY_DISABLE`, `RELAY_INTERACTIVE`, `RELAY_SNAPSHOT_TTL_MS`.

### 4.1 SessionStart — no matcher (`startup|resume|clear|compact|fork`) — verb `session-start` — timeout 8 s — DEADLINE 3,500 ms (compact: 800 ms)

**Reads:** `session_id`, `source`, `cwd`, `model`, `permission_mode`; env `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`, `CLAUDE_ENV_FILE`.

**Does (startup | resume | clear | fork):**
1. Identity (§3.3). Repo: `git -C cwd rev-parse --show-toplevel`, `--git-dir` vs `--git-common-dir` (worktree), `remote get-url origin` → normalized slug (`git@github.com:acme/app.git` and `https://github.com/acme/app` → `github.com/acme/app`; no remote → `local/<basename>`; `.relay.json.repo` overrides). Branch: `rev-parse --abbrev-ref HEAD`. `startSha`: `rev-parse HEAD` (kept from the previous `meta.json` on `resume` if the branch is unchanged; `fork` behaves like `startup`). `git config user.email` → `gitEmail` (also used as an author filter, rule 7). Loads `.relay.json` (§5.4) and hashes it. All git calls async and issued in parallel (`Promise.all`), 300 ms timeout each, so the phase costs ≤ 300 ms worst case and ≤ 80 ms warm; with the 3,000 ms POST that stays under the 3,500 ms DEADLINE (rule 1).
2. Journal: create/refresh `sessions/<session_id>/meta.json`; write `current/<pid>.json`; copy `scripts/statusline.sh` to `~/.relay/statusline.sh` when its hash changed; write `~/.relay/statusline-chain` from `~/.claude/settings.json → statusLine.command` when the user has their own status line and it is not Relay's (§4.11).
3. Unless the breaker is open: `POST /v1/session/start` (budget 3,000 ms — covers a Vercel cold start) with `{v:1, session:{id, source, client, host, cwd, repo:{slug, root, config, configHash}, branch, worktree, startSha, model}, mode: "full" | "delta", since?, recentShas:[last 20 SHAs on the branch], identityHint:{gitEmail, placeholder?}}`. `mode: "delta"` (v1.1) is sent on `resume`/`fork` when the previous `meta.lastStopAt` is < 12 h old: the hub returns a ≤ 2,000-char digest of what changed *since then* (a resumed session already carries the earlier full digest in its transcript; ten resumes a day must not add ten 6 KB digests). Response `{digest, snapshot, minClient?, warn?}` → write snapshot cache + `cache/<repoKey>/digest.md`; derive `pending` and `statusline.txt`.
4. Print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<relay-digest …>…</relay-digest>","sessionTitle":"<area>: <objective>"}}` — `sessionTitle` only on `startup|resume|fork` and only when an objective is already known. Digest format and 6,000-char cap in §9.3.
5. Append `export RELAY_DEV=<handle>` and `export RELAY_PROJECT=<project>` to `$CLAUDE_ENV_FILE` (so `Bash` commands and `/relay:doctor` see them; MCP gets identity via the same lib).
6. Spawn the detached background worker `bg session-start` (§4.12): local liveness sweep (rule 11); outbox drain; `git status --porcelain` for the first presence post; dependency index rebuild + upload if `HEAD` changed or the index is > 24 h old (§7.4); **author-filtered** contract backfill — `git log --author=<emails> --no-merges --format=%H%x09%ae%x09%s <lastReportedSha[branch]>..HEAD`, cap 50 commits, through the same pipeline as `post-git` (catches commits made outside Claude); ancestry/merged computation for the snapshot (§4.12); plugin-behind check (§3.4); journal fold if needed.

**Does (compact):** no network. Reads the snapshot cache and journal, prints a ≤ 1,500-char re-injection (team-now lines, unacked change sets one line each, current objective, the tools line) because SessionStart context does not survive compaction and `source: "compact"` is the documented re-injection point.

**Latency:** warm hub 250–450 ms; cold start up to ~1.2 s; hard cap 3.5 s. Compact: ~80 ms.

**Fail-open:** breaker open, timeout, non-2xx, or any exception → print the cached `digest.md` wrapped with `freshness="cached <age>"` if it exists, else the single line `<relay-digest offline="true" at="…">Relay hub unreachable at <time>; presence and impact notes are unavailable until it returns; the status/handoffs tools still answer from cache.</relay-digest>`; exit 0. Node missing → `hook.sh` exits 0 silently. If this hook is killed by its 8 s timeout, later verbs self-heal the journal (rule 10). Identity unknown → the first digest line is the fact from §3.3 step 7.

### 4.2 UserPromptSubmit — no matcher — verb `prompt` — timeout 5 s — DEADLINE 2,000 ms

**Reads:** `prompt`, `prompt_id`, `session_id`, `cwd`, `permission_mode`.

**Does (synchronous, cache-first, no git — v1.1):**
1. Append `{t:"prompt", at, promptId, len, sha1}` (text is never stored unless `privacy.send_prompts: true`, then ≤ 300 chars redacted); run the objective rule (§5.1) locally and append an `objective` line when it changes. Branch refresh and `git status` are the worker's job (step 4); nothing on this path waits for git.
2. Refresh policy: if the snapshot cache is older than `RELAY_SNAPSHOT_TTL_MS` (60 s; the demo sets 15 s) and the breaker is closed: `GET /v1/snapshot?repo=<slug>` with an **800 ms** budget, or **1,500 ms** when the cache is older than 5 min (the first prompt after a pause is the one most likely to hit a Vercel cold start or a Neon resume). A timeout keeps the cached copy, writes `refresh-wanted`, and does **not** open the breaker (rule 5). Otherwise no network.
3. From the snapshot: undelivered `inbox[]` items for me (no `marks/seen.<id>`) plus `high`-priority change sets (§7.5) without a `marks/jit.<cs>`/`seen.<cs>` mark. For each, create the mark with `wx` *before* printing (a parallel hook that loses the race skips the item). If any → print `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<relay-inbox at=\"2026-09-12T09:41:07Z\">\n- IMPACT cs_01J… (imp_01J…): priya changed packages/contracts/src/billing.ts at 09:37Z (feat/currency, committed a1b2c3d, not in your branch): Invoice.total → amountDue; createInvoice(input, currency). Dependents in your area: apps/dashboard/src/invoices.tsx\n- NOTE from priya at 09:40Z: keep `status` — dashboard already consumes it\n</relay-inbox>"}` (≤ 1,500 chars; each item once per session). If M0 shows that `systemMessage` is displayed to the user on this event (Appendix B.11), the same object also carries `"systemMessage": "Relay: 1 impact, 1 note (in Claude's context)"` so the human sees that something arrived. Never `decision: "block"`.
4. Spawn the detached worker `bg prompt` (§4.12): branch refresh, `git status --porcelain` → dirty paths (cap 200; lockfiles, `dist/`, `node_modules/`, `.gitignore`-adjacent generated patterns excluded), WAL + `POST /v1/events` with `{session presence fields, events:[{type:"prompt", promptId, objective, objectiveSource, dirty:[…], branch}], delivered:[ids printed in step 3]}` (budget 3 s), snapshot → cache, chores.

**Latency:** 40–60 ms typical (one Node start + file reads); ≤ 0.9 s when a refresh is due; ≤ 1.6 s once after a > 5 min pause.

**Fail-open:** any failure → no stdout, exit 0; the prompt reaches Claude untouched. A UserPromptSubmit timeout is documented to let the prompt through without context. Worst case while the hub is down: one bounded stall per TTL, then the worker's two failures open the breaker and the sync path skips the network.

### 4.3 PreToolUse — matcher `Edit|Write|MultiEdit|NotebookEdit` — verb `pre-edit` — timeout 3 s — DEADLINE 900 ms

**Reads:** `tool_name`, `tool_input.file_path` (or `tool_input.notebook_path`; `tool_input.edits[]` is ignored — MultiEdit carries one `file_path`), `tool_use_id`, `cwd`, `session_id`, `permission_mode`, `agent_id`.

**Does (no network, no git — v1.1):**
1. Normalize to a repo-relative POSIX path using `meta.repoRoot` (rule 10 heals a missing/stale meta with three `rev-parse` calls, once). Paths outside the repo → exit 0 silently. Muted targets (`~/.relay/mute/<repoKey>.json`, written by `/relay:mute`) → exit 0.
2. Read the snapshot. If `fetchedAt` is older than 120 s, the breaker is closed and no `refresh-wanted` is younger than 10 s: write `refresh-wanted` and spawn `bg refresh` (detached, not awaited). The decision below always uses the copy on disk.
3. Severity (§6.4) from `snapshot.sessions`, `snapshot.heat` (own sessions included, tagged `mine`), `snapshot.claims`, `cache/<repoKey>/ancestry.json` (computed by workers: which heat `headSha`s/commit SHAs are ancestors of my HEAD and which impact blobs match my `HEAD:<path>`, §7.2), the session marks, and the staleness ladder (§6.5) with ages per rule 16.
4. Just-in-time impact: change sets (§7.5) whose `dependents` contain the path or one of its enclosing area keys and that have no `marks/jit.<cs>`; take the top 2 by priority then recency; build one note per change set (who, when, branch, status, files with symbols, the top hunk ≤ 1,500 chars, ids); if `ancestry.json` says the change set is already in my branch the note says so and the client queues an auto-ack. Hard cap 4,000 chars for the whole context. Create `jit.<cs>` with `wx` before printing (EEXIST → a parallel hook already delivered it → skip).
5. Output, by severity (all under `hookSpecificOutput` with `"hookEventName":"PreToolUse"`; never emits `"allow"`, so Claude Code's normal permission flow is untouched):
   - none, no JIT → no stdout, exit 0.
   - JIT only / WARM / SEQUENTIAL / SAME_DEV → `{"additionalContext":"Relay at 09:41:20Z: …"}` (facts, per rule 15).
   - HOT under policy `ask` (default), interactive per rule 14: if `marks/asked.<sha1(path|dev)>` exists and is < 2 min old, or `marks/snooze.<…>` is unexpired → context only. Otherwise create `asked.<…>` (content: `tool_use_id`, `at`) and print `{"permissionDecision":"ask","permissionDecisionReason":"Relay: priya is editing packages/contracts/src/billing.ts (branch feat/currency, last edit 09:41:20Z, objective \"Add currency to invoices\"). Allow this edit?","additionalContext":"Relay at 09:41:22Z: priya (feat/currency) has 6 edits on this file since 09:37Z and is active; the notify tool reaches her at her next prompt; her change record is imp_01J… (contract)."}` — the reason is shown to the user and forces a prompt even in `acceptEdits`/`auto`; the context goes to Claude. The hook cannot observe the user's answer; the *edit landing* is the signal: `post-edit` (§4.5) turns `asked` into a 30-min `snooze` for that pair, and an `asked` mark with no edit behind it expires after 2 min (denied or still pending). Parallel or immediately-following edits of the same file see the fresh `asked` mark and get context only — one prompt per collision, not one per Edit call.
   - CLAIMED with `hard: true`, or HOT under policy `deny` → `{"permissionDecision":"deny","permissionDecisionReason":"Relay: <same facts>; this file is under priya's hard claim until 13:00Z (claim clm_…). The claim/release tools and the user can lift it."}` (shown to Claude; blocks even under `bypassPermissions`).
6. Appends one line to `log/stats.jsonl` (for `/relay:doctor`).

**Latency:** 55–80 ms (Node start + JSON reads + globbing); no path on this hook waits on git or the network.

**Fail-open:** missing/unparseable snapshot → no decision (normal permission flow). A timed-out PreToolUse command hook does not block (documented). `deny` is never emitted from a snapshot older than 5 min or from heat older than 15 min; `ask` is never emitted from a snapshot older than 15 min (§6.5). Exit code is always 0.

### 4.4 PreToolUse — matcher `Read` — `guard-read.sh` → verb `pre-read` — timeout 2 s — DEADLINE 600 ms

**Reads:** `tool_input.file_path`, `cwd`, `session_id`.

**Does:** `guard-read.sh` exits 0 in ~6 ms unless `sessions/<session_id>/pending` is non-empty. That file (v1.1: per session, not global) is rewritten by every snapshot write for this session and lists the change-set ids that have dependents in this repo and no `marks/jit.<cs>` yet; it is deleted when the list is empty, so a research-heavy turn with 50 Reads pays the Node spawn only while something is genuinely undelivered. When it runs: if the file is a listed dependent of such a change set → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Relay at …: <change-set note>"}}` so the note lands next to the file contents Claude is about to read; creates `jit.<cs>` (`wx`) and rewrites `pending` under the lock. No decisions ever.

**Latency:** 6 ms (guard) / 60 ms (when pending). **Fail-open:** anything → exit 0, the read proceeds.

### 4.5 PostToolUse — matcher `Edit|Write|MultiEdit|NotebookEdit` — verb `post-edit` — `async: true` (no timeout enforced; internal DEADLINE 6,000 ms)

**Reads:** `tool_name`, `tool_input.file_path|notebook_path`, `tool_use_id`, `session_id`, `cwd`. (`tool_response` is not needed: PostToolUse fires only on success; failures go to PostToolUseFailure, which Relay does not hook.)

**Does (Claude never waits):**
1. Append `{t:"edit", path, tool, toolUseId, at}`. If `marks/asked.<sha1(path|dev)>` exists for this path (any dev): create/refresh `marks/snooze.<…>` with expiry now + 30 min and remove `asked` — the edit landed, so the user allowed it (§4.3). Area (§5.2) is derived by readers from the fold; nothing is read-modify-written.
2. Contract detection (§7.2): if the path matches a contract glob, or `export_scan` finds a changed exported symbol in `git diff -U0 -w HEAD -- <path>` (untracked file → whole file treated as added; ≤ 4 KB of hunks read; 1 s timeout), extract symbols; `hash = sha1(normalized hunk)`; `blobId = git hash-object <path>` (working-tree content — what a receiver's `HEAD:<path>` will equal once the change is in their branch, squash or not); skip if `hash` equals the last `contract` line for this path in the fold. If the diff is empty and this session has an open contract record for the path (a revert), emit `{type:"retract", path, impactId}` instead. Dependents in this repo via `git grep -l -E '<specifiers>'` with a **2,000 ms** budget (this hook is async; the old 300 ms budget silently returned zero dependents on mid-size repos) and a cap of 50; on timeout `dependents: null`, and the hub falls back to the author repo's own uploaded `depindex.imports` (§7.3).
3. WAL (rule 6) then `POST /v1/events` (3 s budget) with `{session…, events:[{id, type:"edit", path, tool, toolUseId, at}, {id, type:"contract", path, symbols, kinds, hunk(≤1,500 chars, redacted; omitted when privacy.send_diffs="none"), hash, blobId, dependents, at}?]}`. Response `{snapshot, inbox}` → cache; undelivered `inbox` items → `seen` marks (`wx`) then `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<relay-inbox at=…>…</relay-inbox>"}}` (delivered on the next turn — documented async semantics).

**Latency:** 0 ms on Claude's path; 150–400 ms wall in the background (up to 2.4 s with a slow grep). **Fail-open:** any failure → exit 0; the WAL entry stays for the next drain; the edit already happened.

### 4.6 PostToolUse — matcher `Bash`, `if: "Bash(git *)"` — verb `post-git` — `async: true` (internal DEADLINE 6,000 ms)

**Reads:** `tool_input.command`, `tool_response.stdout`, `tool_response.stderr`, `tool_response.interrupted`, `cwd`, `session_id`.

**Does:** compares `git rev-parse HEAD` / `--abbrev-ref HEAD` / worktree with `meta.json`:
- **Branch changed** (checkout/switch/worktree) → `{type:"branch", branch, worktree}`; under the lock, `meta.startSha := git merge-base <oldStartSha> HEAD || HEAD`, `meta.branch` updated, `lastReportedSha[newBranch]` initialised to HEAD if unknown. A cross-branch `diff` is never taken.
- **HEAD moved on the same branch** → own commits only: `git log --author=<emails> --no-merges --format=%H%x09%ae%x09%s <old>..HEAD` (cap 50). For each: `git diff-tree -r --no-commit-id --name-only <sha>` → contract files → `git show -U0 -w --format= <sha> -- <files>` (≤ 8 KB) → symbols, `blobId = git rev-parse <sha>:<path>`, `patchId = git diff-tree -p <sha> | git patch-id --stable` → event `{type:"commit", sha, patchId, authorEmail, subject, files, contracts:[{path, symbols, hunk, hash, blobId}]}` (the hub attaches the SHA to the open impact for that path, or creates one for commits made from a human editor). Commits by other authors that arrived through `pull`/`merge`/`rebase` are not reported; they are only used locally to refresh `ancestry.json` (§4.12), which is how a teammate's change becomes "already in your branch".
- command contains `git push` and `git branch -r --contains HEAD` succeeds → `{type:"push", branch, sha}`.
POSTs like post-edit (WAL first); prints inbox context the same way. `if` matching is best-effort (Claude Code runs the hook when it cannot determine the command), which only costs a no-op process; commits missed here are reconciled by the author-filtered `lastReportedSha` scan at Stop and SessionStart.

**Fail-open:** async; exit 0; missed events reconciled later.

### 4.7 TaskCreated / TaskCompleted / CwdChanged — verbs `task-created`, `task-completed`, `cwd` — sync, timeouts 2/2/3 s — DEADLINE 300/300/1,500 ms

**Reads:** `task_id`, `task_subject` (task events; both documented, read defensively — unknown shapes → exit 0); `old_cwd`, `new_cwd` (CwdChanged); `session_id`.

**Does:** `task-created` appends `{t:"task", id, subject, status:"created"}`; the most recently created, not-yet-completed task subject is the `task` objective source (§5.1). `task-completed` appends `status:"completed"`; completed subjects feed `tasksDone` (≤ 20) for the heuristic handoff. Both send `{type:"task"}` in the next batched POST (no immediate network) and never exit non-zero (exit 2 on `TaskCreated` would roll the task back). `cwd` re-derives `meta.repoRoot`/`branch`/`repo` when `new_cwd` is outside the current repo root (rule 10), appends `{t:"cwd", from, to}`, and re-appends the `RELAY_*` exports to `$CLAUDE_ENV_FILE` (CwdChanged clears earlier dynamic exports). No stdout on any of the three.

### 4.8 Stop — no matcher — verb `stop` — `async: true` (internal DEADLINE 5,000 ms)

**Reads:** `prompt_id`, `last_assistant_message`, `session_id`, `cwd`. (`stop_hook_active` is read but **not** used as an early exit — v1.1: it is true only when *another* Stop hook, e.g. `/goal` or Egregore, blocked and Claude continued; Relay never blocks, so skipping those turns would just drop them. Turns are keyed by `prompt_id` instead and upserted on the hub.)

**Does:**
1. Append `{t:"turn", at, promptId, text}` where `text` = `prose(last_assistant_message)` ≤ 3,000 chars: fenced code blocks, inline code longer than 80 chars, and lines matching diff/stack-trace patterns are stripped client-side *before* redaction (`privacy.send_turns: "prose"` default; `"full"` and `false` are the alternatives, §11.1).
2. Session-level reconciliation, author-filtered (this is what catches multi-edit refactors and hand-made commits as one change): `base = git merge-base <meta.startSha> HEAD` (branch change → handled as in §4.6 first); `dirty = git status --porcelain` (uncommitted changes are this developer's regardless of author); `ownCommits = git log --author=<emails> --no-merges <meta.lastStopSha ?? base>..HEAD` with their `diff-tree` file lists; "changed outside Claude" = (`dirty` ∪ files of `ownCommits`) − files already in the fold → `n:0` entries. Contract paths in that set get the §4.5 symbol/hash/blobId treatment (contract events); open contract records of this session whose diff vs HEAD is now empty and that no own commit touched → `retract`. `meta.lastStopSha := HEAD` under the lock. A raw `git diff --name-only <startSha>` is never used: after a `pull` it would list every teammate's file.
3. Heuristic draft handoff (§8.2) built locally from the fold, ≤ 8 KB → `draft.json`.
4. WAL then `POST /v1/events` with `{events:[{type:"turn_end", promptId, text, draft}, …contract/commit/retract events…]}`. The hub sets presence `idle`, upserts the turn by `(session, promptId)`, stores the draft (so Ctrl-C, crashes and closed laptops still leave a teammate-visible handoff), and flags decision candidates.
5. Prints nothing. Never `decision: "block"`, never `additionalContext` (a Stop `additionalContext` would soft-continue the turn).

**Fail-open:** async; the turn has already ended; the WAL entry survives a kill (the previous design wrote the outbox only *after* a failed POST, so a Stop worker killed by `/exit` mid-request lost the turn).

### 4.9 SessionEnd — no matcher — verb `session-end` — shared 1.5 s budget (plugin per-hook timeouts do not raise it) — DEADLINE 600 ms

**Reads:** `reason` (`clear|resume|logout|prompt_input_exit|other`; `resume` — the user resumed another session from this one — and `other` are full ends), `session_id`, `cwd`.

**Does (v1.1: no git, no fetch inside the budget):** append `{t:"end", reason, at}`; create `marks/ended`; write the WAL entry `outbox/<ulid>.json {kind:"session_end", sessionId, at, body:{reason, files, commits, draft}}` from the fold (Stop reconciled the tree seconds earlier); spawn the detached worker `bg session-end <ulid>` (§4.12; survives Claude Code exiting because it is in its own session and holds no inherited pipe) which POSTs `/v1/session/end` with a 5 s budget and deletes the WAL entry on 2xx; exit 0 in ~70 ms. The hub sets presence `gone`, releases the developer's explicit claims in that repo when this was their last live session there (unless `keep: true`, §6.3), and `waitUntil(synthesizeHandoff(session))` under a per-session advisory lock (§8). Prints nothing (SessionEnd output is discarded anyway).

**Fail-open:** exit 0 within ~100 ms no matter what. If the worker is killed or the hub is down, the WAL entry is drained by any later worker of this developer on this machine (typically the next session start, or the *other* live session's next prompt); the local liveness sweep (rule 11) ends crashed sessions from any surviving session within seconds; the hub's sweep ends anything silent for > 2 h and synthesizes from the last Stop draft.

### 4.10 Hook latency and delivery summary

| Event | Sync? | Network / git on the sync path | Typical | Worst (bounded) | What Claude receives |
|---|---|---|---|---|---|
| SessionStart startup/resume/clear/fork | yes | POST start, 3 s budget; 3–4 `rev-parse` | 300 ms | 3.5 s | digest (≤ 6 KB; ≤ 2 KB delta on resume) |
| SessionStart compact | yes | none | 80 ms | 0.8 s | short re-injection |
| UserPromptSubmit | yes | GET snapshot only if cache > 60 s (0.8 s; 1.5 s after > 5 min idle); no git | 50 ms | 1.6 s | inbox (same turn) |
| PreToolUse edit tools | yes | none (spawns a detached refresh when the cache is > 120 s) | 65 ms | 0.9 s | ask/deny/context (same tool call) |
| PreToolUse Read | yes | none | 6 ms | 0.6 s | JIT impact note |
| PostToolUse edit/git | async | WAL → POST events; git diff/log/grep | 0 ms | — | inbox (next turn) |
| TaskCreated/TaskCompleted/CwdChanged | yes | none (≤ 3 `rev-parse` on cwd change) | 40 ms | 1.5 s | nothing |
| Stop | async | WAL → POST events; git status/log/merge-base | 0 ms | — | nothing |
| SessionEnd | yes | none (WAL + detached worker) | 70 ms | 0.6 s | nothing |

Per Edit/Write the developer pays one ~65 ms synchronous hook with no git and no network on its path (target < 300 ms met); the async PostToolUse costs nothing on the critical path.

### 4.11 Status line (human-visible presence, v1.1)

`init-project` writes a `statusLine` into the project `.claude/settings.json` (plugins cannot ship one: a plugin `settings.json` supports only `agent` and `subagentStatusLine`; Appendix B.12 checks whether that has changed). Its command is `/bin/sh -c 'f="${RELAY_HOME:-$HOME/.relay}/statusline.sh"; [ -r "$f" ] && exec /bin/sh "$f" || true'` with `refreshInterval: 10`, so a machine without Relay renders nothing and a project statusLine never breaks (settings `env` reaches the status-line subprocess, so `RELAY_HOME` set there is honoured). `statusline.sh` (POSIX sh + sed, ~5 ms, no Node): reads stdin, runs the developer's own user-scope status line first if `~/.relay/statusline-chain` exists (so the project setting does not silently replace it), then prints the pre-rendered line from the path recorded in `current/<CLAUDE_PID>.json` — `cache/<repoKey>/statusline.txt`, rendered by every snapshot write: `relay ● priya app feat/currency 09:41 · arjun dashboard main idle 12m · 1 impact · 1 note` (absolute times, never ages, because the line can be a minute old). `--no-statusline` skips the key.

### 4.12 Background worker (`bg <job>`, v1.1)

Spawned by hooks as `spawn(node, [hook.mjs, 'bg', job, ...args], {detached: true, stdio: 'ignore', env: {...process.env, RELAY_BG: '1'}}).unref()` — its own process session, no inherited pipe (an inherited stdout would keep Claude Code waiting), survives the parent hook and Claude Code exiting. Jobs: `session-start`, `prompt`, `refresh`, `session-end <ulid>`. Each job is single-flight per repo (`mkdir ~/.relay/bg/<job>.<repoKey>.lock`, stale after 30 s) and has a 15 s overall watchdog. Every job ends with the shared chores, each budgeted: outbox drain (rule 6); liveness sweep (rule 11); **ancestry** — for every heat `headSha`, commit SHA and impact `blobId` in the fresh snapshot, `git merge-base --is-ancestor <sha> HEAD` (fast path) and `git rev-parse HEAD:<path>` == `blobId` or all `+` lines of the hunk present in `git show HEAD:<path>` (content path, survives squash/rebase) → `cache/<repoKey>/ancestry.json {headSha, contains:{sha:bool}, merged:{changeSetId:bool}}`, and auto-acks for newly merged change sets; journal fold/rotate; dependency index when stale; plugin-behind check (24 h cache). Workers are the only processes allowed to open the breaker (rule 5).

---

## 5. Automatic derivation: objective, area, branch, and the area map

Nothing here is typed by a developer. Every value is derived on the developer's machine from hook input and git, and only the derived value leaves the machine.

### 5.1 Objective (≤ 140 chars, imperative phrase)

Sources in priority order; each carries `source` so the digest can show confidence:

1. **task** — the subject of the most recently created, not-yet-completed task (`TaskCreated`/`TaskCompleted`, §4.7). Always wins while such a task exists.
2. **prompt** — from `UserPromptSubmit`. Candidate = first line of the prompt with code fences, absolute paths, URLs, `@file` mentions and stack-trace lines stripped, whitespace collapsed, truncated at 140 chars on a word boundary. Rejected when: shorter than 25 chars; matches the stoplist `^(y|yes|no|ok|okay|sure|go ahead|continue|proceed|thanks|do it|next|k|nope)\b`; starts with `/` (slash command) or `[private]` (§11); is ≥ 40 % non-alphabetic (pasted logs/JSON); or is < 60 chars while the last assistant message ended with `?` (an answer to Claude's question). The candidate **replaces** the current objective when there is none, or when it starts with an imperative verb (`add|fix|implement|refactor|update|remove|rename|migrate|write|build|create|change|make|move|wire|investigate|debug|test|convert|extract|split|merge|document|deploy`) or contains `\b(now|next|instead|switch to)\b`, or when ≥ 10 min or ≥ 15 tool calls have passed since the current objective was set. A trail of the last 5 objectives is kept for the handoff (`objective` lines in the journal).
3. **llm** — the handoff synthesizer rewrites the objective for the record at session end (§8); it does not change live presence.
4. **branch** — before any prompt: humanized branch name (`feat/dashboard-filters` → `dashboard filters`), else `working in <repo>`.

`privacy.objective_from_prompts: false` disables source 2 entirely (presence shows task/branch only).

### 5.2 Area

`area` = argmax over the session's last 20 edited paths (folded from the journal's `edit` lines) of Σ `3 / (1 + minutes_ago / 10)` per matching area glob (recency-weighted; only write tools are hooked, so touches = edits). Areas marked `shared: true` (contracts, migrations) never win alone: a session editing `packages/contracts` and `apps/app` shows `app (+contracts)`. Ties or no edits yet → the first area whose name appears as a token in the branch name (`feat/dashboard-legend` → `dashboard`) → an area whose `owners` include this developer → the first path segment of the cwd relative to the repo root (`apps/app` → `app`) → `unknown`. Recomputed by every worker that posts presence.

### 5.3 Branch, worktree, repo, client

- `branch`: `git rev-parse --abbrev-ref HEAD` at SessionStart, refreshed by the prompt worker (30 s cache), on every `post-git`, and on `CwdChanged`. Detached HEAD → `detached@<sha7>`. A branch change resets `meta.startSha` to the merge-base (§4.6) so later reconciliation never diffs across branches.
- `worktree`: when `git rev-parse --git-dir` ≠ `--git-common-dir`, `worktree = basename(toplevel)`; `claude --worktree` sessions therefore show `wt:<name>`. Paths are always relative to `--show-toplevel` of the hook `cwd`, so the same file in two worktrees or two clones is the same key.
- `repo`: normalized `origin` URL (`github.com/acme/app`), overridable with `.relay.json.repo`; local-only repos → `local/<basename>`.
- `client`: `desktop` when `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, else `cli`. `host`: `os.hostname()`.
- `project`: `.relay.json.project` (two repos with the same value form one project); default = `origin` owner/name.

### 5.4 The area/ownership map: `.relay.json` (committed at each repo root)

```jsonc
{
  "project": "acme-portal",                    // shared by every repo of the client project
  "repo": "github.com/acme/app",               // optional override of the normalized origin slug
  "areas": {
    "app":       { "paths": ["apps/app/**"],                      "owners": ["priya"] },
    "dashboard": { "paths": ["apps/dashboard/**"],                "owners": ["deepak"] },
    "api":       { "paths": ["packages/api/**"] },
    "contracts": { "paths": ["packages/contracts/**", "prisma/**"], "shared": true }
  },
  "contracts": {
    "globs":    ["+**/*.graphql"],             // "+" prepends to the defaults (§7.1); no "+" replaces them
    "packages": ["@acme/contracts"],           // workspace/npm names other repos import from
    "export_scan": true                        // exported-symbol heuristic on any .ts/.tsx/.js/.py/.go file (candidates only; priority needs a cross-area dependent, §7.5)
  },
  "depends": { "dashboard": ["contracts", "api"], "app": ["contracts", "api"] },   // area → areas it consumes (cross-repo fallback, §7.5)
  "impacts":  { "debounce_minutes": 3 },       // uncommitted contract changes reach teammates' inbox/JIT only after being stable this long (committed: immediately)
  "collision": { "hot": "ask", "claimed": "ask", "warm": "context", "same_dev": "note" },   // ask | deny | context | off
  "privacy":  { "send_prompts": false, "send_turns": "prose", "send_diffs": "contracts", "objective_from_prompts": true },
  "handoff":  { "llm": true, "idle_minutes": 20 }
}
```

Absent file → `project` = origin owner/name, areas = first two path segments of edited paths (`apps/app`, `packages/api`, `src/billing`), default contract globs, `collision.hot = ask`, privacy defaults as above. `owners` are optional: the hub learns owners as the top-2 editors of an area over 14 days (§7.5). The file is uploaded (hash-compared) at SessionStart so the hub renders digests and routes impacts with the same map. Per-developer, per-machine mutes (`/relay:mute <path|glob|area|@dev>` → `~/.relay/mute/<repoKey>.json`) are local and never committed: they silence collision notes and JIT notes for that target on that machine, which is the one-word remedy for a first false positive.

---

## 6. Presence and claims

### 6.1 Presence record (one per Claude session, never typed)

`{dev, sessionId, client, host, repo, project, branch, worktree, area, objective, objectiveSource, state, startedAt, lastSeenAt, lastEditAt, inTurnSince, editCount, recentFiles[≤10]}`. Updated by every worker/hook that reaches the hub (SessionStart, the prompt worker, post-edit batches, post-git, Stop, SessionEnd). Developer-level presence = the union of their sessions: `status` shows `priya (2 sessions): app · feat/auth · "add refresh-token rotation" (working) | dashboard · main · (idle 12m)`.

### 6.2 States, TTLs, staleness (all derived at read time from hub timestamps; no cron needed)

| State | Rule | Shown as |
|---|---|---|
| `working` | any event in the last 3 min, **or** a prompt received with no Stop since (v1.1: "in a turn" — a 25-minute investigation of Reads/Greps/tests reaches the hub with no event, and must not read as idle or trigger an interim handoff), capped at 2 h | active / "in a long turn Nm" |
| `idle` | Stop received and 3–30 min silent | idle Nm |
| `away` | 30 min – 2 h silent after a Stop | away, greyed |
| `gone` | SessionEnd received (any reason, incl. `crash` from the local liveness sweep), or > 2 h silent (the lazy sweep marks it ended, reason `timeout`, and synthesizes the handoff from the last Stop draft) | dropped from digests/status |

Heat (`edit`, `dirty`, `commit`) is kept 24 h in the snapshot with per-kind caps (§10.2); explicit claims expire at `expiresAt`. A developer who leaves Claude open overnight decays idle → away → gone; the next *live* hook makes the session `working` again (the same row is revived — `ended_at` cleared — and a later end regenerates its handoff as `rev+1`). A **replayed** event (`replay: true`, or an `at` older than `ended_at`) never revives a session and never moves `lastSeenAt` backwards (§10.4).

The lazy sweep runs inside any `/v1/session/start` or `/v1/events` request when the last sweep is > 60 s old. Concurrent invocations are serialized by a conditional update used as a lock (v1.1): `UPDATE meta SET value = now() WHERE key = 'last_sweep_at' AND value < now() - interval '60 seconds' RETURNING 1` — only the winner sweeps. No cron is configured; Vercel Hobby would reject an hourly one and the sweep needs none.

### 6.3 Claims

- **Implicit file claim** — derived, not stored: another dev's live session (`lastSeenAt` ≤ 30 min) with `heat.edit` on the path ≤ 15 min ago. This is what makes "actively editing" HOT. It frees itself 15 min after the last edit without any release.
- **Warm heat** — same file edited ≤ 24 h ago (edit/commit heat), or reported dirty at that dev's last prompt within the last 24 h (`git status --porcelain` → human/IDE edits show up too; older dirty entries are ignored, so a config tweak that sits uncommitted for weeks is not "warm" forever), or listed in a handoff's `changed` ≤ 24 h ago — and the change is **not in my branch by content**: `ancestry.json` (§4.12) says neither `merge-base --is-ancestor <their headSha> HEAD` nor `HEAD:<path>` == their `blobId` holds. Squash- and rebase-merged changes therefore stop being warm as soon as they land in my branch; unknown → treated as warm (context only, harmless).
- **Explicit claim** — `claim(target: area|path|glob, note?, ttl?: "4h" (max "24h"), hard?: false, keep?: false)` → a row **scoped to (dev, repo)** with the creating session as metadata (v1.1: the MCP process may carry a stale session id after `/clear`, so a claim must not die or linger with a session id). Matches any path under the target for every other dev's PreToolUse (ask; `hard: true` → deny). Released by `release`, by TTL, by an admin, or when the developer's *last* live session in that repo ends (SessionEnd of any reason, crash end, or sweep) unless `keep: true`. Conflicting claims are allowed but reported to both sides — Relay informs, it does not lock.

### 6.4 Collision severity (PreToolUse on write tools)

| Severity | Condition | Default output |
|---|---|---|
| CLAIMED | path under another dev's unexpired explicit claim | `hard` → deny; else ask |
| HOT | implicit file claim by another dev (§6.3) | ask (`collision.hot`) |
| WARM | warm heat by another dev not yet in my branch by content | context |
| SEQUENTIAL | their change touching the file is already in my branch (SHA ancestor or blob match) | note (one line, once per path) |
| SAME_DEV | my own other session edited it ≤ 10 min ago (snapshot heat carries own sessions tagged `mine: true` — v1.1; the previous "others only" heat made this case undetectable) | note (once per path per 10 min) |
| NONE | — | nothing |

Dedup and fatigue control, all via race-free marker files (§4.0 rule 9): one `ask` per `(path, other dev)` per 30 min per session — `marks/asked.<key>` is created synchronously *before* the prompt and turned into `marks/snooze.<key>` by the landing edit (§4.5), so parallel Edit calls and the edits that follow an allow get context only; an `asked` mark with no edit behind it expires after 2 min. WARM/SEQUENTIAL/SAME_DEV notes are emitted once per `(path, other dev)` per session (`marks/noted.<key>`). Two developers legitimately co-editing a shared file are asked once, not per edit. Inside subagents, in `dontAsk`/`bypassPermissions` sessions and with `RELAY_INTERACTIVE=0`, HOT is context only (§4.0 rule 14).

### 6.5 Staleness ladder (never block on stale data)

| Snapshot age (rule 16 arithmetic) | Allowed decisions | Label |
|---|---|---|
| ≤ 5 min | full policy (deny/ask/context) | — |
| 5–15 min | deny → ask, ask → context | "(presence as of HH:MMZ)" |
| > 15 min | context only | "(presence as of HH:MMZ; not refreshed)" |
| breaker open (two consecutive worker failures, §4.0 rule 5) | context only | "(Relay hub unreachable since HH:MMZ)" |

A single slow refresh never produces an "offline" label — only the breaker does. Additionally a HOT/CLAIMED verdict requires the underlying heat/claim timestamp itself to be ≤ 15 min old (heat) or unexpired (claim) at read time; all timestamps are hub-stamped and ages are computed as same-clock differences, so neither a frozen cache nor a skewed laptop clock can manufacture a "right now".

### 6.6 Worktrees, multiple sessions, two machines

- **Worktrees:** all worktrees of a repo share one presence board (same `repo` slug from `origin`); each session shows its own `branch` and `wt:<name>`. Collisions across worktrees on different branches still warn (they are merge conflicts in the making) with both branches named; same-branch HOT collisions are the classic case and are escalated one level (`context` → `ask`) since the two edits will land in the same commit history.
- **Two sessions per dev (CLI + Desktop, two terminals, possibly the same cwd):** distinct `session_id`s, one handle; they never collide (SAME_DEV note only); explicit claims are per dev and survive until the last session ends; the snapshot cache is shared per repo (atomic, `serverTime`-guarded writes), JIT/inbox delivery state is per session (marks), so both sessions see the team but each item is shown once per session. *Why the hub does not end "prior sessions of the same dev+host+cwd" on a new SessionStart (a suggested fix):* two terminals in one checkout are a normal way to work and would be ended by each other; the pid-based liveness sweep (§4.0 rule 11) ends genuinely dead sessions instead, and does so from any surviving session on the machine within seconds.
- **Two machines per dev:** same handle, separate `~/.relay`; inbox items are marked delivered server-side, so a message is shown once (on whichever machine prompts first); impacts are JIT-delivered per session by design, so they may appear once per session.
- **Ctrl-C / crash / closed laptop:** no Stop/SessionEnd; the last Stop draft is already on the hub (WAL guarantees the last one was not lost); the next Relay worker on that machine ends the session with reason `crash` (rule 11) and the hub synthesizes from the draft; the 2 h hub sweep is the backstop when the whole machine is off.

---

## 7. Impact detection and routing

Goal: when Dev A changes a shared contract (type, API, schema), Dev B's Claude learns about it (a) at its next session start, (b) at its next prompt if it is live, and (c) at the exact moment it reads or edits a dependent file — including when A and B work in **different repos** of the same project — without flooding B with every exported-component signature A touches.

### 7.1 What counts as a shared contract

Two signals, OR-ed, produce contract **candidates**; whether a candidate becomes a notice is decided by routing (§7.5), which requires a dependent outside the author's own area for anything above `low`:

1. **Path globs** — defaults (extendable with `"+glob"` in `.relay.json.contracts.globs`):
   `**/contracts/**`, `**/shared/**`, `packages/*/src/index.ts`, `**/*.contract.{ts,js}`, `**/types/**`, `**/*.d.ts`, `**/schema.prisma`, `**/*.prisma`, `**/migrations/**`, `**/openapi*.{json,yaml,yml}`, `**/swagger*.{json,yaml,yml}`, `**/*.graphql`, `**/*.proto`, `**/*.schema.{ts,json}`, `**/api/**/route.ts`, `**/routes/**`, `**/zod/**`, `**/*.env.example`. Any file under an area with `shared: true` also counts.
2. **Exported-symbol scan** (`contracts.export_scan`, default true) on any `.ts/.tsx/.js/.mjs/.py/.go` file outside the globs: the edit is a candidate if `git diff -U0 -w HEAD -- <path>` contains a `+`/`-` line matching
   - TS/JS: `^[+-]\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:type|interface|enum|class|function|const|let|var)\s+(\w+)` or a member line inside an exported `interface`/`type` block (brace-depth tracked within the hunk);
   - Python: `^[+-](?:def|class)\s+(\w+)` at column 0; Go: `^[+-]\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)` / `^[+-]\s*type\s+([A-Z]\w*)`;
   - zod/tRPC surfaces: `^[+-].*\b(z\.object\(|router\(|\.procedure\b)`.
   Whitespace-only and comment-only hunks are ignored (`-w`, plus a comment-line filter). In a React repo nearly every file exports a component; those candidates stay `low` (recorded, visible in `recent_changes`, never a notice) unless some file in *another* area imports them.

Symbol extraction per file type: TS/JS exported names + the signature line; Prisma `model X` (a changed field line is attributed to the enclosing model via the hunk header `@@ … @@ model X {`); OpenAPI changed `paths.*` keys + method and `components.schemas.*` names; GraphQL `type|input|enum|interface|union` names; proto `message|service|rpc`; migrations/SQL: table names from `CREATE|ALTER TABLE`; anything else: file-level (`symbols: []`, summary "edited <path>").

### 7.2 Detection points (increasing certainty, deduped by content hash, attributed by author)

| When | Where | Mechanism | Status |
|---|---|---|---|
| Seconds after the edit | `post-edit` (async) | globs / export scan on `git diff -U0 -w HEAD -- <path>`; `hash = sha1(normalized hunk)`, `blobId = git hash-object <path>`; new hash → new record, changed hash for the same `(session, path)` within 30 min → same record `rev+1` (superseded in place); empty diff for an open record → `retract` | `uncommitted` (held back from inbox/JIT until stable for `impacts.debounce_minutes`, §7.5) |
| Every response end | `stop` (async) | merge-base-bounded, author-filtered reconciliation (§4.8) over contract paths whose blob changed since the last Stop — captures the whole session's delta as one record, catches multi-edit refactors and edits made outside Claude; empties → `retract` | `uncommitted` |
| Commit inside Claude | `post-git` | own-author commits only: `git diff-tree` + `git show -U0 -w <sha> -- <contract files>` → attaches `commitSha`, `patchId`, `blobId` to the open record (or creates one if the edit was never seen) | `committed` |
| Commit outside Claude | `bg session-start` / `stop` | `git log --author=<emails> --no-merges <lastReportedSha[branch]>..HEAD` (cap 50) | `committed` |
| Push | `post-git` (`git push`, or `git branch -r --contains HEAD` succeeds later) | | `pushed` |
| Reverted before anyone consumed it | `post-edit` / `stop` | diff vs HEAD empty and no own commit touched the path → `retract` | `withdrawn` (targets and undelivered notifications deleted; already-delivered ones get a one-line "withdrawn" in the next digest) |
| In the receiver's branch | receiver-side worker (§4.12 ancestry) | fast path `git merge-base --is-ancestor <commitSha> HEAD`; content path `git rev-parse HEAD:<path>` == `blobId`, or every `+` line of the hunk present in `git show HEAD:<path>` (squash merges and rebases never make the original SHA an ancestor — content does) | `merged` → auto-ack ("already in your branch") |

Pulled, merged or rebased-in commits by other authors are never reported as the puller's change (they would credit the puller, route an IMPACT about their own change back to the real author, and fill the puller's handoff with hundreds of teammates' files); they only feed the receiver-side ancestry check. The hub applies the same rule defensively: a `commit` event whose `authorEmail` does not resolve to the sender never creates an impact, and only updates `merged` status for existing ones.

### 7.3 Dependents in the author's repo (client side, inside the async hook)

Specifiers for the changed file `F`:
- nearest `package.json` `name` above `F` (`@acme/contracts`) and the deep form (`@acme/contracts/billing`);
- repo-relative path without extension (`packages/contracts/src/billing`) and relative-import forms (`/billing'`, `/billing"`, `./billing`, `../contracts/billing`);
- Prisma: `prisma\.<camelModel>\b` and the model name as a type; OpenAPI: the literal path strings; GraphQL: type names.
`git grep -l -E '<alternation>' -- ':!node_modules' ':!<F>' '*.ts' '*.tsx' '*.js' '*.mjs' '*.py' '*.go' '*.graphql'` with a **2,000 ms** budget (the hook is async) and a cap of 50 files. On timeout the event carries `dependents: null` and the hub resolves in-repo dependents from the author repo's own uploaded dependency index (§7.4), which is refreshed daily and on HEAD changes. Schema-type files with no importers (Prisma/OpenAPI/GraphQL/migrations) default to "all areas" at `normal` priority unless `contracts.consumers[glob]` narrows them.

### 7.4 Dependents in the other repos of the project (the two-repo case)

Each client builds a **dependency index** for its own repo in the background (`bg session-start`, when `HEAD` changed or the index is > 24 h old; ~0.2–2 s on a mid-size repo, off every hook path) and uploads it: `POST /v1/depindex {repo, head, builtAt, imports: {"<specifier>": [files]}, symbols: {"<Identifier>": [files]}, contractPaths: {"<basename or path>": [files]}}`. Built with one `git grep -n -E "^\s*(import|export)\b.*\bfrom\s+['\"]|require\(['\"]"` pass over tracked source files, parsing the specifier and the imported identifiers (`import { A, B as C }`, `import * as X`, `import X`), plus `prisma\.(\w+)` references and literal HTTP path strings (`'/api/...'`). Specifiers are normalized to package names (`@acme/contracts`, `@acme/contracts/billing`) and to repo-relative paths.

At routing time the hub looks up, in every other repo of the same `project`: `imports[packageName]`, `imports[deepSpecifier]`, `symbols[s]` for each changed symbol, and `contractPaths[basename(F)]` **only for non-generic basenames** (v1.1: `index|types|schema|route|routes|client|api|utils|constants` are excluded — every `packages/*/src/index.ts` change used to route to every `index.ts` in the other repo). Cross-repo `high` requires a package-specifier or symbol match; a basename-only match caps at `normal`. This is what lets a change in `acme/app`'s `packages/contracts/src/billing.ts` reach `acme/dashboard/src/invoices.tsx`. If the other repo has no index yet (nobody has started a session there since Relay was installed), routing falls back to the `depends` map (§7.5 step 3) with `confidence: low`.

### 7.5 Routing algorithm (hub, `impact.ts`, on every `contract`/`commit`/`retract` event)

1. **Upsert the impact record** `imp_<ulid>`: `{repo, path, symbols, kinds, summary, hunk, hash, blobId, by, sessionId, branch, status, commitSha, patchId, rev, changeSetId, createdAt, updatedAt}`; unique on `(repo, sessionId, path, hash)` so the three detection paths and two sessions' workers cannot insert the same change twice; same `(sessionId, path)` within 30 min → `rev+1`, `supersededBy` on the old row; a rebased commit with a known `patchId` updates the SHA instead of creating a record.
2. **Change set (v1.1):** impacts from the same `(session, branch)` whose updates are < 30 min apart share a `changeSetId` (`cs_<ulid>`). Notifications, inbox lines, JIT notes, acks and the digest all operate per change set — a 12-file refactor is one notice ("priya changed 12 contract files: billing.ts (Invoice, createInvoice), schema.prisma (Invoice), … — `impacts` lists them"), not twelve.
3. **Dependents** = client-provided in-repo dependents (or the author repo's depindex when `null`) ∪ cross-repo dependents from `depindex` (§7.4) ∪ dependents of the previous rev. Each dependent is tagged with its repo and its area (via that repo's `.relay.json` globs).
4. **Areas** = areas of the dependents ∪ `depends` map of every repo in the project where the changed file's area is a dependency (`dashboard: [contracts]` → `dashboard` when `contracts` changed). `depends` results get score +2; import-derived results +3.
5. **Developers** = for each affected area: declared `owners` (+2) ∪ learned owners (top-2 editors of that area over 14 days, +1) ∪ any live session whose current `area` matches (+2) ∪ any dev with heat on a dependent file in the last 7 days (+2). Remove the author. Score per dev = max over areas.
6. **Priority (v1.1):** `high` requires score ≥ 3 **and** at least one import-derived dependent outside the author's area (`depends`/heat/owner scores alone cap at `normal`); `normal` = score 1–2, or ≥ 3 without an import-derived dependent; no dependents outside the author's own area → `low` (recorded, shown in `recent_changes`/status and one project-wide FYI line in digests, no inbox, no JIT). Same-area churn is therefore never a notice.
7. **Debounce (v1.1):** an `uncommitted` change set is routed to inbox/JIT only once its hash has been stable for `impacts.debounce_minutes` (3; checked by the sweep and by the next event for that session) or its status is `committed`/`pushed`; until then it appears only in `status`/`who_is_on` and the digest, labelled "(in progress)". A `retract` marks the record `withdrawn`, deletes its targets and undelivered notifications, and downgrades the change set if it becomes empty.
8. **Persist** `impact_targets(changeSetId, dev, repo, dependents[], priority)` and one `notification(kind: impact)` per (change set, dev), updated in place on `rev+1`.
9. **Deliver** — the affected dev's next snapshot (returned by any of their hook calls or fetched by their prompt refresh) contains the change set with the dependents *in their repo*; the client writes `sessions/<sid>/pending` (§4.4) when any dependent exists and the change set is not yet marked `jit`. Delivery moments: SessionStart digest section "Contract changes affecting you" (top 5 change sets, hunk ≤ 1,500 chars for the top 3); UserPromptSubmit `<relay-inbox>` for `high` items not yet shown (same turn); PreToolUse Edit/Write/Read of a listed dependent (top 2 change sets, ≤ 4,000 chars, once per change set per session); async PostToolUse (next turn) if it arrived mid-turn.
10. **Acknowledge** — `impacts(ack: "cs_…" | "imp_…")` tool, or automatic when the receiver's worker finds the change set merged by SHA or by content (§7.2 last row; same-repo change sets only — a cross-repo change set has no local blob to compare and expires or is acked by hand), or 7-day expiry. A new `rev` re-arms JIT once, except when the new rev is a `retract`. Acks are per `(change set, dev)` on the hub; JIT delivery is per session on the client.

Honest limits: grep/regex dependency detection misses dynamic imports and non-literal HTTP coupling and can over-notify on common basenames; the notice always names the dependents so Claude can judge, `ack` and `/relay:mute` silence, and `contracts.globs` can be tightened. A ts-morph program graph is an M2 option.

---

## 8. Handoff generation

### 8.1 Triggers (zero developer effort)

| Trigger | Result |
|---|---|
| `SessionEnd` (any reason incl. `resume`, `crash`; `clear` only if the session had ≥ 1 edit or commit) | final handoff `rev n` |
| Session **idle** (Stop received, then silent) ≥ `handoff.idle_minutes` (20) with unsummarized activity (sweep) — never while the session is in a turn (§6.2) | interim handoff; the same record is rewritten (`rev+1`) at the end |
| Session silent > 2 h (sweep) | session auto-ended (`reason: timeout`), handoff from the last Stop draft |
| `handoff` tool / `/relay:handoff` | on demand; may include Claude's own structured summary (`quality: self`) |
| Sessions with 0 edits, 0 commits and < 3 prompts | no handoff |

Generation is serialized per session (v1.1): `pg_try_advisory_xact_lock(hashtext(session_id))` — a SessionEnd and an interim sweep that fire within seconds of each other produce one Haiku call, not two — and the row is written with `INSERT … ON CONFLICT (session_id) DO UPDATE SET rev = handoffs.rev + 1, …`. A rewritten handoff appears in a teammate's "Handoffs since your last session" only when its `rev` changed since that reader's `since`, so the interim and final versions are not shown as two records.

### 8.2 Inputs and tiers

Inputs are the session's own event stream on the hub — never a transcript: objective trail (with sources), prompts only if `send_prompts` (default off), edited paths with counts and areas, contract impacts with symbols + hunks, own commit SHAs/subjects/pushed flags, completed task subjects, the `turns` log (the last 12 turns, each the **prose** of a `last_assistant_message` — code blocks, long inline code, diff and stack-trace lines stripped client-side — truncated to 1,500 chars for the packet; `send_turns: "full"` keeps code, `false` disables), `decide()` records, and the latest client-side heuristic draft.

- **Tier 1 — heuristic (always, ~5 ms, $0):** `changed` = heat for the session grouped by area; `interfaces_changed` = impacts; `commits` = own commit events; `done` = completed task subjects + sentences from the last two turns matching `^(Done|I've|I have|Added|Updated|Fixed|Implemented|Removed|Renamed|Migrated)\b` (≤ 6, ≤ 140 chars); `decisions` = `decide()` records + lines matching `\b(decided|decision|we'll go with|going with|chose|settled on|instead of)\b` (`confidence: low`); `blockers` = lines matching `\b(blocked|blocker|waiting on|can't proceed|cannot|need .* from)\b`; `next` = bullets under a `Next`/`TODO`/`Remaining` heading in the last turn (≤ 5); `objective` = trail head. `quality: "heuristic"`. Written first, so a teammate always has something within seconds.
- **Tier 2 — LLM synthesis (when `ANTHROPIC_API_KEY` is set on the hub and `handoff.llm` is true):** one Messages API request via the official TypeScript SDK inside `waitUntil` (function `maxDuration: 60`): `model: process.env.RELAY_HANDOFF_MODEL ?? "claude-haiku-4-5"`, structured output via `output_config: { format: <JSON schema of §8.3> }`, system prompt with `cache_control` (stable prefix), the packet above as the user message (≈ 6–9k input tokens: 12 prose turns ≈ 4.5k, events ≈ 2k, prefix ≈ 1k), `max_tokens: 2048`, 20 s timeout, no tools. Output replaces the heuristic fields (`quality: "llm"`); extracted decisions become `decisions` rows with `source: "handoff"`. Failure or timeout → the heuristic record stands, labelled "(auto-summary)" in digests.
- **Tier 3 — self (best, optional):** `/relay:handoff` asks the running Claude to call `handoff({done, changed, interfaces_changed, decisions, blockers, next, notes_to})` from its full context; stored as `quality: "self"` and not overwritten by tier 2. Never forced: Relay does not use Stop `decision: block` to nag.

**Cost (Anthropic API list prices, cached 2026-06-24):** Haiku 4.5 at $1/$5 per MTok → ≈ $0.013 per handoff (9k in / 700 out); Sonnet 5 ($2/$10) ≈ $0.025; Opus 5 ($5/$25) ≈ $0.06. Four devs × ~5 sessions/day ≈ 20 handoffs/day plus a few interims → **≈ $0.30/day on Haiku 4.5**, ≈ $1.50/day on Opus 5 — under $1/day on the default. Objectives are heuristic only (no per-prompt LLM calls) to keep cost and latency flat. The model is a knob (`RELAY_HANDOFF_MODEL`), not a code change.

### 8.3 Exact structure (stored as JSON columns + rendered markdown)

```json
{
  "id": "hnd_01J…", "rev": 2, "quality": "llm",
  "dev": "priya", "sessionId": "3f2a…", "project": "acme-portal", "repo": "github.com/acme/app",
  "branch": "feat/currency", "worktree": null, "client": "cli",
  "startedAt": "2026-09-12T09:00:12Z", "endedAt": "2026-09-12T11:02:44Z", "endReason": "prompt_input_exit",
  "objective": "Add currency support to invoices",
  "areas": ["contracts", "api"],
  "done": ["Invoice now carries currency; createInvoice validates ISO-4217", "Migration 0042 adds invoices.currency (default USD)"],
  "changed": [{"path": "packages/contracts/src/billing.ts", "area": "contracts", "edits": 5, "why": "currency on Invoice"},
              {"path": "packages/api/src/invoices.ts", "area": "api", "edits": 3, "why": "validate currency"},
              {"path": "prisma/schema.prisma", "area": "contracts", "edits": 1, "why": "invoices.currency column"}],
  "interfaces_changed": [{"changeSetId": "cs_01J…", "impactId": "imp_01J…", "path": "packages/contracts/src/billing.ts", "symbols": ["Invoice", "createInvoice"],
                          "summary": "Invoice.total → amountDue (+currency); createInvoice(input) → createInvoice(input, currency)",
                          "status": "committed", "commitSha": "a1b2c3d"}],
  "decisions": ["Store amounts as integer minor units; no floats"],
  "blockers": ["Waiting on FX-rate provider credentials from client"],
  "next": ["Update dashboard invoice table (deepak)", "Backfill script for legacy invoices"],
  "commits": [{"sha": "a1b2c3d", "subject": "contracts: currency on Invoice", "pushed": true}],
  "notes_to": [{"dev": "deepak", "intent": "action", "text": "invoices.tsx must read amountDue and pass currency"}],
  "markdown": "…"
}
```

Markdown rendering (what `handoffs` returns and what an M2 archive would write) uses fixed headings `## Done`, `## Changed`, `## Interfaces changed`, `## Decisions`, `## Blockers`, `## Next`, `## Commits`, `## Notes to`, preceded by a frontmatter block that follows Egregore's addressed-handoff contract (`from`, `addressed_to`, `intent: action|feedback|fyi`, `claim`, `ask`) so an export into an Egregore memory repo is a formatting step, not a redesign.

### 8.4 Delivery

`handoffs` MCP tool; teammates' SessionStart digest ("Handoffs since your last session": one line per handoff whose `rev` is new since the reader's `since` — objective, done (first 2), interfaces, next, blockers — max 3, plus a pointer id for the full record); `notes_to` targets get a `notification(kind: handoff)` delivered at their next prompt; the author's own next digest echoes their last `next` list. The developer runs no command; `/relay:handoff` exists only as an optional quality upgrade.

---

## 9. MCP tools and the SessionStart digest

### 9.1 MCP server

`packages/plugin/.mcp.json` registers stdio server `relay` → tools are `mcp__plugin_relay_relay__<name>`; for `mcp_tool` hooks the server is `plugin:relay:relay`; the project settings pre-allow the server with both documented rule forms (`mcp__plugin_relay_relay` and `mcp__plugin_relay_relay__*`; Appendix B.4 records which one matches and `init-project` keeps writing both until then). `dist/mcp.mjs` bundles `@modelcontextprotocol/sdk` (esbuild, committed), resolves identity with the same lib as the hooks, and calls the hub with a 5 s timeout.

**Live session id (v1.1).** A stdio MCP server sees `CLAUDE_CODE_SESSION_ID` frozen at spawn, which is wrong after `/clear` (and possibly on `--continue`), while hooks see the live value. `mcp.mjs` therefore resolves the session **per tool call**: read `~/.relay/current/<process.ppid>.json` (Claude Code is the parent process because `mcp.sh` `exec`s node; every hook rewrites that file — §4.0 rule 11), falling back to the newest `current/*.json` whose `cwd` matches the server's cwd, then to the env var. Claims, notifications, decisions and handoffs are therefore attributed to the session that is actually running, and claims are dev-scoped on the hub anyway (§6.3).

Read tools (`status`, `who_is_on`, `impacts`, `handoffs`) fall back to the local snapshot with a "(cached HH:MMZ)" label when the hub is unreachable; write tools return an honest error. The server `instructions` (≤ 500 chars, factual) is where the how-to lives — *"Relay tools report teammates' live sessions, contract changes and handoffs for this project. decide(text) records an architectural decision that appears in teammates' digests; impact_of(path) lists the dependents of a contract file before it is changed; notify(dev, message) reaches a teammate at their next prompt; handoff(summary) stores a session summary."* — and each tool description stays < 1 KB (2 KB truncation applies when tool search is on).

### 9.2 Tools (args → returns; all return compact text plus a `json` block)

| Tool | Args | Returns |
|---|---|---|
| `status` | `{project?: "current"\|"all"}` | per dev → sessions (state incl. "in a long turn", client, branch, worktree, area, objective, last seen), explicit claims, my unacked change sets count, unread inbox count, hub/cache freshness. `all` = manager view across projects (M2 dashboard uses the same query). |
| `who_is_on` | `{target: "<area>"\|"<path or glob>"}` | live sessions and recent editors (24 h) of that area/path: dev, state, branch, objective, files, claims; dirty (uncommitted) files reported at their last prompt. |
| `recent_changes` | `{area?, since?: ISO\|"1d"\|"7d", kind?: "contracts"\|"commits"\|"edits"\|"all"}` | chronological teammate changes with symbols, hunks (contracts only), SHAs, branch, status (incl. `low` candidates and withdrawn ones), plus handoff one-liners; default = my areas + contracts I depend on since my last session. Never transcripts. |
| `decisions` | `{topic?, area?, since?}` | decision records (`explicit` via `decide`, `handoff`-extracted, `auto` low-confidence) with author, date, source handoff id; full-text filter on topic/text. |
| `notify` | `{dev: "<handle>"\|"all", message, ref?: "<path>\|<change set id>", kind?: "fyi"\|"ask"\|"blocker"}` | notification id + delivery note ("priya active at 09:41Z — delivered at her next prompt" / "not active; will see it at her next session start"). |
| `claim` | `{target, note?, ttl?: "4h", hard?: false, keep?: false}` | claim id + any conflicting claims/heat on the target. Claims belong to the developer in this repo (§6.3). |
| `release` | `{target?: "<target>"\|"all"}` | released claim ids. |
| `impacts` | `{mine?: true, ack?: "<change set or impact id>"}` | contract change sets affecting me with per-file symbols, dependents and status; `ack` marks one handled (stops JIT reminders, notifies the author). |
| `impact_of` | `{path?: "<contract path>", sha?: "<commit>"}` | dry run before changing a contract: exported symbols, dependents per repo (live grep + dependency indexes), owners, who is active there. |
| `handoffs` | `{dev?: "me"\|"<handle>", n?: 3, repo?, full?: false}` | latest structured handoffs rendered as markdown (`full` includes per-file lists). |
| `handoff` | `{summary?: {done[], changed[], interfaces_changed[], decisions[], blockers[], next[], notes_to[]}}` | triggers generation now; with `summary` stores `quality: "self"`; returns the record id and markdown. |
| `decide` | `{text, topic?, area?, supersedes?}` | decision id; appears in teammates' digests. |
| `whoami` | `{iam?: "<handle>"}` | dev, source of identity, team, hub URL, repo slug, project, live session id and how it was resolved, cache age, breaker state, plugin commit and whether it is behind, hook firing counts; `iam` writes `~/.relay/identity.json` and asks the hub to merge the placeholder identity (§3.3). |

Skills: `/relay:status` (calls `status`), `/relay:handoff` (asks Claude to summarize and call `handoff`), `/relay:doctor` (calls `whoami`, then checks node path and version, plugin commit vs the marketplace, `config-error.json`, hook error lines in the last transcript, `stats.jsonl` counters, prints fix commands), `/relay:iam <handle>` (calls `whoami` with `iam`), `/relay:mute <target>` (runs `/bin/sh ${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh mute <target>`, which appends to `~/.relay/mute/<repoKey>.json`; `--undo` removes).

### 9.3 SessionStart digest (rendered by the hub, ≤ 6,000 chars; ≤ 2,000 chars in `delta` mode)

````
<relay-digest team="exampleteam" project="acme-portal" repo="github.com/acme/dashboard" dev="deepak" at="2026-09-12T09:41:07Z" freshness="live" since="2026-09-11T17:20Z" mode="full">
## Team now (as of 09:41:07Z)
- priya · app (+contracts) · feat/currency · "Add currency support to invoices" · working, last event 09:40:27Z · files: packages/contracts/src/billing.ts, apps/app/src/billing/service.ts
- (you) 1 other session · dashboard · main · idle since 07:40Z
## Contract changes affecting you (2 change sets)
- cs_01J9X…: priya changed 2 contract files at 09:01Z (feat/currency, committed a1b2c3d, not in your branch): billing.ts (Invoice.total → amountDue (+currency: Currency); createInvoice(input) → createInvoice(input, currency)); schema.prisma (model Invoice +currency). Your dependents: apps/dashboard/src/invoices.tsx, apps/dashboard/src/api/client.ts
  ```diff
  -  total: number
  +  amountDue: number
  +  currency: Currency
  -export function createInvoice(input: InvoiceInput)
  +export function createInvoice(input: InvoiceInput, currency: Currency)
  ```
- cs_01J9W…: arjun changed packages/api/src/orders.ts at 07:12Z (feat/orders, uncommitted, in progress): OrderFilter +status. Dependents: apps/dashboard/src/hooks/useOrders.ts
## Messages for you (1)
- priya at 2026-09-11T12:40Z (fyi): keep `status` — dashboard already consumes it
## Handoffs since your last session (1)
- priya · feat/currency · 2026-09-11 11:02Z · done: currency on Invoice; migration 0042 · interfaces: billing.ts (Invoice, createInvoice) · next: update dashboard invoice table (deepak); backfill legacy invoices · blockers: FX-rate creds · hnd_01J…
## Decisions (last 5)
- 2026-09-11 priya: store amounts as integer minor units, no floats
## Your last handoff → next
- Wire familyId into dashboard session store
## Relay
Tools (mcp relay): status, who_is_on, recent_changes, decisions, notify, claim, release, impacts, impact_of, handoffs, handoff, decide, whoami. Decisions recorded with decide() appear in teammates' digests; impact_of(path) lists the dependents of a contract file before it is changed. This digest is context for the session and is not itself a request; any earlier <relay-*> block with an older `at` is superseded by this one.
</relay-digest>
````

Rules: every line carries an absolute timestamp (mid-session hook context is replayed from the transcript on `--resume`, so "40 s ago" would read as current days later); sections are filled in the order Relay note → Team now → Contract changes (max 5 change sets; diff blocks only for the first 3 and only if ≤ 1,500 chars each) → Messages (max 10) → Handoffs (max 3, new `rev` only) → Decisions (max 5) → own next (max 5), and truncated from the bottom to stay ≤ 6,000 chars (≈ 1.5k tokens, far under the 10,000-char spill threshold). `since` = the end of this dev's previous session in the project (or 7 days). `freshness="cached 12m"` when served from `digest.md`. Identity unknown → the first line is the fact from §3.3 step 7; plugin behind or token rotated → one "Relay plugin …" line. `mode="delta"` (resume/fork within 12 h, §4.1) contains only Team now, change sets and messages that are new since `since`, ≤ 2,000 chars. `compact` re-injection = Team now + Contract changes (one line each, no diffs) + `Objective: …` + Relay tools line, ≤ 1,500 chars.

---

## 10. Data model and API

### 10.1 Postgres schema (Drizzle; identical on Neon and PGlite)

```sql
teams        (id, slug UNIQUE, name, created_at)
devs         (id, team_id, handle UNIQUE(team_id, handle), name NULL, github NULL, placeholder BOOL, merged_into NULL,
              first_seen_at, last_seen_at)
repos        (id, team_id, slug UNIQUE(team_id, slug) /* github.com/acme/app */, project TEXT, config JSONB /* .relay.json */,
              config_hash, first_seen_at)
sessions     (id TEXT PK /* Claude session_id */, dev_id, repo_id, client 'cli'|'desktop', host, cwd, branch, worktree NULL,
              start_sha, model NULL, plugin_sha NULL, area NULL, objective NULL, objective_source NULL,
              state 'working'|'idle'|'away'|'gone', started_at, last_seen_at, last_edit_at, last_prompt_at, in_turn_since NULL,
              ended_at NULL, end_reason NULL /* clear|resume|logout|prompt_input_exit|other|crash|timeout */, edit_count INT,
              git_email_hint NULL)                      INDEX (repo_id, last_seen_at DESC)
events       (id TEXT PK /* client ulid, idempotent */, at /* client */, server_at, replay BOOL, team_id, repo_id, dev_id, session_id,
              type 'prompt'|'edit'|'contract'|'retract'|'commit'|'push'|'branch'|'task'|'turn_end'|'session_start'|'session_end',
              path NULL, area NULL, sha NULL, payload JSONB)   INDEX (repo_id, server_at DESC), INDEX (session_id, server_at),
              UNIQUE (repo_id, type, sha) WHERE type IN ('commit','push'),   30-day retention
heat         (repo_id, path, dev_id, session_id, branch, kind 'edit'|'dirty'|'commit', last_at /* server-stamped, only moves forward */,
              count, pushed BOOL, blob_id NULL, head_sha NULL, PK (repo_id, path, session_id, kind))   -- materialized from events; snapshot source
claims       (id, repo_id, dev_id, session_id NULL /* metadata only */, target /* area|path|glob */, note, hard BOOL, keep BOOL,
              created_at, expires_at, released_at NULL)                                                 -- dev-scoped (§6.3)
change_sets  (id TEXT PK /* cs_ulid */, repo_id, dev_id, session_id, branch, status, priority, first_at, last_at, stable_since,
              acked JSONB /* {dev: at} */)
impacts      (id TEXT PK, change_set_id, repo_id, dev_id, session_id, path, symbols TEXT[], kinds TEXT[], summary, hunk NULL, hash,
              blob_id NULL, branch, status 'uncommitted'|'committed'|'pushed'|'merged'|'withdrawn', commit_sha NULL, patch_id NULL,
              author_email NULL, rev INT, superseded_by NULL, created_at, updated_at /* server */)
              UNIQUE (repo_id, session_id, path, hash)   INDEX (repo_id, path, updated_at DESC)
impact_targets (change_set_id, dev_id, repo_id, dependents JSONB /* [{path, area, via: import|depends|basename}] */,
              priority 'high'|'normal'|'low', delivered_at NULL, acked_at NULL, ack_note NULL, PK (change_set_id, dev_id, repo_id))
notifications (id TEXT PK, team_id, repo_id, to_dev_id, from_dev_id NULL, kind 'impact'|'note'|'collision'|'handoff',
              ref_id NULL /* change set / handoff id */, body, created_at, delivered_at NULL, delivered_via NULL)   INDEX (to_dev_id, delivered_at)
turns        (session_id, prompt_id, at, text /* ≤ 3000 chars, prose, redacted */, PK (session_id, prompt_id))   -- upserted; 40 per session, 7-day retention
handoffs     (id TEXT PK, session_id UNIQUE, dev_id, repo_id, project, branch, worktree NULL, rev INT, quality
              'heuristic'|'llm'|'self', objective, areas TEXT[], done JSONB, changed JSONB, interfaces_changed JSONB,
              decisions JSONB, blockers JSONB, next JSONB, commits JSONB, notes_to JSONB, markdown TEXT,
              started_at, ended_at NULL, end_reason NULL, generated_at)   INDEX (project, generated_at DESC)
handoff_drafts (session_id PK, at, draft JSONB)          -- last Stop draft; promoted by the sweep
decisions    (id TEXT PK, repo_id, project, dev_id, session_id NULL, topic NULL, area NULL, text, source
              'explicit'|'handoff'|'auto', confidence REAL, supersedes NULL, created_at)   INDEX (project, created_at DESC)
dev_repo     (dev_id, repo_id, home_areas TEXT[] /* learned, top-2 by edits/14d */, last_seen_at, last_session_end_at NULL,
              PK (dev_id, repo_id))
depindex     (repo_id PK, head, built_at, imports JSONB, symbols JSONB, contract_paths JSONB)
meta         (key PK, value JSONB)                       -- last_sweep_at (conditional-update lock), schema version
```

Write semantics that the schema enforces (v1.1): events are idempotent by `id` *and* semantically — a commit/push SHA exists once per repo, a contract hash once per (session, path), and `heat.last_at` is upserted with `GREATEST`; presence fields are updated from `server_at` for live events and never from replays (`replay = true` or `at < sessions.ended_at`), so a drained outbox cannot revive an ended session or move its branch/objective back in time; handoff generation and the sweep are serialized as described in §8.1 and §6.2.

### 10.2 Snapshot document (returned on every hub response; the local cache)

```jsonc
{ "v": 1, "fetchedAt": "…" /* client clock, written by the client */, "serverTime": "…",
  "repo": { "slug": "github.com/acme/dashboard", "project": "acme-portal", "config": { /* effective .relay.json */ } },
  "me": { "dev": "deepak", "sessionId": "…" },
  "sessions": [ { "dev", "id", "client", "host", "branch", "worktree", "area", "objective", "state", "lastSeenAt", "lastEditAt", "inTurnSince" } ],   // all live in this project (incl. mine), 2 h window
  "heat":     [ { "path", "dev", "sessionId", "mine", "branch", "objective", "kind", "at" /* serverAt */, "pushed", "headSha", "blobId" } ],
              // this repo, 24 h, own sessions included (mine: true); caps per kind: edit 300, commit 100, dirty 100 (dirty never evicts edit)
  "claims":   [ { "id", "dev", "target", "note", "hard", "expiresAt" } ],                                                        // others', unexpired
  "changeSets": [ { "id", "by", "branch", "status", "priority", "at", "impacts": [ { "id", "rev", "path", "symbols", "summary", "hunk", "blobId", "commitSha", "status" } ],
                    "dependents": [ { "path", "area", "via" } ] } ],                                                            // targeting me, routable (debounced), unacked, ≤ 7 d; dependents filtered to THIS repo
  "inbox":    [ { "id", "kind", "from", "body", "ref", "at" } ],                                                                // undelivered notifications for me
  "warn":     [ "token-rotated" ],                                                                                              // optional; rendered as one digest line
  "minClient": 1 }
```
Size ≈ 5–30 KB; computed in ~20 ms from indexed tables and served for `GET /v1/snapshot` from a per-repo in-memory cache at module scope (≤ 10 s TTL, invalidated by any write for that repo in the same instance) so the prompt-path refresh does not touch Postgres on a warm instance.

### 10.3 Local files (`$RELAY_HOME`, default `~/.relay`)

```
identity.json              {dev, source, at}
node-path                  cached absolute path of a Node ≥ 18
down-until  down-count     circuit breaker (workers only); config-error.json {status, message, at} for 401/426/413
refresh-wanted             touched by a sync-path timeout or a stale pre-edit read; serviced by the next worker
plugin-remote.json         {sha, checkedAt} from git ls-remote of the marketplace (24 h)
statusline.sh  statusline-chain   status line renderer copied from the plugin; the user's own statusLine command, if any (§4.11)
current/<CLAUDE_PID>.json  {sessionId, cwd, repoKey, dev, at, statusline}  — liveness + live-session lookup for MCP and the status line
cache/<repoKey>/snapshot.json (§10.2)   digest.md   statusline.txt   ancestry.json {headSha, contains:{sha:bool}, merged:{cs:bool}}
                state.json {lastReportedSha:{branch:sha}, depindexHead, depindexAt}   (rewritten under bg/<job>.<repoKey>.lock only)
sessions/<session_id>/     meta.json  events.jsonl (+ rotated events.<n>.jsonl, fold.json)  marks/{seen.*,jit.*,noted.*,asked.*,snooze.*,stop.*,ended}
                           pending  draft.json  .lock/            (a dir per session; swept 7 days after `ended`)
mute/<repoKey>.json        per-machine mutes from /relay:mute
outbox/<ulid>.json         write-ahead log of every POST body (deleted on 2xx; 7-day expiry, 24 h for presence-only kinds)
bg/<job>.<repoKey>.lock/   single-flight worker locks (stale after 30 s)
log/relay.log  log/stats.jsonl   debug; per-event hook counters for /relay:doctor
```

### 10.4 API (Hono; all under `/v1`; JSON; auth on every route except `/health`)

Headers: `Authorization: Bearer <team token>` (current or previous token during the 14-day rotation grace, §3.3), `X-Relay-Dev: <handle>`, `X-Relay-Session: <session_id>` (informational; bodies carry their own session id, which wins for replays), `X-Relay-Client: cli|desktop|mcp`, `X-Relay-Proto: 1`, `X-Relay-Plugin: <plugin commit>`. Unknown handles are upserted (self-declared identity, §3.3). Responses carry `snapshot` wherever noted.

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| `GET /health` | — | `{ok, version}` | unauthenticated |
| `POST /v1/session/start` | `{v, session{…}, mode, since?, recentShas[], identityHint{gitEmail, placeholder?}}` | `{digest, snapshot, minClient, warn?}` | upserts session/repo/config; merges a placeholder dev into the real handle when `identityHint.placeholder` is set and the handle is known; computes the digest since `dev_repo.last_session_end_at` (or `since` in delta mode); runs the lazy sweep |
| `POST /v1/events` | `{session{presence fields}, events[], delivered?: [ids], replay?: bool}` | `{snapshot, inbox}` | idempotent by event id and by semantics (§10.1); updates heat/impacts/change sets/notifications; marks `delivered`; replays never revive or rewind presence |
| `POST /v1/session/end` | `{sessionId, reason, files, commits, draft, replay?}` | `{ok}` | presence gone; dev's claims in the repo released if no other live session (unless keep); `waitUntil(handoff)` under the per-session advisory lock |
| `GET /v1/snapshot?repo=` | — | `snapshot` | cheap refresh (prompt path); in-memory cached per repo |
| `POST /v1/depindex` | `{repo, head, builtAt, imports, symbols, contractPaths}` | `{ok}` | replaces the row |
| `GET /v1/query/status?project=` `…/who_is_on?target=` `…/recent_changes?area&since&kind` `…/decisions?topic&area&since` `…/handoffs?dev&n&repo&full` `…/impacts?mine` `…/impact_of?path\|sha` | — | tool payloads (§9.2) | read tools |
| `POST /v1/notify` `/v1/claim` `/v1/release` `/v1/decide` `/v1/ack` `/v1/handoff` | tool args | tool results | write tools |
| `POST /admin/token/rotate` `GET /admin/export?project=` `DELETE /admin/purge?repo=` | — | — | admin token only |

Errors: `401` bad token (client: configuration error, 10-min breaker, one digest line with the update commands), `426` client too old (`{minClient, message}`; same client handling), `413` payload > 256 KB (dropped, logged), `429` (per-team 60 req/s soft limit; treated as an outage), `5xx` → counts toward the worker breaker. Everything is single-tenant per shop; `teams` exists only so a second shop could reuse the deployment.

---

## 11. Security and privacy

### 11.1 What leaves the developer's machine (and to where)

| Data | Default | Destination | Knob |
|---|---|---|---|
| Handle, host name, client (cli/desktop), repo slug, branch, worktree name, project, plugin commit | yes | hub | — |
| Repo-relative paths of files Claude edited, edit counts, timestamps; dirty paths at prompt time (lockfiles/generated excluded) | yes | hub | — |
| Derived objective (≤ 140 chars, redacted) | yes | hub | `privacy.objective_from_prompts: false` → task/branch only; `[private]` prompt prefix skips one prompt |
| Raw prompt text | **no** | — | `privacy.send_prompts: true` sends ≤ 2,000 chars redacted (improves LLM handoffs) |
| Contract hunks (≤ 1,500 chars, `-U0`, redacted) and symbol names, blob ids | yes (contract files only) | hub → affected teammates' Claude | `privacy.send_diffs: "none"` → symbols only |
| **Prose** of `last_assistant_message` at each Stop (≤ 3,000 chars; fenced code blocks, inline code > 80 chars, diff and stack-trace lines stripped client-side, then redacted) | yes | hub (turns, 7-day retention) → handoff synthesizer | `privacy.send_turns: "full"` keeps code (better `done/next` on code-heavy sessions); `false` → heuristic handoffs lose most `done/next` quality |
| Own commit SHAs + subjects, pushed flags, patch ids | yes | hub | — |
| Completed task subjects | yes | hub | — |
| `notify`/`decide`/`claim` text | yes (explicit tool calls) | hub | — |
| Handoff packet (the rows above for one session, ≈ 6–9k tokens) | when `ANTHROPIC_API_KEY` is set | Anthropic API (same provider the session already used) | `handoff.llm: false` |
| Transcripts, file contents outside contract hunks and assistant prose, env vars, tokens, `~/.claude` contents | **never** | — | — |

The honest summary for a client's security questionnaire (v1.1): *file paths, contract-file diff hunks, and the prose of Claude's replies leave the machine; source files, prompts and transcripts do not.* The previous wording ("file contents never leave") was false because a full assistant turn routinely quotes code. Data sits in Deepak's Vercel project and its Neon database (region chosen at `vercel integration add neon`; the developer note states it), and, when synthesis is on, transiently at the Anthropic API.

Every text field passes `redact()` before leaving the machine: AWS keys (`AKIA…`, secret patterns), GitHub tokens (`ghp_`, `gho_`, `github_pat_`), Slack (`xox[abp]-`), Stripe (`sk_live_`, `rk_live_`), Anthropic/OpenAI keys (`sk-ant-`, `sk-`…), **Relay team tokens** (`rt_[A-Za-z0-9]{32,}` — Claude can read `team.json` in the plugin cache and could echo it), JWTs (`eyJ…\.…\.…`), private key blocks, `Authorization:`/`password=`/`token=` values, and high-entropy base64 strings ≥ 32 chars → `[redacted]`.

### 11.2 Secrets and trust

- `RELAY_TEAM_TOKEN` (+ `RELAY_TEAM_TOKEN_PREV` during rotation; shared, in the private plugin repo and Vercel env), `RELAY_ADMIN_TOKEN`, `DATABASE_URL`, `ANTHROPIC_API_KEY` live only in Vercel env (never in client repos, never in `.relay.json`). Rotation: §3.3.
- Trust model: team token + self-declared handle = "anyone who can clone `your-org/relay-plugin` is a teammate". Adequate for 4 people; per-dev invite tokens with revocation are an M2 upgrade (the `login` flow from the hosted proposal), see open question 2.
- The hub is single-tenant, TLS-only, hosted in Deepak's Vercel account; `DELETE /admin/purge?repo=` wipes a finished engagement; `GET /admin/export` dumps it first. Events/turns are purged after 30/7 days; handoffs, decisions, impacts are kept.
- Client repos only ever contain `.claude/settings.json` (marketplace reference, permission rules, status line) and `.relay.json` (area map, handles) — no secrets, no URLs to the hub. Client-owned repos get the `settings.local.json` variant by default (§3.1).
- `deny`-mode claims are enforced only for Claude-driven edits (PreToolUse fires before permission checks in every mode, including `bypassPermissions`) and never for a human's editor — a guardrail, not a lock.

### 11.3 Fail-open matrix

| Failure | Effect | Never happens |
|---|---|---|
| Hub down / slow / DNS failure | a sync-path refresh times out at most once per TTL and keeps the cache; two worker failures open the breaker for 60 s at a time; PreToolUse uses the cached snapshot with the staleness ladder; digest served from cache; every POST body is already in the WAL and is drained later | a blocked edit, a hung edit hook > 0.9 s, a hung prompt > 1.6 s, a hung session start > 3.5 s, "Relay offline" from a single slow request |
| Hub cold start / Neon resume on the first request after a pause | the 1,500 ms first-refresh budget usually absorbs it; otherwise the cache is used and the worker refreshes within seconds | the breaker opening on one cold start |
| Node not found or < 18 | every hook is a silent no-op; `/relay:doctor` reports it | `<hook> hook error` noise (hook.sh exits 0) |
| Uncaught exception / unhandled rejection in a hook | crash guards exit 0 with no output | `<hook> hook error` noise |
| Snapshot missing/corrupt | no decisions, no context | a deny |
| Hook JSON contract drift after a Claude Code upgrade | field read defensively → no output; `stats.jsonl` counters stop moving → doctor flags "no PreToolUse in last session" | a crash surfaced to the user |
| Parallel hooks / subagents writing session state | append-only journal + `wx` marks; lock-guarded rewrites | a repeated ask, a repeated notice, lost file counts |
| `/clear` while the MCP server keeps the old session id | MCP resolves the live session per call via `current/<ppid>.json`; claims are dev-scoped | claims held by a dead session |
| `git pull` / `merge` / `rebase` / `checkout` | author-filtered commit scan; merge-base-bounded reconciliation; branch event resets `startSha` | teammates' commits attributed to the puller; cross-branch diffs; impact floods |
| SessionEnd/Stop worker killed (`/exit`, `-p` teardown, `SessionEnd` budget) | the WAL entry survives and is drained by the next worker; the liveness sweep ends crashed sessions | a lost `session/end`, a lost final turn, a 2 h ghost while any Relay session is alive on the machine |
| `claude` Ctrl-C / crash / laptop closed | last Stop draft stands; local liveness sweep (next Relay worker on the machine) or the 2 h hub sweep ends the session and promotes the draft | lost handoff |
| Token rotated | previous token accepted for 14 days; one digest line names the update commands; then `401` = configuration error, 10-min breaker, no outbox backlog | thousands of stale events replayed after a fix; silent breaker loops |
| LLM synthesis fails | heuristic handoff stands, labelled | blocked session end |
| Wrong identity | placeholder `unknown-<host>` sessions tracked per machine; digest states the fact and names `iam` | silent misattribution to another teammate; two new developers merged into one |
| Headless `-p` / `dontAsk` / subagent hits a HOT file | context only (rule 14) | an `ask` turning into a hard deny in a script |

---

## 12. Milestones

### M0 — two-terminal demo on one Mac, through the real install path (8 dev-days)

**Day 1 (first, before any product code): the platform experiments** — Appendix B items 1–5 answered on CLI 2.1.236 and Desktop 2.1.260 with a one-line result each in `docs/verified.md`. They decide the onboarding sentence, the update story, the permission rule and whether Desktop produces SessionEnd at all; leaving them to M1 would mean building on a guess. The experiment rig is the same one the demo uses: a local bare marketplace repo (`/tmp/relay-mkt.git` with `.claude-plugin/marketplace.json` + `plugin/`), a scratch repo whose `.claude/settings.json` points at `{"source":"git","url":"file:///tmp/relay-mkt.git"}`, `rm -rf ~/.claude/plugins/cache/relay`, then `claude` and the trust dialog.

**Days 2–8:** monorepo scaffold; `packages/core` (config, git with author filters, repo, area, objective, contracts/symbols, prose stripping, redaction, journal + marks, cache, outbox WAL, http/breaker, protocol); `packages/hooks` with all verbs of §4 including `bg` and the liveness sweep; `packages/plugin` (hooks.json, scripts incl. `statusline.sh`, team.json template, skills); `packages/mcp` with the 13 tools and per-call session resolution; `apps/api` on PGlite with the full schema, snapshot (in-memory cache), digest (full/delta/compact), presence incl. in-turn, change sets + debounce + retract, impact routing (in-repo dependents + `depends`), heuristic + LLM handoffs with the advisory lock, lazy sweep with the conditional-update lock, dual-token auth; `examples/demo-repo`; `scripts/demo.sh`; `scripts/publish-plugin.sh`; `pnpm test:hooks` (replays `scripts/smoke/*.json` stdin fixtures through `dist/hook.mjs` against the local API, asserts stdout JSON shapes, exit codes, and p95 timings: pre-edit < 120 ms, prompt < 150 ms without a refresh; runs 8 parallel pre-edit/post-edit processes on one session and asserts exactly one `ask` and no duplicate notes; replays a `git pull` of 50 foreign commits and asserts zero commit events); unit tests for symbol extraction, objective/area rules, prose stripping and redaction.

Demo script (the acceptance test, ≈ 8 min after a 2-min setup; runs through the real install path so the onboarding *is* the demo; `pnpm demo up --plugin-dir` is the fast variant for hook iteration):

```bash
cd "~/relay" && pnpm install && pnpm build && pnpm demo up
#  → API on http://localhost:8787 (PGlite .data/), team token "demo", identities priya (app) and arjun (dashboard)
#  → /tmp/relay-demo/mkt.git (bare marketplace: marketplace.json + plugin/ with a demo team.json), /tmp/relay-demo/origin.git,
#    two clones app-priya/ app-arjun/ of examples/demo-repo whose .claude/settings.json point at file:///tmp/relay-demo/mkt.git
#    (.relay.json: project acme-portal, repo override demo/app; git user.email priya@demo / arjun@demo per clone; statusLine written;
#     settings.json "env": {RELAY_HOME: /tmp/relay-demo/home-<dev>, RELAY_DEV, RELAY_HUB: http://localhost:8787, RELAY_TOKEN: demo, RELAY_SNAPSHOT_TTL_MS: 15000}
#     — project env reaches hooks, the MCP server and the status line after trust, so the terminals need no exports)
# Terminal A (priya)
cd /tmp/relay-demo/app-priya && claude
#   accept the trust dialog → plugin auto-installs from the local marketplace (if B.1 says "next session", the script says /exit and relaunch here)
> Add an optional `status: OrderStatus` field to OrderFilter in packages/contracts/src/orders.ts and use it in apps/app/src/api/orders.ts. Commit.
# Terminal B (arjun), while A works
cd /tmp/relay-demo/app-arjun && claude
#  1 PRESENCE  status line: "relay ● priya contracts (+app) main 09:41"; ask "What is priya working on right now, and does it touch my area?"
#              → Claude answers from the digest; /relay:status agrees
> Add a status column to apps/dashboard/src/OrdersTable.tsx — first check whether any contract I depend on changed.
#  2 IMPACT    A's commit routed the change set (committed → no debounce). It reaches B EITHER in the digest (if it landed before B started)
#              OR as <relay-inbox> at this prompt (if after; TTL 15 s), never both; the JIT note on B's first Read/Edit of hooks/useOrders.ts
#              appears only if the prompt did not already deliver it (once per change set per session). Claude names OrderFilter.status.
> Now rename status to orderStatus in packages/contracts/src/orders.ts
#  3 COLLISION permission prompt: "Relay: priya is editing packages/contracts/src/orders.ts (branch main, last edit 09:43:10Z, …). Allow this edit?" → No
> Tell priya to keep `status`; the dashboard already consumes it
#  4 NOTIFY    Terminal A: status line shows "· 1 note"; at A's next prompt ask "Any messages from arjun?" → Claude relays the NOTE
# Terminal A: /exit          →  5 HANDOFF synthesized within ~10 s (SessionEnd worker + waitUntil; heuristic immediately; LLM if ANTHROPIC_API_KEY is set)
# Terminal B: "Show priya's latest handoff" → handoffs tool; /exit; relaunch → 6 DIGEST lists the handoff, the change set (committed, not in your branch), decisions
pnpm demo down
```

Exit criteria: all six moments visible on CLI **and** on Desktop (the engine on this Mac); `pnpm test:hooks` green including the parallel-hook and pull-attribution cases; no `hook error` line in any transcript; `/relay:doctor` clean; `docs/verified.md` answers Appendix B items 1–13; Desktop's SessionEnd behaviour on tab close / app quit recorded.

### M1 — two machines, one real client project, hosted (5 dev-days)

Vercel (Pro) + Neon deployment (`pnpm db:push`, env incl. `RELAY_TEAM_TOKEN_PREV`, `vercel deploy --prod`); create and publish `your-org/relay-plugin` via `scripts/publish-plugin.sh` + the CI workflow; verify auto-install after trust on a fresh macOS user account with no SSH key (documents the one per-dev prerequisite) on CLI 2.1.236 and Desktop 2.1.260; `init-project` on both repos of one client project (one `--local`); cross-repo routing via `depindex` upload + `depends`; author-filtered `lastReportedSha` backfill; squash-merge auto-ack by blob id; identity edge cases (`iam`, noreply emails, placeholder merge); token rotation rehearsal (old token keeps working, digest line appears, `401` after the grace is a config error); crash rehearsal (`kill -9` a session → the other session's next prompt ends it); `/relay:doctor` (plugin commit vs marketplace, update commands, hook counters, config errors); breaker/outbox behaviour verified with the hub stopped and with Neon suspended; Appendix B items 14–18; README + a one-page "for developers" note (prerequisite, what the status line means, the two manual commands, data location); privacy defaults reviewed with Deepak. Exit: two developers on two Macs run the M0 script against the hosted hub with presence lag < 5 s for `working`, `gone` within 10 s of `/exit`, and no manual step beyond the prerequisite and the trust dialog.

### M2 — P1 items (≈ 6 dev-days, pick in order)

1. `apps/web` dashboard (2 d): live board polling `/v1/query/status?project=all`, per-dev timeline, change sets, handoffs, plugin versions per dev; manager view across client projects.
2. Per-dev invite tokens + `login` tool + revocation (0.5 d) if open question 2 says so.
3. Channels push (1 d, optional, research preview): the same MCP server declares `capabilities.experimental['claude/channel']`; devs opt in per session with `--dangerously-load-development-channels server:relay`; events land on the next turn — a heads-up while idle, nothing more.
4. Markdown handoff archive export (0.5 d) to a git repo (Egregore-compatible frontmatter) for teams that want a browsable history.
5. ts-morph dependency graph for TS repos (1 d) to replace regex import parsing where precision matters.
6. Cursor/Codex adapters spike (1 d): map their hook/extension surfaces onto the same `/v1/events` contract.

**v0 = M0 + M1 = 13 dev-days** (was 10; the refutation fixes — author filtering, WAL + liveness sweep, journal marks, change sets/debounce, ancestry-by-content, the experiments-first day and the plugin repo — add about three).

---

## 13. Open questions for Deepak (each changes the build)

1. **Handoff synthesis model/key.** Provision one Anthropic API key on the hub for server-side synthesis (default Haiku 4.5, ≈ $0.30/day for 4 devs; Opus 5 ≈ $1.50/day) — or ship v0 heuristic-only (no key, noticeably weaker `done/next/decisions`), or run synthesis on each developer's machine with `claude -p` on their subscriptions (no key, but a detached process after session end, keychain auth, Desktop `CLAUDE_CODE_EXECPATH` handling — ~1.5 extra days and more failure modes)? The design assumes the first.
2. **Identity/auth.** Shared team token in the private plugin repo + git-email identity (zero developer steps; teammates could impersonate each other; rotation = 14-day dual-token grace, no plugin update dependency) — or per-developer invite links pasted once into Claude (revocable per dev, one extra onboarding motion, `login` tool must be reachable in the first session)? The design assumes the first; the second is a 0.5-day M2 add-on.
3. **Client-owned repos.** Which of the current client repos live in a *client's* GitHub org? Those get `init-project --local` (nothing committed; one command per developer per clone); ours get the committed variant, which makes `.relay.json` (area map + your developers' handles) and the marketplace reference visible to anyone with repo access. If a specific client would object even to the committed no-secret files, say which, and it goes on the `--local` list.
4. **How the two repos of a project share contracts.** Published/workspace package (`@client/contracts` — the dependency index matches by package name, high confidence) or copied type files (symbol-name matching only, `confidence: low`, more `depends` reliance)? This decides how much of §7.4 M1 builds first.
5. **Privacy defaults for client work.** Default is: derived objective + paths + contract hunks + the *prose* of Claude's replies (code stripped, ≤ 3,000 chars) go to your hub; raw prompts and source files never; the hub is your own Vercel/Neon. Is that acceptable for all clients, or should some engagements default to `send_turns: false` / `send_diffs: "none"` (weaker handoffs and JIT notes)?
6. **Hosting plan.** Vercel Pro (≈ $20/month, required for commercial use of the hub and for `maxDuration: 60`) plus Neon Launch with compute auto-suspend off (≈ $19/month, removes the 0.5–1.5 s resume that otherwise hits the first request after every quiet stretch) — or free tiers and accept more cold-start refreshes (the budgets and breaker rules cope, but the first prompt after a pause is slower more often)? The design assumes the paid tiers.

---

## Appendix A — Decisions and grafts (traceability)

| Decision | Chosen | Source / reason |
|---|---|---|
| Storage of truth | Hosted Hono + Postgres (Neon/PGlite) | Hosted edition (P2); judges 1 & 3 winner; sub-second presence without daemon or git contention |
| Snapshot on every response; PreToolUse cache-only | yes | P2; makes the critical hook a file read |
| Circuit breaker `down-until` | yes, workers-only, two failures, config errors separate | P2; refutation (distributed §6, adoption §6) |
| Node resolver `hook.sh` / `mcp.sh`, exec form via `/bin/sh` | yes, with a Node ≥ 18 probe | P1/P3; judge 1 & 2 required fix for Desktop PATH; refutation (hook-mechanics §3) |
| UserPromptSubmit cache-first, throttled refresh, prompt POST in a detached worker | yes; no git on the sync path | judges 1–3 (cold-start stalls) + P1's pattern; refutation (distributed §2, adoption §10) |
| Internal deadlines below declared timeouts; exit 0 always | yes; async `execFile` only, crash guards | P3; refutation (hook-mechanics §1, §3) |
| Staleness ladder deny→ask→context; heat timestamp checks | yes, with same-clock age arithmetic | P3 + P1 ("never ask on stale data"); refutation (distributed §13) |
| Collision ask dedup: 30-min snooze per (path, dev) | yes, via `asked`/`snooze` marker files confirmed by the landing edit | P4 (30 min) over P3 (10 min); refutation (hook-mechanics §6) |
| Cross-repo impact via uploaded per-repo dependency index + `depends` map | yes; generic basenames excluded | P4 (depindex) + P1 (`depends`); judge 3's blocking fix for the two-repo case; refutation (distributed §17) |
| Impact status ladder uncommitted→committed→pushed→merged | yes, merged by SHA *or* content (blob id / hunk lines) | P4; refutation (distributed §8) |
| Impact merge/supersede within 30 min; last-20-SHA + `lastReportedSha` backfill | yes, author-filtered, capped at 50 | P2 + P4; refutation (distributed §1) |
| JIT on Read via 6 ms guard file | yes, per session | P1 (judge 3); write tools remain the primary JIT point (P3); refutation (hook-mechanics §10) |
| Draft handoff at every Stop; sweep promotes after 2 h; idle interim at 20 min (`rev+1`) | yes; interim only from the idle state; per-session advisory lock | P4 + P3; replaces P3's daemon PID check (no daemon); refutation (distributed §12, §18) |
| Lazy sweep on requests instead of a cron | yes, conditional-update lock; no `crons` in vercel.json | judges 1 & 2 (Vercel Pro dependency removed); refutation (adoption §9) |
| Objective: task > prompt heuristics > branch; no per-prompt LLM | yes; task from `TaskCreated`/`TaskCompleted` | P1/P3/P4 heuristics; judge 3 cost note; refutation (hook-mechanics §12) |
| Handoff LLM tier server-side, Haiku 4.5 default, key optional | yes | P2 mechanism, judges' model/cost guidance |
| `self` handoff tier via `/relay:handoff` | yes | P1 |
| Egregore frontmatter contract for markdown rendering | yes | P4 (judges 1–3: adopt the format, not the runtime) |
| `impact_of` dry-run tool, `[private]` prefix, learned owners | yes | P4 |
| Outbox as a true write-ahead log (append before POST, delete on 2xx) | yes | Egregore's graph WAL pattern (prior-art.md); refutation (hook-mechanics §9, distributed §5) |
| Session-level `startSha` diff at Stop | yes, merge-base-bounded and author-filtered | P1; refutation (distributed §1) |
| Secret redaction + `send_prompts` default off | yes; `send_turns: "prose"` default; `rt_` tokens redacted | P1; judges 1 & 2 privacy default; refutation (adoption §5) |
| No `systemMessage` on PreToolUse | removed | judge 1 (discarded on that event) |
| SessionEnd budget claim | corrected: plugin timeouts do not raise the 1.5 s budget; SessionEnd does no git/fetch, only WAL + detached worker | docs/research/hooks.md; refutation (hook-mechanics §1, adoption §8) |
| No `--permission-prompts none` or other ≥ 2.1.237 flags | yes | judges 1–3 (CLI is 2.1.236) |
| Identity: shared token + git email (no invite link in v0) | yes; per-machine placeholder for unknown | judge 2 (invite link = third motion, depends on MCP in first session); open question 2; refutation (distributed §15) |
| Smoke test replaying hook stdin fixtures | yes, plus parallel-hook and pull-attribution cases | P3 |

**Refutation fixes (v1.1), by source:**

| Issue | Fix in this document |
|---|---|
| `spawnSync` blocks the watchdog; SessionEnd can exceed 1.5 s | §4.0 rules 1, 7; §4.9 (WAL + detached worker, no git/fetch); §4.2/§4.3 (no git on sync paths) |
| Journal read-modify-write races lose snooze/dedup/file counts | §4.0 rule 9 (append-only `events.jsonl`, `wx` marks, `mkdir` lock) |
| Node crash / Node < 18 → `hook error` on every event | §4.0 rules 1–2, `hook.sh` version probe, `/bin/sh` |
| `fork` not matched; stale `repoRoot` after `/cd` | §4.0 (no SessionStart matcher, CwdChanged hook), rule 10 |
| Token rotation relies on unverified project `autoUpdate` | §3.3 dual-token grace; §3.4 client-side behind check; Appendix B.3 |
| Snooze cannot observe the user's answer; parallel Edit calls prompt repeatedly | §4.3/§4.5 `asked` → `snooze` via the landing edit |
| `ask` becomes a hard deny in `-p`/`dontAsk`/subagents | §4.0 rule 14 |
| Imperative injected context | §4.0 rule 15; §9.1 `instructions`; §9.3 tail |
| `stop_hook_active` early exit drops turns | §4.8 (turns keyed by `prompt_id`, upserted) |
| Global `pending` marker wrong across repos and sessions | §4.4 per-session `pending` |
| MCP frozen session id after `/clear`; claims linger | §9.1 per-call resolution via `current/<ppid>.json`; §6.3 dev-scoped claims |
| Stdin assumptions (`permission_mode`, `resume` reason, TaskCreate shapes) | §4.0 stdin list; §4.7; §4.9 |
| `git pull`/merge/checkout attributed to the puller (blocker) | §4.0 rule 7; §4.6; §4.8; §7.2 (author filter, merge-base, hub-side author check) |
| Killed SessionEnd/Stop leaves 2 h ghosts | §4.0 rules 6, 11 (WAL, liveness sweep); §4.9 |
| Cold starts open the breaker; 401 backlog replay | §4.0 rule 5; §4.2 budgets; §10.2 in-memory cache; §3.1 Neon note |
| Idempotency only by ULID; replays revive sessions | §10.1 write semantics; §10.4 |
| Squash merges defeat SHA auto-ack / WARM | §4.12 ancestry by content; §6.3; §7.2 |
| Per-path impact noise; uncommitted experiments routed instantly; reverts re-arm | §7.5 change sets, debounce, retract, priority rule; §4.3 JIT caps |
| Sweep/handoff double execution on Neon | §6.2 conditional-update lock; §8.1 advisory lock + `ON CONFLICT` |
| Clock skew across machines | §4.0 rule 16; §10.1 `server_at` |
| SAME_DEV undetectable; heat cap eviction | §10.2 `mine: true`, per-kind caps |
| Two unknown devs merged into one | §3.3 per-machine placeholder + hub merge |
| Relative times replayed on resume; full digest per resume | §9.3 absolute timestamps; §4.1 delta digest |
| Grep 300 ms silently returns nothing; generic basenames over-route | §7.3 (2 s + depindex fallback); §7.4 |
| Long turns read as idle and trigger interim handoffs | §6.2 in-turn state; §8.1 |
| First-session hook liveness, Desktop, autoUpdate, permission-rule form unverified until M1 | §12 M0 day 1; Appendix B reordered |
| Git auth decided per repo instead of per developer | §3.1 github shorthand; §3.2 one prerequisite |
| "No file contents leave" is false; cost understated | §11.1 prose default + honest summary; §8.2 packet size and cost |
| Relay invisible to the human | §2.1 note; §4.11 status line; §4.2 `systemMessage` (if verified); §12 demo prompts |
| Hobby cron rejection; unstated plan | §2.3 vercel.json; §3.1 plan note; open question 6 |
| Monorepo as marketplace bloats every dev's clone and update stream | §2.3 `relay-plugin` repo + publish script |
| Client-owned repos get a broken marketplace reference | §3.1 `--local` rule |
| Demo moment 2 promised two deliveries where one occurs | §12 script (either/or, TTL 15 s) |

**Suggested fixes not adopted, and why:** ending "prior sessions of the same dev+host+cwd" on a new SessionStart (§6.6: two terminals in one checkout are normal; the pid liveness sweep achieves the goal without false positives); a hub-side per-dev mute table (a local `~/.relay/mute` file is enough for four people and needs no API); moving `git status` into a synchronous hook with a bigger budget (it is off the sync path entirely instead).

## Appendix B — Contract assumptions to verify (M0 day 1: items 1–5; rest of M0: 6–13; M1: 14–18)

1. **First-session liveness.** After the trust dialog, with an empty plugin cache and a local git marketplace, do `hooks/hooks.json` and `.mcp.json` become live in that same session (a `<relay-digest>` appears when asked) or only in the next one? On CLI 2.1.236 and Desktop 2.1.260. Decides the onboarding sentence in §3.2.
2. **Desktop lifecycle.** Does closing a Desktop tab / quitting the app fire `SessionEnd` (and with which `reason`)? Does `hook.sh` find Node without a login-shell PATH? Is `CLAUDE_CODE_ENTRYPOINT=claude-desktop` present in hook env? Do detached `bg` workers survive tab close?
3. **Project-scope `autoUpdate`.** Is `extraKnownMarketplaces.relay.autoUpdate: true` in a repo's `.claude/settings.json` honoured (background pull + `/reload-plugins` offer within ~10 min), or only the `/plugin` toggle and managed settings?
4. **Permission rule form** for the plugin server: `mcp__plugin_relay_relay` vs `mcp__plugin_relay_relay__*` — which one suppresses tool prompts? `init-project` writes both until answered.
5. **`ask` semantics.** A `PreToolUse` `ask` with `permissionDecisionReason` shows the reason in the permission prompt in both clients, forces the prompt under `acceptEdits`, and is *not* bypassed by an "always allow" rule (confirms the `asked`-mark design); in a subagent and under `dontAsk` the downgrade path is exercised.
6. `async: true` command hooks on `PostToolUse`, `Stop` deliver `additionalContext` on the next turn as documented; no `hook error` lines appear; eight parallel hooks on one session produce no duplicates.
7. `SessionStart` JSON with `sessionTitle` on `resume`/`fork` is honoured; `additionalContext` ≤ 6 KB is delivered inline (not spilled to a file); `source: "fork"` fires with the new session id.
8. `if: "Bash(git *)"` fires for `git add -A && git commit -m x` and not for `pnpm test`.
9. `TaskCreated`/`TaskCompleted` fire on both versions with `task_subject`; `CwdChanged` fires on `/cd` and carries `CLAUDE_ENV_FILE`; `prompt_id` is present on `Stop` stdin.
10. `CLAUDE_ENV_FILE` exports from SessionStart are visible in later `Bash` tool calls.
11. `systemMessage` on `UserPromptSubmit` is displayed to the user (then the prompt hook emits it for inbox items; otherwise it is omitted).
12. Status line: `refreshInterval` is honoured on 2.1.236; a project `statusLine` overrides the user's (hence the chain in §4.11); whether a plugin `settings.json` `statusLine` key is honoured (if so, ship it there and drop the project key).
13. The `${CLAUDE_PLUGIN_ROOT}` placeholder substitutes in exec-form `args` for both hooks and `.mcp.json`; `basename(CLAUDE_PLUGIN_ROOT)` is the commit SHA for relative-path plugins from a git marketplace.
14. Marketplace source `{"source":"github","repo":"your-org/relay-plugin"}` registers without a prompt after trust; SSH by default, HTTPS with `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` + `gh auth setup-git`; a fresh macOS user with no SSH key sees a clear failure and the manual commands recover it.
15. The marketplace clone path (`~/.claude/plugins/marketplaces/<name>` or wherever 2.1.236/2.1.260 keep it) for the behind check; `git ls-remote` on it works non-interactively with the developer's auth.
16. `process.ppid` of the plugin's stdio MCP server is the Claude Code process in CLI and Desktop, and equals `CLAUDE_PID` as seen by hooks.
17. A detached `bg session-end` worker started from a SessionEnd hook survives `/exit` and `-p` teardown and completes its POST.
18. Neon on the Launch tier with auto-suspend off keeps `GET /v1/snapshot` under 300 ms warm; with auto-suspend on, the first request after 5 min idle stays under the 1,500 ms first-refresh budget.
