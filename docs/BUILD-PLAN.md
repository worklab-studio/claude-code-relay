# Relay build plan (M0)

One map for every agent working in parallel. File lists follow DESIGN.md §2.3; each
entry has one line of responsibility and the sections that specify it. Read
`packages/core/src/protocol.ts` first: it is the contract every package codes against
(all wire bodies, snapshot, local files, events, hook I/O, tool payloads, constants).

## Workspace rules (already wired by the scaffold)

- pnpm workspace: `packages/core`, `packages/hooks`, `packages/mcp`, `apps/*`.
  `packages/plugin` has **no** package.json (Claude Code's installer must not run
  `npm ci`, §2.3) and is not a workspace member.
- `@relay/core` is consumed **from source**: its package.json `exports` points at
  `src/index.ts`, so tsc, esbuild, tsx and vitest all see edits immediately with no
  build step. `pnpm --filter @relay/core build` emits `dist/` (js + d.ts) as an
  artifact for M1 packaging only; nothing in the workspace imports `dist/`.
- `pnpm build` = core `tsc` emit, then `esbuild` bundles
  `packages/hooks/src/index.ts -> packages/plugin/dist/hook.mjs` (unminified, must stay
  zero-dependency: only `node:*` imports may remain) and
  `packages/mcp/src/index.ts -> packages/plugin/dist/mcp.mjs` (minified, bundles the MCP
  SDK + zod; a `createRequire` banner makes CJS deps load under ESM).
  `packages/plugin/dist/` is the one committed build output (`.gitignore` re-includes it).
- `pnpm test` runs vitest across all packages (root config lists them as projects);
  `pnpm --filter <pkg> test` runs one package. `pnpm -r typecheck` / `pnpm lint` are
  `tsc --noEmit` per package. `pnpm test:hooks` -> `node scripts/smoke/run.mjs`
  (to be written; see scripts/ below). `pnpm dev` -> `apps/api` `tsx scripts/dev.ts`.
  `pnpm demo` -> `sh scripts/demo.sh`. `pnpm plugin:publish` -> `sh scripts/publish-plugin.sh`.
- TypeScript: strict, ES2022, NodeNext, `verbatimModuleSyntax` (write `import type`),
  `noUncheckedIndexedAccess`. Node >= 18 built-ins only in core and hooks.
- Entry files are fixed: hooks `src/index.ts` (replace its body with `import './main.js'`),
  mcp `src/index.ts` (`import './server.js'`). Keep them one line so the build scripts
  never change.
- Per-package `vitest.config.ts` files exist; put tests next to the code as `*.test.ts`.

## packages/core — `@relay/core` (zero deps, Node >= 18)

