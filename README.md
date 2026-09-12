# Relay

**A team intelligence layer for developers who each run their own Claude Code session.**

Relay makes every developer's Claude aware of the rest of the team with zero manual effort.
When a session starts, Claude receives a short digest of what teammates changed in *this*
developer's area — contract files, decisions, blockers, messages, the last handoff. While
working, Claude sees who is live on which branch and objective, is warned (or asked, or
blocked) before editing a file a teammate is actively editing, and is told about a contract,
API or schema change at the exact moment it touches a dependent file. When a session ends, a
structured handoff is generated from the session's own event stream — never from
transcripts — and routed to the teammates it affects.

Everything is built on documented Claude Code primitives: command hooks with
`hookSpecificOutput`, plugin auto-install after the workspace-trust dialog, a plugin-bundled
stdio MCP server, and a `statusLine`. The only server is one small Hono app ("the hub") on
Vercel with a Neon Postgres, or `@hono/node-server` with PGlite for development and demos.
The latency-critical hooks never touch the network or git: they read a snapshot the hub
returns on every response and cache under `~/.relay`. Every hook fails open (exit 0, no
output) when anything is missing, slow or broken.

Two human-visible surfaces only: the collision permission prompt, and a status line
(`relay ● priya app feat/currency 09:41 · 1 impact · 1 note`) that re-renders every 10 s from
the local snapshot at zero token cost. Everything else is context for Claude. The full,
implementation-ready specification is [DESIGN.md](DESIGN.md) (v1.1); the verified Claude
Code contracts it relies on are in [docs/research](docs/research).

## Status: M0

This is the M0 milestone (DESIGN.md §12): a two-terminal demo on one Mac through the real
plugin install path, on PGlite. Nothing is deployed and no external resource exists yet.

| Piece | State |
|---|---|
| `packages/core` — config, git (author-filtered), contracts + symbols, dependency index, redaction, journal + marks, cache, outbox WAL, HTTP + breaker, collision verdicts | implemented, unit-tested |
| `packages/hooks` → `packages/plugin/dist/hook.mjs` — all verbs of §4 incl. `bg` workers | implemented (zero-dependency bundle) |
| `packages/mcp` → `packages/plugin/dist/mcp.mjs` — 13 tools, per-call session resolution | implemented (bundles the MCP SDK) |
| `packages/plugin` — hooks.json, `.mcp.json`, node-resolver scripts, status line, skills | implemented |
| `apps/api` — the hub: auth, snapshot, digest, impact routing, handoffs, sweep | implemented on PGlite; Neon path typed and wired, untested |
| `examples/demo-repo`, `scripts/demo.sh`, `scripts/relay-admin.mjs`, `scripts/publish-plugin.sh`, CI workflows | implemented |
| M1 (two machines, hosted hub, real client project), M2 (dashboard, invite tokens, Channels) | not started |

### Verified against the real `claude` CLI 2.1.236 (headless, this Mac)

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

## Admin quick start (once for the shop)

Prerequisites: Node ≥ 20, pnpm 10, git, Claude Code ≥ 2.1.224, GitHub access to create two
private repos, a Vercel account (M1).

```bash
cd "~/relay"
pnpm install && pnpm build && pnpm test           # bundles land in packages/plugin/dist (committed)

# M1: deploy the hub (see DESIGN.md §3.1 step 1: vercel link, integration add neon, env vars, db:push, deploy)
# The hosted entry refuses to boot without RELAY_TEAM_TOKEN (no "demo" fallback); only `pnpm dev`
# and a local PGlite hub with RELAY_ALLOW_DEMO_TOKEN=1 accept the demo token.

# fill the plugin's team.json (hub URL, team token, members) and publish the plugin
node scripts/relay-admin.mjs token new                                   # -> rt_… (48 random chars)
node scripts/relay-admin.mjs init-team --hub https://relay-exampleteam.vercel.app --token rt_… \
  --marketplace your-org/relay-plugin \
  --member deepak=deepak@example.com:deepak-gh --member priya=priya@example.com:priya-gh
git commit -am "relay: team config" && git push     # CI publishes packages/plugin -> relay-plugin (or: pnpm plugin:publish)

# per client repo (both repos of a two-repo project get the same --project)
cd ~/code/acme-app
node "~/relay/scripts/relay-admin.mjs" init-project --project acme-portal \
  --area app='apps/app/**' --area dashboard='apps/dashboard/**' --owner app=priya --owner dashboard=deepak
git add .claude/settings.json .relay.json && git commit -m "Add Relay" && git push
```

`init-project` writes/merges `.claude/settings.json` (marketplace reference with
`autoUpdate`, `enabledPlugins`, both MCP permission rule forms, the status line) and
`.relay.json` (the area map; inferred from `apps/*`, `packages/*`, `src/*` when no `--area`
is given). `--local` writes `.claude/settings.local.json` instead — the default for repos in
a client's GitHub org. Nothing in a client repo contains a secret or a hub URL; the token
lives only in the private plugin repo.

Other admin commands: `relay-admin rotate-token` (new token, hub told, `team.json` rewritten,
14-day dual-token grace), `relay-admin doctor`, `relay-admin validate`, `relay-admin demo …`.

## Developer: two steps

1. **Once per machine:** make sure `git clone git@github.com:your-org/relay-plugin.git`
   would succeed non-interactively (SSH key in `ssh-agent`, or `gh auth setup-git` plus
   `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`). Node ≥ 18 must exist somewhere on disk;
   `hook.sh` finds it on PATH, in Homebrew, nvm, volta or fnm.
2. `cd ~/code/acme-app && git pull && claude` and accept the workspace trust dialog. Claude
   Code registers the marketplace and caches the plugin. If the status line does not show
   `relay` after the first prompt, run `/reload-plugins` or `/exit` and `claude` once more —
   experiment B.1 showed the plugin can become live only on a later session.

