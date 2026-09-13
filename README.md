# Relay — team awareness for Claude Code

[![ci](https://github.com/worklab-studio/claude-code-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/worklab-studio/claude-code-relay/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Two developers, two Claude Code sessions, one project. Relay makes each developer's Claude aware of what the other one is doing — automatically.**

Live presence, a warning before Claude edits a file a teammate is editing, an alert when a
teammate changes a shared API/contract your code depends on, and a structured handoff written
for you when your session ends. Nothing to type, nothing to remember. It is a Claude Code
plugin (hooks + MCP server) plus a small hub you host yourself.

```
<relay-digest project="acme-portal" dev="arjun" at="2026-09-12T09:41:07Z">
## Team now
- priya · app (+contracts) · feat/currency · "Add currency support to invoices" · working, last event 09:40:27Z
## Contract changes affecting you (1)
- priya changed packages/contracts/src/billing.ts at 09:01Z (committed a1b2c3d, not in your branch):
  Invoice.total → amountDue (+currency); createInvoice(input) → createInvoice(input, currency)
  Your dependents: apps/dashboard/src/invoices.tsx
## Messages for you (1)
- priya at 2026-09-11T12:40Z (fyi): keep `status` — dashboard already consumes it
## Handoffs since your last session (1)
- priya · feat/currency · done: currency on Invoice; migration 0042 · next: update dashboard invoice table (arjun)
</relay-digest>
```
*What Arjun's Claude receives when his session starts. ≤ 6 KB, only what touches his area, never transcripts.*

## The problem

Claude Code is single-player. When a team uses it, every developer's Claude has its own
context, and those contexts drift: Dev B's Claude doesn't know Dev A just renamed a field in a
shared type, two Claudes edit the same file on two branches, and what one developer decided
this morning is invisible to the other one this afternoon. Git shows you the result hours
later. Shared `CLAUDE.md` files and memory tools tell Claude how the team *works*, not what
the team is *doing right now*.

Relay fills that gap. It is not another shared-memory or knowledge-base tool — see
[how it compares](#how-relay-compares) — it is the live coordination layer between separate
developers' coding agents.

## What your developers see

| Moment | What happens | How |
|---|---|---|
| **Session start** | Claude gets the digest above: who is active, contract changes affecting *this* developer's area, messages, teammates' handoffs, decisions | `SessionStart` hook injects `additionalContext` |
| **Presence** | Status line: `relay ● priya app feat/currency 09:41 · arjun dashboard main idle 12m · 1 impact · 1 note` | project `statusLine`, rendered from a local cache |
| **Collision** | Claude is about to edit a file a teammate is editing → permission prompt: *"Relay: priya is editing packages/contracts/src/orders.ts (branch feat/orders, last edit 09:43:10Z). Allow this edit?"* Five levels (claimed / hot / warm / sequential / same-dev); asked once per file per 30 min; stale data downgrades to a note, never a block | `PreToolUse` hook, local cache only (~6 ms) |
| **Impact** | A teammate changes a shared contract (types, schema, API) → Relay finds the changed exported symbols, greps for dependents, routes it to the developer who owns them: in their next prompt, and again the moment Claude opens the dependent file | `PostToolUse` + `UserPromptSubmit` + `PreToolUse` |
| **Notify** | `notify("priya", "keep status — dashboard consumes it")` → lands in Priya's next prompt | MCP tool + `UserPromptSubmit` |
| **Handoff** | Session ends → structured handoff (done / changed / interfaces changed / decisions / blockers / next / commits / notes to) generated from the session's own event stream; heuristic instantly, LLM-refined if the hub has an API key | `Stop` + `SessionEnd` hooks |
| **On demand** | 13 MCP tools: `status`, `who_is_on`, `recent_changes`, `decisions`, `notify`, `claim`/`release`, `impacts`, `impact_of`, `handoffs`, `handoff`, `decide`, `whoami`; skills `/relay:status` `/relay:handoff` `/relay:doctor` `/relay:iam` `/relay:mute` | plugin-bundled stdio MCP server |

## How it works

```
 developer A's machine                        developer B's machine
 ┌───────────────────────────┐                ┌───────────────────────────┐
 │ Claude Code               │                │ Claude Code               │
 │  ├ relay plugin (hooks)   │   events       │  ├ relay plugin (hooks)   │
 │  ├ relay MCP server       │──────────┐     │  ├ relay MCP server       │
 │  └ ~/.relay cache         │◄───────┐ │     │  └ ~/.relay cache         │
 └───────────────────────────┘ snapshot│ │     └────────────▲──────────────┘
                                       │ ▼                 │ snapshot on every response
                                ┌──────┴────────────────────┴──────┐
                                │  hub: Hono + Postgres (yours)    │
                                │  presence · claims · change sets │
                                │  impact routing · handoffs       │
                                │  digest rendering                │
                                └──────────────────────────────────┘
```

- **Built only on documented Claude Code primitives**: command hooks with
  `hookSpecificOutput`, plugin auto-install after the workspace-trust dialog, a
  plugin-bundled stdio MCP server, a `statusLine`. No `--dangerously-*` flags, no patched
  binaries, no Channels dependency.
- **The hub returns the whole team snapshot on every response**, so the latency-critical
  hooks (before every edit, on every prompt) are local file reads and never call the network.
  Measured on a real session: pre-edit p50 6 ms, prompt p50 8 ms, session start ~200 ms.
- **Every hook fails open.** Hub down, slow, git missing, Node missing: the hook exits 0 with
  no output, presence goes stale, events queue in a local write-ahead log and drain later.
  Relay can never stop you coding.
- **Attribution is author-filtered**, so a `git pull` never makes it look like you changed
  everything, and impacts are grouped into change sets with debounce and revert handling.
- **Privacy by construction.** What leaves the machine: a derived objective (≤ 140 chars),
  repo-relative file paths, contract-file diff hunks (≤ 1,500 chars) and the code-stripped
  prose of Claude's replies (≤ 3,000 chars). Never prompts, source files or transcripts. All
  of it passes secret redaction first. The hub is your own deployment.

The full, implementation-ready specification is [DESIGN.md](DESIGN.md); the Claude Code hook,
plugin and MCP contracts it relies on were extracted from the official docs and tested against
the real CLI — see [docs/research](docs/research).

## Try it in 10 minutes (one machine, two fake developers)

Requirements: macOS or Linux, Node ≥ 20, pnpm 10, git, [Claude Code](https://code.claude.com)
≥ 2.1.224 (tested on 2.1.236). No cloud account, no API key.

```bash
git clone https://github.com/worklab-studio/claude-code-relay.git relay && cd relay
pnpm install && pnpm build
sh scripts/demo.sh up
```

This starts a local hub (PGlite, no database to install), creates a local plugin marketplace
and two clones of a small demo monorepo — `/tmp/relay-demo/app-priya` (works on the app) and
`/tmp/relay-demo/app-arjun` (works on the dashboard) — and prints a two-terminal script that
walks through all six moments above in real Claude Code. `sh scripts/demo.sh check` shows what
the hub recorded at any point; `sh scripts/demo.sh stop` removes everything.

First-install note: Claude Code registers the marketplace, caches the plugin and loads it in
consecutive sessions, so the plugin may only be live after you `/exit` and relaunch (up to two
times). `/relay:status` tells you when it is.

## Set it up for your team

**Once, by whoever runs the team (~30 min):**

1. Deploy the hub: `apps/api` is a Hono app with a Vercel entry; set `DATABASE_URL` (Neon or
   any Postgres) and `RELAY_TEAM_TOKEN`. `pnpm dev` runs the same code locally on PGlite.
   Optional: `ANTHROPIC_API_KEY` on the hub turns on LLM-written handoffs (Haiku, cents per day).
2. Create a private GitHub repo for the plugin (this is what every developer's Claude Code
   clones; a few hundred KB) and configure `team.json`:
   ```bash
   node scripts/relay-admin.mjs token new                # -> rt_…
   node scripts/relay-admin.mjs init-team --hub https://relay-yourteam.vercel.app --token rt_… \
     --marketplace your-org/relay-plugin \
     --member priya=priya@yourteam.com --member arjun=arjun@yourteam.com
   pnpm plugin:publish                                   # copies packages/plugin into your-org/relay-plugin
   ```
3. In each project repo (both repos of a two-repo project get the same `--project`):
   ```bash
   node ~/relay/scripts/relay-admin.mjs init-project --project acme-portal \
     --area app='apps/app/**' --area dashboard='apps/dashboard/**' --owner app=priya --owner dashboard=arjun
   git add .claude/settings.json .relay.json && git commit -m "Add Relay" && git push
   ```
   This writes `.claude/settings.json` (marketplace reference, `enabledPlugins`, MCP
   permission, status line) and `.relay.json` (area map, contract globs, owners). Nothing in a
   project repo contains a secret or a hub URL. For repos you don't own, `--local` writes
   `settings.local.json` instead and commits nothing.

**Each developer:**

1. Be able to `git clone` the private plugin repo non-interactively (SSH key in `ssh-agent`,
   or `gh auth setup-git` + `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`). Node ≥ 18 anywhere on disk.
2. `git pull && claude`, accept the workspace trust dialog. Identity comes from `git config
   user.email` matched against `team.json`; `/relay:iam <handle>` overrides it.

Updates reach developers through the marketplace's auto-update; `relay-admin rotate-token`
rotates the team token with a 14-day dual-token grace. `relay-admin doctor` and
`/relay:doctor` diagnose a machine.

## How Relay compares

| | Relay | [Egregore](https://github.com/egregore-labs/egregore) | [Entire](https://github.com/entireio/cli) | [TeamAI](https://github.com/Tencent/teamai-cli) | Claude Code Agent Teams |
|---|---|---|---|---|---|
| Shared team memory / knowledge base | no (non-goal) | **yes** | no | partly | no |
| Session capture linked to commits | no (non-goal) | no | **yes** | no | no |
| Distribute skills/rules/hooks to a team | via the native plugin marketplace | yes | no | **yes** | no |
| Live presence across developers | **yes** | activity log | no | no | single user |
| Collision warning before an edit | **yes** | no | no | no | no |
| Contract-change impact routed to the affected developer | **yes** | no | no | no | no |
| Automatic handoff on session end | **yes** | manual `/handoff` | no | no | no |
| Works without `--dangerously-*` flags | yes | yes | yes | yes | experimental flag |

They compose: Entire can record the sessions Relay coordinates; Egregore can hold the
long-form knowledge Relay's handoffs summarise (Relay renders handoffs in Egregore's
addressed-handoff frontmatter format).

## Status

**M0 — working end to end on one machine, verified against the real `claude` CLI.** All six
moments were driven headlessly through `claude -p` with the plugin installed through the real
marketplace path, against the local hub; every hook stayed inside its deadline with zero hook
errors. Details and evidence: [docs/VERIFICATION.md](docs/VERIFICATION.md).

What only an interactive session can show and is therefore **not yet verified**: the trust
dialog install flow, the collision permission prompt UI (headless mode downgrades it to a note
by design), the status line as rendered by the terminal, `/reload-plugins`, and the Claude
Code desktop app lifecycle. If you run the demo, [open an issue](../../issues) with what you
saw — that is the most useful contribution right now.

Roadmap: **M1** two machines, one real project, hosted hub (Vercel + Neon path is wired,
untested). **M2** per-developer invite tokens, a small web dashboard, Channels push for idle
sessions, a Cursor/Codex spike (the hub API is editor-agnostic). Windows is untested.

Decisions each team makes before M1 (handoff model/key, shared vs per-developer tokens,
privacy defaults for client work, hosting tier): [docs/DECISIONS.md](docs/DECISIONS.md).

## FAQ

**Does it lock files?** No. Everything is advisory and time-limited: warn, ask, or (only for an
explicit `claim --hard`) deny — and only for Claude-driven edits. Stale data always downgrades.

**Does my code go to a server?** Contract-file hunks and prose do; source files, prompts and
transcripts don't — and the server is yours. Per-repo knobs: `privacy.send_prompts`,
`send_turns`, `send_diffs`; per machine: `/relay:mute`. See [DESIGN.md §11](DESIGN.md).

**Two Claude sessions on one machine? Worktrees? Two repos in one project?** Supported:
presence is per session, claims are per developer per repo, and impact routing crosses repos
via an uploaded dependency index plus a `depends` map in `.relay.json`.

**What does a hook cost?** A Node process spawn (~40 ms on a Mac) plus a file read. No LLM
calls in hooks. Handoff synthesis is the only LLM use, on the hub, optional.

**Cursor / Codex / other agents?** Not yet. The hub and protocol are editor-agnostic; the
plugin is Claude Code-specific.

## Repository

```
packages/plugin   the Claude Code plugin (hooks.json, .mcp.json, skills, shell wrappers, committed bundles)
packages/core     client library: config, identity, git, journal, cache, outbox WAL, redaction, collision logic
packages/hooks    the hook program (every verb + background workers) → packages/plugin/dist/hook.mjs
packages/mcp      the MCP server (13 tools) → packages/plugin/dist/mcp.mjs
apps/api          the hub: Hono + Drizzle; PGlite locally, Postgres/Neon when DATABASE_URL is set
examples/         demo monorepo used by scripts/demo.sh
scripts/          relay-admin, demo rig, e2e and smoke runners, plugin publish
docs/             research notes, verification evidence, build plan
```

`pnpm test` (unit), `pnpm test:hooks` (fixtures replayed through the real bundle against a
PGlite hub), `pnpm test:e2e` (the six moments, hooks + MCP over stdio, no `claude` needed).
CI fails if the committed bundles differ from a fresh build. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