| File | Responsibility | Spec |
|---|---|---|
| `src/protocol.ts` | DONE. All wire/file types, constants (deadlines, budgets, limits, defaults), cheap type guards. Change here = change everywhere; keep it exhaustive. | §10, §5.4, §6, §7.5, §8.3, §9.2, §4.x |
| `src/index.ts` | Re-exports only. Add `export * from './<module>.js'` as modules land. | §2.3 |
| `src/ulid.ts` | Monotonic ULID generator (no dependency; the design allowed `ulid` but core implements it). Used for event ids, outbox file names. | §4.0 rule 6, §10.1 |
| `src/config.ts` | Load `.relay.json` from the repo root, validate shallowly (`isRelayConfig`), apply `RELAY_CONFIG_DEFAULTS`, `"+glob"` prepend semantics, `configHash` (sha1 of canonical JSON), `RelayConfigResolved`. Absent file -> areas inferred from first two path segments. | §5.4, §7.1 |
| `src/identity.ts` | Identity resolution ladder (env, identity.json, git email vs team.json, noreply, local part, `$USER`, per-machine placeholder), 24 h cache, team.json loading with `RELAY_HUB`/`RELAY_TOKEN` overrides. | §3.3, §4.0 |
| `src/git.ts` | Async `execFile('git', ['-C', cwd, ...])` with `{timeout, env: GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0}`; helpers: rev-parse set, branch (detached -> `detached@<sha7>`), worktree detection, author-filtered `log`, `diff -U0 -w`, `hash-object`, `diff-tree`, `patch-id`, `merge-base --is-ancestor`, `status --porcelain` with generated-path exclusions. **Never spawnSync.** | §4.0 rule 7, §4.6, §4.8, §5.3 |
| `src/repo.ts` | Origin URL -> slug normalization (`git@github.com:acme/app.git` and `https://github.com/acme/app` -> `github.com/acme/app`; none -> `local/<basename>`), `repoKey = sha1(slug).slice(0,12)`, project default (owner/name), repo-relative POSIX path normalization from `meta.repoRoot`. | §4.1, §5.3, §4.3 step 1 |
| `src/area.ts` | Recency-weighted area vote over the fold's recent edits (`3/(1+min/10)`), `shared` areas never win alone (`app (+contracts)`), tie-breakers: branch token, owner, cwd segment, `unknown`. | §5.2 |
| `src/objective.ts` | Objective rule: task > prompt heuristic (stoplist, length, `/`, `[private]`, non-alpha ratio, answer-to-question) > branch humanization; replacement rules (imperative verbs, `now/next/instead`, 10 min / 15 tool calls); trail of 5. | §5.1 |
| `src/contracts.ts` | Contract candidate detection: glob match (`DEFAULT_CONTRACT_GLOBS` + config), export-scan regexes for TS/JS/Python/Go/zod/tRPC over `-U0 -w` hunks, comment/whitespace filters, hunk normalization + `hash`. | §7.1, §7.2 |
| `src/symbols.ts` | Symbol extraction per file type (TS exports + signature line, Prisma model via hunk header, OpenAPI paths/schemas, GraphQL types, proto messages/services, SQL tables) -> `{symbols, kinds, summary}`. | §7.1 |
| `src/depindex.ts` | Dependency index builder (one `git grep` pass for import/require/prisma/HTTP-path literals, specifier normalization to package names and repo-relative paths) -> `DepIndex`; in-repo dependents grep for a changed file (`git grep -l -E`, 2 s budget, cap 50). | §7.3, §7.4 |
| `src/redact.ts` | `redact()` for every outbound text field: AWS/GitHub/Slack/Stripe/Anthropic/OpenAI keys, `rt_` team tokens, JWTs, private key blocks, `Authorization:`/`password=`/`token=` values, high-entropy base64 >= 32. | §11.1 |
| `src/prose.ts` | `prose()`: strip fenced code, inline code > 80 chars, diff and stack-trace lines from `last_assistant_message`; caps (3,000 chars). | §4.8 step 1, §8.2 |
| `src/journal.ts` | Per-session dir: `meta.json` (lock-guarded rewrite), `events.jsonl` O_APPEND lines <= 4 KB, fold reader (`JournalFold`), rotation at 64 KB under the lock, `marks/` via `openSync(p,'wx')`, `mkdir .lock` spin 50 ms / give up 300 ms, `pending`, `draft.json`, self-heal from stdin + 3 rev-parse. | §4.0 rules 9–10, §4.4 |
| `src/cache.ts` | `cache/<repoKey>/`: atomic `snapshot.json` write guarded by `serverTime`, `digest.md`, `statusline.txt` renderer (absolute times), `ancestry.json`, `state.json` (bg-lock only), `current/<pid>.json` liveness file, `pending` derivation per session. | §4.0 rules 8, 11, §4.11, §4.12 |
| `src/outbox.ts` | Write-ahead log: `outbox/<ulid>.json` before every POST, delete on 2xx, drain rules (skip < 30 s, drop ephemeral > 24 h, drop > 7 d, cap 200, `replay: true`, own sessionId/at). | §4.0 rule 6 |
| `src/http.ts` | `fetch` with `AbortSignal.timeout`, headers (`RELAY_HEADERS`, Bearer token), breaker files (`down-until`, `down-count`, `config-error.json`), 401/426/413 handling, `X-Relay-Warn` -> digest line, `refresh-wanted`. | §4.0 rule 5, §3.3, §3.4 |
| `src/collision.ts` | Severity + staleness ladder -> `CollisionVerdict` from snapshot, ancestry, marks, config policy, `permission_mode`/`agent_id`/`RELAY_INTERACTIVE` downgrades, same-branch worktree escalation, mute targets. Pure function over inputs; heavily unit-tested. | §6.3–§6.6, §4.0 rule 14 |
| `src/*.test.ts` | Unit tests: path normalization, redaction, prose stripping, symbol extraction, objective/area rules, collision severity + staleness ladder, outbox drain rules, ulid monotonicity. | §12 M0 |