If nothing appears: `claude plugin marketplace add your-org/relay-plugin && claude plugin install relay@relay`
names the failing step (usually git auth). `/relay:doctor` exists once the plugin is
installed. If the digest says the identity is unknown, `/relay:iam <handle>` sets it.

Skills: `/relay:status`, `/relay:handoff`, `/relay:doctor`, `/relay:iam <handle>`,
`/relay:mute <target>`. Tools (`mcp__plugin_relay_relay__*`): status, who_is_on,
recent_changes, decisions, notify, claim, release, impacts, impact_of, handoffs, handoff,
decide, whoami.

## The demo (M0 acceptance test)

```bash
pnpm install && pnpm build
sh scripts/demo.sh up          # or: pnpm demo up
```

This builds if needed, starts the hub on `http://127.0.0.1:8787` (PGlite in
`/tmp/relay-demo/hub-data`, team token `demo`, identities priya/arjun), creates a bare local
marketplace `/tmp/relay-demo/mkt.git` holding a copy of `packages/plugin` with a demo
`team.json`, a bare `origin.git` seeded from `examples/demo-repo`, and two clones
`/tmp/relay-demo/app-priya` and `app-arjun` whose `.claude/settings.json` point at the local
marketplace and set `RELAY_HOME`/`RELAY_DEV`/`RELAY_HUB`/`RELAY_TOKEN` per developer. It then
prints the two-terminal script: the six moments — presence, impact, collision, notify,
handoff, digest — as in DESIGN.md §12. `scripts/demo.sh check` verifies them from a third
terminal by asking the hub; `scripts/demo.sh stop` tears everything down (hub, marketplace
registration in `~/.claude/plugins`, `/tmp/relay-demo`).

`sh scripts/demo.sh up --plugin-dir` is the fast variant for hook iteration (loads the plugin
with `claude --plugin-dir` instead of the marketplace). If port 8787 is busy, the rig moves to the
next free port (or set `RELAY_DEMO_PORT`). `ANTHROPIC_API_KEY` in the environment turns on LLM
handoff synthesis. To drive the same flow headlessly (no trust dialog): run the first sessions in
each clone as `claude -p --settings /tmp/relay-demo/app-<dev>/.claude/settings.json` until
`scripts/demo.sh check` reports the plugin cached and hooks fired (three sessions for the first
clone, one or two for the second), then use `--input-format stream-json` for multi-turn sessions;
remember that `-p` turns the collision `ask` into context only.

Repository layout, build rules and every file's responsibility: [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md).
`pnpm test` runs the unit tests (286 across core, hooks, mcp, api), `pnpm test:hooks` replays the
hook smoke fixtures through `dist/hook.mjs` against a throwaway PGlite hub (timings, 8 parallel
hooks, pull attribution), `pnpm test:e2e` plays the six demo moments end to end without the
`claude` CLI (two developers, hooks + the MCP bundle over stdio), `pnpm -r typecheck` the type
checks; CI runs all of them and fails if the committed bundles differ from a fresh build. No test
needs a network, an API key or a running server: each runner starts its own hub on a free port
(`RELAY_HUB=<url>` reuses one) and strips `ANTHROPIC_API_KEY` so handoffs stay heuristic.

## Privacy, in one paragraph

Repo-relative file paths (never the absolute checkout path), contract-file diff hunks (≤ 1,500
chars, redacted) and the *prose* of Claude's replies (fenced and indented code stripped,
≤ 3,000 chars) leave the machine; source files, prompts and transcripts do not. Everything
passes `redact()` (cloud keys, GitHub/Slack/Stripe/Anthropic tokens, Relay team tokens, JWTs,
key blocks, `Authorization`/`password`/`token` values incl. `DB_PASSWORD=`-style `.env` keys,
connection-string passwords, Slack webhooks, high-entropy strings) — the derived objective,
task and commit subjects included. Teammate-written text (notes, decisions, handoffs,
objectives) is stored and rendered as one bounded line that cannot close a `<relay-*>` block.
Data sits in the shop's own Vercel project and Neon database.
Knobs per repo in `.relay.json`: `privacy.send_prompts`, `send_turns`, `send_diffs`,
`objective_from_prompts`; per machine: `/relay:mute`. Details: DESIGN.md §11.

## Open questions (DESIGN.md §13 — each changes the build)

1. **Handoff synthesis model/key.** One Anthropic API key on the hub (default Haiku 4.5,
   ≈ $0.30/day for 4 devs) — the design's assumption — or heuristic-only handoffs, or
   per-developer `claude -p` synthesis on subscriptions (no key, more failure modes)?
2. **Identity/auth.** Shared team token in the private plugin repo + git-email identity (zero
   developer steps; teammates could impersonate each other) — assumed — or per-developer
   invite tokens with revocation (0.5-day M2 add-on)?
3. **Client-owned repos.** Which current client repos live in a client's GitHub org? Those get
   `init-project --local`; ours get the committed variant. Any client that would object even
   to the committed no-secret files goes on the `--local` list.
4. **How the two repos of a project share contracts.** A published/workspace package (high
   confidence via the dependency index) or copied type files (symbol matching only, more
   `depends` reliance)? Decides how much of §7.4 M1 builds first.
5. **Privacy defaults for client work.** Derived objective, paths, contract hunks and reply
   prose to your own hub — acceptable for every client, or should some engagements default to
   `send_turns: false` / `send_diffs: "none"`?
6. **Hosting plan.** Vercel Pro (≈ $20/month) plus Neon Launch with auto-suspend off
   (≈ $19/month) — assumed — or free tiers and more cold-start refreshes?