## packages/hooks — `@relay/hooks` (bundled to `packages/plugin/dist/hook.mjs`)

| File | Responsibility | Spec |
|---|---|---|
| `src/index.ts` | Bundle entry: `import './main.js'`. | §2.3 |
| `src/main.ts` | Crash guards (`uncaughtException`/`unhandledRejection` -> exit 0), watchdog `setTimeout(exit 0, DEADLINE_MS[verb])`, stdin JSON read (defensive), `RELAY_DISABLE`, verb dispatch, single `JSON.stringify` stdout <= 9,000 chars, `stats.jsonl` line, `finally -> process.exit(0)`. | §4.0 rules 1–4, 12 |
| `src/verbs/session-start.ts` | Identity, repo/branch/startSha (parallel rev-parse), meta.json, current file, statusline copy + chain, `POST /v1/session/start` (3 s), cache + digest.md, `sessionTitle`, `CLAUDE_ENV_FILE` exports, spawn `bg session-start`; `compact` = local re-injection <= 1,500 chars; delta mode on resume/fork < 12 h. Fail-open: cached digest or offline line. | §4.1, §9.3 |
| `src/verbs/prompt.ts` | Journal prompt line + objective rule, throttled `GET /v1/snapshot` (800/1,500 ms), inbox + high-priority change sets with `wx` marks -> `<relay-inbox>` <= 1,500 chars, optional `systemMessage` (B.11), spawn `bg prompt`. No git. | §4.2 |
| `src/verbs/pre-edit.ts` | Path normalization, mute check, snapshot read + stale refresh spawn, `CollisionVerdict` -> ask/deny/context, JIT change-set notes (top 2, <= 4,000 chars, `jit.<cs>` marks), `asked` marks. No git, no network. | §4.3, §6.4, §6.5 |
| `src/verbs/pre-read.ts` | Only when `pending` is non-empty (guard-read.sh): JIT note for a listed dependent, `jit` mark, rewrite `pending` under the lock. | §4.4 |
| `src/verbs/post-edit.ts` | Edit line, `asked` -> `snooze`, contract detection (`git diff -U0 -w HEAD`, hash, blobId, dependents grep 2 s), retract on empty diff, WAL + `POST /v1/events`, inbox context for next turn. | §4.5, §7.2, §7.3 |
| `src/verbs/post-git.ts` | Branch change (merge-base reset), own-author commit scan (`log --author`, cap 50, diff-tree/show/patch-id), push detection, WAL + POST, inbox context. | §4.6 |
| `src/verbs/tasks.ts` | `task-created` / `task-completed` journal lines (objective source `task`), no stdout. | §4.7 |
| `src/verbs/cwd.ts` | Re-derive repo root/branch/slug when `new_cwd` leaves the repo, `cwd` line, re-append `RELAY_*` exports. | §4.7 |
| `src/verbs/stop.ts` | Turn line (prose <= 3,000), author-filtered reconciliation vs `lastStopSha`/merge-base, contract/retract events, heuristic draft -> `draft.json`, WAL + POST `turn_end`. No stdout. | §4.8, §8.2 tier 1 |
| `src/verbs/session-end.ts` | End line, `ended` mark, WAL `session_end` entry from the fold, spawn `bg session-end <ulid>`; exit in ~70 ms. No git, no fetch. | §4.9 |
| `src/verbs/mute.ts` | `/relay:mute <target>` (`--undo`) -> `mute/<repoKey>.json`. | §5.4, §9.2 |
| `src/bg.ts` | Detached worker jobs `session-start`, `prompt`, `refresh`, `session-end <ulid>`: single-flight `mkdir` lock (stale 30 s), 15 s watchdog, POST with budgets, breaker updates, chores: outbox drain, liveness sweep (`process.kill(pid, 0)` -> `/v1/session/end {reason:"crash"}`), ancestry computation + auto-acks, journal fold, depindex rebuild/upload, plugin-behind check. | §4.12, §4.0 rules 5–6, 11 |
| `src/handoff-draft.ts` | Tier-1 heuristic handoff from the fold (`done`/`decisions`/`blockers`/`next` regexes, changed by area, interfaces, commits) <= 8 KB. | §8.2 |
| `src/*.test.ts` | Verb-level tests with fake `$RELAY_HOME` and stdin fixtures; parallel-mark race test. | §12 M0 |

## packages/mcp — `@relay/mcp` (bundled to `packages/plugin/dist/mcp.mjs`)

| File | Responsibility | Spec |
|---|---|---|
| `src/index.ts` | Bundle entry: `import './server.js'`. | §2.3 |
| `src/server.ts` | stdio `McpServer` named `relay`, `instructions` (<= 500 chars, factual), registers the 13 tools (`MCP_TOOL_NAMES`), 5 s hub timeout, identity via core, cache fallback for read tools with "(cached HH:MMZ)". | §9.1, §9.2 |
| `src/session.ts` | Live session resolution per call: `current/<process.ppid>.json` -> newest `current/*.json` with matching cwd -> `CLAUDE_CODE_SESSION_ID`. | §9.1 |
| `src/tools/*.ts` | One file per tool: `status`, `who_is_on`, `recent_changes`, `decisions`, `notify`, `claim`, `release`, `impacts` (+ `ack` -> `/v1/ack`), `impact_of`, `handoffs`, `handoff`, `decide`, `whoami` (+ `iam` -> identity.json + `/v1/iam`). Compact text + `json` block; descriptions < 1 KB. | §9.2, §10.4 |
| `src/*.test.ts` | Session resolution and cache-fallback tests. | — |

Size note: the MCP bundle with `@modelcontextprotocol/sdk` + zod 4 minifies to ~720 KB
(design estimate was ~500 KB). Importing `zod/mini` or the low-level `Server` class
shrinks it if the plugin repo size matters.

## packages/plugin — the plugin (no package.json; committed `dist/`)

| File | Responsibility | Spec |
|---|---|---|
| `.claude-plugin/plugin.json` | `{"name":"relay","description":"…"}` — never a `version` field. | §2.3 |
| `hooks/hooks.json` | Exact content of §4.0 (exec form `/bin/sh hook.sh <verb>`, timeouts, `async`, `if: "Bash(git *)"`). | §4.0 |
| `.mcp.json` | stdio server `relay` -> `/bin/sh ${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh`. | §2.3, §9.1 |
| `team.json` | Hub URL, team token, marketplace, members (demo values in M0; real values by `relay-admin team set`). | §2.3, §3.1 |
| `scripts/hook.sh`, `scripts/mcp.sh` | POSIX sh Node >= 18 resolver (cached `node-path`), `exec node --no-warnings dist/<bundle>.mjs "$@"`, exit 0 on every path. | §4.0 |
| `scripts/guard-read.sh` | ~6 ms guard: run `pre-read` only when `sessions/<sid>/pending` is non-empty. | §4.4 |
| `scripts/statusline.sh` | POSIX sh renderer: chain the user's own status line, print `cache/<repoKey>/statusline.txt` found via `current/<CLAUDE_PID>.json`. | §4.11 |
| `skills/{status,handoff,doctor,iam,mute}/SKILL.md` | `/relay:*` commands. | §9.2 |
| `dist/hook.mjs`, `dist/mcp.mjs` | Build output, committed; CI fails on a dirty diff after `pnpm build`. | §2.3 |

## apps/api — `@relay/api` (Hono; PGlite locally, Neon when `DATABASE_URL` is set)

| File | Responsibility | Spec |
|---|---|---|
| `api/[[...route]].ts` | Vercel entry: `hono/vercel` `handle(app)`. | §2.3 |
| `vercel.json` | `{"functions":{"api/[[...route]].ts":{"maxDuration":60}}}`, no crons. | §2.3, §6.2 |
| `drizzle.config.ts` | drizzle-kit config for `db:push` (Postgres dialect, `src/db/schema.ts`). | §3.1 |
| `scripts/dev.ts` | `pnpm dev`: `@hono/node-server` on :8787, PGlite in `.data/`, migrate, seed demo team/devs. | §2.3, §12 |
| `src/app.ts` | Hono app: `/health`, `/v1/*` with auth middleware, `/admin/*`, error mapping (401/413/426/429), payload cap 256 KB. | §10.4 |
| `src/auth.ts` | Bearer token vs `RELAY_TEAM_TOKEN` and `RELAY_TEAM_TOKEN_PREV` (14-day grace, `X-Relay-Warn: token-rotated`), `X-Relay-Dev` upsert (placeholder devs), `X-Relay-Proto` -> 426 below `minClient`. | §3.3, §10.4 |
| `src/db/schema.ts` | Drizzle schema for every §10.1 table (unique/partial indexes as specified; add `'cwd'` to the events type enum — see protocol note). | §10.1 |
| `src/db/client.ts` | `DATABASE_URL` -> `@neondatabase/serverless`, else PGlite file db; one `db` export. | §2.3 |
| `src/db/migrate.ts` | Programmatic migration for PGlite/dev (drizzle `migrate` or push-equivalent), `meta` schema version. | §10.1 |
| `src/routes/session.ts` | `POST /v1/session/start` (upsert session/repo/config, placeholder merge, digest full/delta, lazy sweep), `POST /v1/session/end` (presence gone, claim release, `waitUntil(handoff)`), `POST /v1/iam`. | §4.1, §4.9, §3.3 |
| `src/routes/events.ts` | `POST /v1/events`: idempotent by id and semantics, heat upsert with `GREATEST`, presence from `server_at` for live events only, replay rules, `delivered`, `turn_end` upsert + draft, contract/commit/retract -> impact routing. | §10.1 write semantics, §7.5 |
| `src/routes/query.ts` | `GET /v1/snapshot`, `GET /v1/query/{status,who_is_on,recent_changes,decisions,handoffs,impacts,impact_of}` -> protocol response types. | §9.2, §10.4 |
| `src/routes/actions.ts` | `POST /v1/{notify,claim,release,decide,ack,handoff}`. | §9.2 |
| `src/routes/depindex.ts` | `POST /v1/depindex` replaces the row. | §7.4 |
| `src/routes/admin.ts` | Admin-token routes: token rotate, export, purge. | §11.2 |
| `src/snapshot.ts` | Snapshot builder (~20 ms), per-repo in-memory cache (<= 10 s TTL, invalidated by writes), heat caps, `mine` tagging, change sets targeting the caller, inbox. | §10.2 |
| `src/digest.ts` | `<relay-digest>` renderer: sections, caps, absolute timestamps, `full`/`delta`, identity-unknown and plugin lines, `since` from `dev_repo.last_session_end_at`. | §9.3 |
| `src/presence.ts` | State derivation (working incl. in-turn, idle, away, gone), developer-level union, implicit claims. | §6.1–§6.3 |
| `src/impact.ts` | Routing: impact upsert/rev/supersede, change sets (30 min window), dependents union (client, depindex, cross-repo, `depends`), areas, developers + scores, priority rule, debounce, retract, targets + notifications, acks (manual/auto/expiry). | §7.5 |
| `src/handoff.ts` | Heuristic tier from hub data, LLM tier (`@anthropic-ai/sdk`, `RELAY_HANDOFF_MODEL`, structured output, 20 s timeout), `self` tier, advisory lock + `ON CONFLICT` rev bump, markdown rendering with Egregore frontmatter, `notes_to` notifications. | §8 |
| `src/llm.ts` | Anthropic client wrapper + JSON schema of `HandoffBody`; no-op when `ANTHROPIC_API_KEY` is absent. | §8.2 |
| `src/sweep.ts` | Lazy sweep (conditional-update lock on `meta.last_sweep_at`): presence decay, idle interim handoffs, 2 h auto-end, debounce promotion, claim expiry, retention purges. | §6.2, §8.1 |
| `src/*.test.ts` | Idempotency (event id + semantic keys, replay never revives), routing priority, change-set merging, debounce, digest caps, sweep lock. | §12 M0 |

## examples/demo-repo, scripts, CI

| File | Responsibility | Spec |
|---|---|---|
| `examples/demo-repo/` | Template monorepo: `packages/contracts` (`orders.ts` with `OrderFilter`), `apps/app`, `apps/dashboard` (`OrdersTable.tsx`, `hooks/useOrders.ts`), `prisma/schema.prisma`, `.relay.json` (project `acme-portal`, repo override `demo/app`). | §12 M0 |
| `scripts/demo.sh` | `pnpm demo up|down`: API on :8787 (PGlite), bare marketplace `/tmp/relay-demo/mkt.git`, `origin.git`, two clones with `.claude/settings.json` (marketplace `file://`, `env` block with `RELAY_HOME`/`RELAY_DEV`/`RELAY_HUB`/`RELAY_TOKEN`/`RELAY_SNAPSHOT_TTL_MS`, statusLine), git identities. `--plugin-dir` fast variant. | §12 M0 |
| `scripts/smoke/run.mjs` + `scripts/smoke/*.json` | `pnpm test:hooks`: replay stdin fixtures through `dist/hook.mjs` against the local API; assert stdout JSON shape, exit 0, p95 timings (pre-edit < 120 ms, prompt < 150 ms), 8 parallel pre-edit/post-edit -> exactly one `ask`, 50 foreign commits via `git pull` -> zero commit events. Fixture shape: `{ "verb": "<HookVerb>", "env": {…}, "stdin": <HookInput>, "expect": { "exit": 0, "stdout": "none" | "json", "hookEventName"?: …, "maxMs"?: … } }`. | §12 M0 |
| `scripts/relay-admin.mjs` | `init-project`, `doctor`, `demo up|down`, `token new|rotate`, `team set`, `plugin publish`. | §2.2, §3.1 |
| `scripts/publish-plugin.sh` | Copy `packages/plugin/` to the `relay-plugin` repo, commit with the monorepo SHA, push. Not run in M0. | §2.3 |
| `.github/workflows/ci.yml`, `publish-plugin.yml` | M1: build + test + `git diff --exit-code packages/plugin/dist`; publish on `packages/plugin/**` changes. | §2.3 |
| `docs/verified.md` | One line per Appendix B experiment. | §12 M0 day 1 |

## Protocol decisions made by the scaffold (design left them implicit)

1. `cwd` is a client event type (`CwdEvent`) — add `'cwd'` to the `events.type` enum; the
   hub may store it as a plain event or ignore it.
2. `RetractEvent` carries `hash` in addition to `impactId` because the client rarely knows
   the hub's impact id; the hub resolves the open record by `(session, path, hash)` or the
   latest open record for `(session, path)`.
3. `ContractKind` values are named here (`export`, `member`, `prisma`, `openapi`, `graphql`,
   `proto`, `sql`, `zod`, `trpc`, `python`, `go`, `file`); the design listed categories only.
4. `POST /v1/iam {placeholder, sessionId?}` merges a placeholder identity outside of
   session start so `whoami iam=` can act immediately.
5. `POST /v1/ack` takes `{id, note?, auto?}` where `id` is a change-set or impact id
   (the `impacts` tool's `ack` argument).
6. `SessionPresence` (the `session` object of `/v1/events`) carries optional
   `client/host/cwd/project/startSha` so the hub can create a session row that a killed
   SessionStart never registered (§4.0 rule 10).
7. `SessionEndRequest.files` is `SessionFileSummary[]` (`{path, area, edits}`), and
   `commits` reuse `HandoffCommit`.
8. Prompt text on the wire (only with `privacy.send_prompts`) is capped at 2,000 chars
   (§11.1) while the journal keeps 300 (§4.2); `LIMITS.promptWireChars` is the wire cap.
9. `OutboxEntry` has `endpoint` and `ephemeral` so the drain does not need to inspect bodies.
10. Query/tool response shapes (`StatusResponse`, `WhoIsOnResponse`, `RecentChangeItem`,
    `ChangeSetView`, `ImpactOfResponse`, `NotifyResponse`, …) are defined by the scaffold;
    §9.2 describes them in prose only.
11. Identity source names (`IdentitySource`) and `SessionMeta.gitEmails` (the author-filter
    set) are named here.
12. The hook bundle is unminified (readable stack traces); the MCP bundle is minified.
