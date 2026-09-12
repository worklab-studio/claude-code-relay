# Prior art: how Egregore and Entire implement "team memory" for Claude Code

Reverse-engineered from source on 2026-09-12.

- Egregore: `github.com/egregore-labs/egregore` @ `f6688d97` (2026-09-03) — ~350 files, almost entirely bash + jq, plus a Python ingest layer and a Neo4j "connected mode".
- Entire CLI: `github.com/entireio/cli` @ `174dca01` (2026-09-11) — Go binary, git-native checkpointing of agent sessions.

Clones used for this analysis live in the session scratchpad (`.../scratchpad/egregore`, `.../scratchpad/entire-cli`). All line references below are to those checkouts.

---

## 0. TL;DR

| | Egregore | Entire |
|---|---|---|
| **Core idea** | A second git repo (`memory/`, symlinked into the instance repo) holds markdown handoffs/decisions/people; hooks sync it and render a greeting that is pasted into Claude's context. Optional Neo4j graph ("connected mode"). | Every Claude Code turn is snapshotted (transcript + touched files) onto a *shadow git branch*; when the user commits, it is condensed into a checkpoint ref linked to the commit via an `Entire-Checkpoint:` trailer. |
| **Unit of memory** | Human-readable markdown file per handoff/session/wrap, addressed to a person. | Machine-readable checkpoint tree: `metadata.json` + `full.jsonl` transcript + `prompt.txt` per session per commit. |
| **Sync transport** | Plain git: fetch on SessionStart (parallel, backgrounded), `pull --ff-only` every 5 min on UserPromptSubmit, `pull --rebase && push` ×3 retries on write. | Plain git: shadow branch is local-only; checkpoint refs (`refs/entire/checkpoints/<shard>/<id>`) are pushed piggy-backed on the user's `git push` via a `pre-push` git hook. |
| **What Claude sees at start** | A large ASCII greeting card + `<!-- session-context {json} -->` + the whole `egregore.md` "soul" file inlined + hard rules ("BRANCH RULE", "IMPORTANT: display greeting exactly"). Plus a ~8k-token CLAUDE.md. | A one-line `systemMessage` banner ("Entire CLI will link this conversation to your next commit.") and, once per session on the first prompt, a ~90-word `additionalContext` telling the model to run `entire agent-help`. |
| **Presence / claims / impact routing** | Presence = "last seen" derived from remote `dev/*` branch tip dates + Session nodes; "claims" = a handoff can be `claim-handoff`ed to a session in the graph (connected only). No file-level claims, no impact routing. | None. Purely retrospective. Concurrent-session *warning* only (two sessions on same HEAD). |
| **Hook latency** | Light hooks 40–60 ms measured. SessionStart is the heavy one: ≥4 parallel `git fetch` + ~11 parallel subshells + graph queries; comments in source cite ~2 s per fetch, ~5 s for team-presence loop before optimization, "several KB" of hook stdout. A background daemon ("attendant") exists specifically to pre-warm this. | Stop hook: transcript flush wait up to 3 s + redaction (99.7% of cost on big sessions) + in-memory git tree write. Commit hooks: measured ~73–103 ms per *stale session* in `.git/entire-sessions/`, i.e. 16 s for ~95 leftover sessions (their own perf doc). |

**Biggest lesson:** both tools converge on *git as the sync bus* and *hooks as the capture point*, and both spent most of their engineering on (a) keeping hooks from blocking the user and (b) making concurrent writes not corrupt. Neither has a live/team-presence or file-ownership layer; that gap is real.

---

## 1. Egregore

### 1.1 Architecture

Three repos side-by-side on disk:

```
~/dev/
  <instance>/          # fork of egregore-labs/egregore (the "core" repo): bin/, .claude/, CLAUDE.md, egregore.json, egregore.md
  <instance>-memory/   # the shared memory repo (markdown only), pushed straight to main, no PRs
  <managed-repo-1>/    # optional: your actual code repos, listed in egregore.json .repos[]
```

`<instance>/memory` is a **symlink** to `../<instance>-memory` (`init-gh.sh:862`). Memory scaffold (`init-gh.sh:829`):

```
people/  handoffs/  knowledge/decisions/  knowledge/patterns/  knowledge/findings/  quests/  wraps/  artifacts/
```

Later additions seen in code: `sessions/YYYY-MM/`, `handoffs/YYYY-MM/`, `wraps/YYYY-MM/`, `handoffs/index.md`, `knowledge/questions/`, `soul/`, `scrolls/`, `harvests/`, `board/board.json`.

Config files:
- `egregore.json` (committed): `mode: local|connected`, `org_name`, `github_org`, `memory_repo`, `slug`, `repos[]`, `base_branch` (default `develop`), `upstream_url`, `boundary{}`, `features{}`.
- `.env` (gitignored, 0600): `GITHUB_TOKEN` (from `gh auth token`), `EGREGORE_API_KEY` in connected mode.
- `.egregore-state.json` (gitignored): `github_username`, `github_id`, `person_id`, `display_name`, `onboarding_complete`, consent flags (`transcript_sharing`, `telemetry`, `session_tracking`).
- `.egregore-session-id` (written by every SessionStart; read by every other hook).

Two modes: **local** (no network beyond git) and **connected** (Neo4j graph behind an API gateway at `api_url`, Telegram notifications, transcript upload to Supabase, hosted HTML artifacts).

### 1.2 Install flow (`npx create-egregore` / `bin/init-gh.sh`)

`create-egregore` (npm) is not in this repo; `DEVELOPMENT.md:640-760` documents it: it claims a single-use setup token from the Egregore API (`GET /api/org/claim/{token}`), runs GitHub device flow if needed, `git clone https://x-access-token:...` the fork and memory repo, writes `.env`, installs a shell alias. The `gh`-only path (`bin/init-gh.sh`, 1091 lines) does the same without the API:

1. Preflight `git`, `gh`, `jq`, `gh auth status`.
2. Pick owner (personal or org), new-vs-existing project, repos to "manage".
3. `gh repo create` from the public template for the core repo + `<org>-memory` repo.
4. Clone all as siblings; `set_identity` on each (repo-local `user.name`/`user.email = <login>@users.noreply.github.com`).
5. Scaffold memory dirs with `.gitkeep`, commit "Initialize memory scaffold", push.
6. `ln -s <memory-dir> <instance>/memory`.
7. Write `egregore.json` (mode `local`), **commit and push it to main** so joiners can read config before cloning; then create `develop` from main.
8. Write `.env` with `GITHUB_TOKEN=$(gh auth token)`, chmod 600.
9. Write `.egregore-state.json` with `onboarding_complete:false` so the first session runs `/onboarding`.
10. Write `memory/people/<login>.md` (YAML frontmatter: `name`, `github`, `role: founder`, `joined`).
11. Install shell alias: `alias <slug>='cd "<dir>" && claude start'` in `.zshrc`/`.bashrc`. (`greeting.sh:349-364` later self-migrates old aliases to `claude "start"` — the empty prompt auto-sends the first message so the greeting turn fires.)
12. Optional invites: `gh api PUT /repos/<org>/<repo>/collaborators/<user>` on every repo + stub person file.

Join (`join-gh.sh`): accept pending invitations, clone core+memory+managed repos, symlink, `.env`, state file, alias, show inviter's welcome note, first session runs `/onboarding`.

Onboarding (`/onboarding` skill) is a conversational flow that writes the person file with an `Onboarded:` line — this line is the **"completion witness"** that `session-start.sh:99-125` greps for to self-heal a lost state write. Three witnesses in order of strength: `^Onboarded:` in person file, `^# ` H1 in person file, `### <display_name>` under `## Members` in `egregore.md`.

### 1.3 Hook set (`.claude/settings.json`)

| Event | Matcher | Script | Purpose |
|---|---|---|---|
| SessionStart | `startup` | `bin/session-start.sh` (653 lines + 5 libs) | identity, git sync, context gather, greeting |
| UserPromptSubmit | `""` | `memory-refresh.sh`, `emissary-detect.sh`, `search-hint.sh` | throttled memory pull; routing hints |
| PreToolUse | `Read\|Edit\|Write\|Bash\|Glob\|Grep` | `boundary-check.sh` | path isolation between instances |
| PreToolUse | `Edit\|Write\|Bash\|EnterWorktree\|EnterPlanMode` | `onboarding-guard.sh`, `branch-guard.sh` | block writes on protected branch (exit 2) |
| PreToolUse | `Bash` | `infra-hint.sh`, `release-guard.sh` | advisory |
| PostToolUse | `Edit\|Write\|Bash\|NotebookEdit` | `observe.sh` | activity JSONL + drift warning |
| PostToolUse | `Edit\|Write` | `admin-content-detector.sh`, `release-guard.sh` | advisory |
| SubagentStart | `""` | `subagent-context.sh` | inject cached org context into subagents |
| PreCompact | `""` | `bin/pre-compact.sh` | WAL snapshot + `CONTEXT_REINJECT:` block |
| Stop | `""` | `save-reminder.sh`; `session-autosave.sh --debounce 600` | nag about unsaved work (10-min cooldown); background autosave |
| SessionEnd | `""` | `session-log.sh`, `transcript-archive.sh`, `loom.sh actuals`, `session-autosave.sh` | write session capture, gzip+upload transcript, drain WAL |
| WorktreeCreate/Remove | `""` | `worktree-create.sh` / `worktree-remove.sh` | `dev/<author>/<slug>` worktree under `.claude/worktrees/` |
| statusLine | | `bin/statusline.sh` | `mode · ⎇ branch · N unsaved` (measured 90 ms) |

Permissions: `defaultMode: acceptEdits`, allow `Bash`, `Read`, `Write`, `Edit`; `additionalDirectories: ["memory"]` (so the symlink target is readable). SessionStart also **rewrites `.claude/settings.local.json`** every boot to add `Edit(<other-instance-path>/**)`/`Read(...)` deny rules for every other Egregore instance registered in `~/.egregore/instances.json` (`session-start.sh:355-382`).

### 1.4 SessionStart, step by step (`bin/session-start.sh`)

Runs once per `startup` (not on resume/clear). Sequence, with network calls marked **[net]**:

1. Worktree detection; re-link shared state symlinks; clear per-session consent files.
2. `lib/identity.sh` — see 1.6. **[net: curl api.github.com/user, only if no stored username]**; background `gh api user` for gh-vs-git identity mismatch (result shown *next* session).
3. Ensure base branch exists locally (`develop`); if missing on remote, double-forked `git push -u`.
4. Onboarding check + witness self-heal. If not onboarded: prints `onboarding_needed author=<x>` and **exits** (CLAUDE.md says invoke `/onboarding`).
5. Connected mode: validate `EGREGORE_API_KEY` slug; if slug mismatch, **[net: curl probe with 3s/5s timeouts]**; if 401/403, background re-fetch of key.
6. Register instance in `~/.egregore/instances.json`; compute boundary file `/tmp/egregore-boundary-<md5>.json`; rewrite `.claude/settings.local.json` deny rules.
7. `lib/git-sync.sh` — see 1.5. **[net: up to 4+ parallel fetches, then `wait`]**.
8. Graph bootstrap (double-forked, detached): MERGE Org node, `person.sh sync`, create a `Session` node with `status='active'` via WAL-then-direct-write. **[net, background]**
9. Retry queued transcript uploads; drain graph WAL. **[net, background]**
10. Write `/tmp/egregore-baseline-<sid>.json` (branch, commit, dirty, started_at) for SessionEnd delta.
11. `attendant.sh ensure` — spawns the **background daemon** (pidfile check, ~ms). Note the README says "No background processes. No daemons." — this is no longer true; the attendant loops every 60 s and warms every 5 min.
12. `connect-refresh.sh`, `session-autosave.sh --sweep` (detached).
13. `lib/context.sh` — 11 parallel subshells writing to a `mktemp -d`, then `wait`:
    1. recent handoffs (3 newest `.md`, 120-char preview)
    2. quests (list of `memory/quests/*.md` names)
    3. `git log --author=$AUTHOR -1`
    4. personal todos **[graph]**
    5. team presence — merges (a) graph `Session` nodes per person, (b) `git for-each-ref refs/remotes/origin/dev/` committer dates (single awk pass; comment says the previous per-person bash loop was "~5s" at 16+ teammates), (c) `**Author**:`/`**Date**:` lines from the 20 newest session/wrap/handoff files, (d) "working on" = H1 of each person's newest capture file. One big `jq` merge computes `last_seen` relative times.
    6. `## Self-Summary` section of `egregore.md`
    7. handoffs addressed to me: graph `open-handoffs` read, else `grep -rli "[Tt]o[*]*: *<name variants>" memory/handoffs/`; parses the `## Repo State` table out of each
    8. pending questions (`memory/knowledge/questions/*.md` with `to:`/`status: pending` frontmatter)
    9. graph health **[net]**, telegram health **[net]**
    10. lifecycle: merged PRs + implemented handoffs since last wrap **[graph]**
    11. Pulse brief **[graph]**; momentum metrics (`lib/metrics.sh`, git + file scans + graph)
    The attendant pre-bakes a tar of the graph-bound results every 5 min; `context.sh` reuses it if <15 min old and author/mode/config/endpoint/schema fingerprints all match.
14. `lib/dashboard-artifact.sh` — connected mode publishes an HTML dashboard.
15. Loom "doctor --brief" (cached 6 h; "~2s of jq" otherwise).
16. `lib/greeting.sh` renders everything to a buffer, caches the visible card to `~/.egregore/greeting-card-v7-<key>`, then `cat`s it to stdout.

Everything the hook prints to stdout lands in Claude's context as the SessionStart hook output.

### 1.5 Sync mechanism (how the shared repo is fetched/pushed, how often, conflicts)

**Read side (fetch/pull):**

- SessionStart (`lib/git-sync.sh:54-117`): `git config pull.rebase true`; export `GIT_HTTP_LOW_SPEED_LIMIT=1000 / LOW_SPEED_TIME=10` so a stalled fetch aborts in 10 s. Then in parallel: `git fetch origin` (core), `git fetch upstream main` (framework update check, always), `git -C memory fetch origin`, `git -C ../<repo> fetch origin` for each managed repo; `wait`. **Skipped** (except upstream) if the attendant's warm marker `~/.egregore/attendant/<key>.warm-ts` is <600 s old.
- Memory pull (`git-sync.sh:400-408`): if `HEAD != origin/main` then `git -C memory pull origin main --quiet` (relies on `pull.rebase=true` having been set... but note that config is set in the *core* repo, not memory — the memory pull is a plain pull and may produce a merge commit or fail on a dirty tree; failures are `|| true`).
- Core repo: `setup_develop()` — if on a task branch: `git add -A` (guarded against stray submodule pointers, `lib/git-safe.sh`), commit `chore(autosave): save uncommitted work from <branch>`, push if unpushed, then `git checkout develop`; ff-merge `origin/develop`; if ff fails and there are no unpushed commits and clean tree, `git reset --hard origin/develop`. **Every session starts on the base branch**; Claude is told to branch on the first message.
- Framework auto-update: `git checkout upstream/main -- bin/ .claude/commands/ .claude/skills/ .claude/hooks/ .claude/context/ .claude/agents/ loom/ CLAUDE.md skills/` then commit `chore(sync): update framework from upstream` — i.e. upstream silently overwrites local edits to framework paths on every boot unless `auto_update:false`. (Extensive comment at `git-sync.sh:123-155` about a jq `//` bug that made the opt-out never work.)
- UserPromptSubmit (`memory-refresh.sh`): if `memory/.git/FETCH_HEAD` mtime >300 s, background `git fetch origin` then `git pull --ff-only` only if `HEAD != @{u}`. Never merges/rebases; fails silently.
- Attendant daemon (`bin/attendant.sh`): every 60 s loop; `_warm` every 5 min does `git fetch origin --prune` (core), memory fetch, managed-repo fetches; stamps marker only on origin success; replays graph cache entries <24 h old; pre-bakes context tar. Does **not** pull.
- PostToolUse (`observe.sh:83-97`): if `.git/FETCH_HEAD` >300 s old, background `git fetch origin develop` (core repo), then checks whether the just-edited file changed on `origin/develop` since merge-base → `systemMessage` drift warning.

**Write side (push):**

- Memory repo writes always go straight to `main`, no PRs ("memory is markdown-only, always safe to merge"). Pattern everywhere (`capture-run.sh:230-246`, `handoff-run.sh:340-355`, `/save` skill): `git add <file>; git commit --only -- <file>; for i in 1 2 3; do git pull --rebase origin main && git push origin main && break; sleep 1; done`. `handoff-run.sh` additionally `git stash push -u` around the pull if the tree is dirty and pops afterward.
- **Conflict handling = retry three times, then report `memoryStatus: failed`.** There is no merge-conflict resolution: new files never conflict; the one shared file that can conflict is `memory/handoffs/index.md` (every handoff prepends a line after the first blank line). A rebase conflict there makes the loop fail all 3 times and leaves the memory repo mid-rebase (the script does not `git rebase --abort`). This is the fragile spot.
- SessionEnd capture uses `--async-push` (detached) so the hook returns immediately.
- Core repo: handoffs auto-save via `handoff-save-egregore.sh` (detached): create `dev/<author>/handoff-<date>` if on protected branch, commit `Handoff: <topic>`, rebase onto `origin/<base>` (fallback merge), push, `gh pr create`, and if the diff is "non-coding" (`.md` anywhere, `artifacts/`, `docs/`, `.threads/`; policy `lib/noncode.sh`) `gh pr merge --auto --merge` else leave PR open.
- Transcripts: SessionEnd gzips `~/.claude/projects/.../<sid>.jsonl`, POSTs to `api/transcript/upload` (30 s max) and/or commits into a third `egregore-transcripts` repo; failures are queued in `.transcript-retry-queue` and retried next SessionStart. Requires `transcript_sharing: true` consent.

**Frequency summary:** fetch at boot (unless daemon warmed within 10 min) + every 5 min by daemon + at most every 5 min on prompt submit + on edit if stale >5 min; push on every capture (handoff/wrap/session-end) with 3× retry.

### 1.6 Identity resolution (`bin/lib/identity.sh`)

Fallback chain:
1. `.egregore-state.json .github_username` (written at install). If present, force repo-local `git config user.name <github_name>` and `user.email <login>@users.noreply.github.com` so commits attribute correctly.
2. `curl https://api.github.com/user` with `GITHUB_TOKEN` from `.env` (5 s timeout). Derives `person_id = github:<numeric id>` (stable across renames) or `github-login:<lowercase login>`. Founder-vs-joiner = `login == github_org`. Writes state file.
3. Connected mode: Cypher lookup of `Person` by `github`, `githubId`, or `githubAliases[]` → existing member on a new machine skips onboarding.
4. `git config user.name` → lowercase first word.
5. `"unknown"`.

Then exports `EGREGORE_USER`, `EGREGORE_ORG`, `EGREGORE_SESSION_ID = <UTC ts>-<author>-<pid>`, writes it to `.egregore-session-id` and `~/.egregore/session-<md5(projdir)>.id` because **env vars set by hooks do not propagate into Claude's tool calls** — every other hook and skill reads the file.

Recipient matching (handoff skill Step 0): `memory/people/*.md` is the team directory — filename = GitHub handle, first line `# Display Name` = chosen name (`/me "call me oz"` writes it). Match case-insensitively against either; display name wins. The greeting's "addressed to me" grep also tries display name, first word of GitHub name, and people-file H1.

### 1.7 Activity tracking (PostToolUse `observe.sh`)

- Fires on `Edit|Write|Bash|NotebookEdit`. Reads `.egregore-session-id`; if absent, exits.
- Parses `tool_name` and `file_path`/`notebook_path`/first path-like token in `command` with grep/sed (no jq, "saves ~15ms").
- Appends **one line** to `/tmp/egregore-obs-<session-id>.jsonl`:
  ```json
  {"ts":"2026-09-12T09:19:37Z","tool":"Edit","path":"bin/foo.sh"}
  ```
  Capped at 500 KB per session (silently stops appending). Measured cost: 40–60 ms including the git drift check.
- Consumers: `pre-compact.sh` (top-10 files + count, into `CompactSnapshot` graph node via WAL and into the reinjected context), `session-log.sh` (≤10 unique paths listed under `## Files` in the auto session capture), `transcript-archive.sh` (`ActivitySummary` node: tools, ≤50 paths, count; copies buffer to `/tmp/egregore-pulse-<sid>.jsonl` and launches `pulse.sh` — a Sonnet-based post-session synthesis — then deletes the buffer).
- Nothing is shared with teammates *live*; the buffer is local `/tmp` and only surfaces after SessionEnd as a file in `memory/sessions/` or a graph node.

### 1.8 Handoff format and pipeline

File path: `memory/handoffs/YYYY-MM/DD-<author>-<slug>.md` (collision → `-2`, `-3`…). Written by `bin/handoff-run.sh` from stdin, invoked through `bin/capture-run.sh --mode addressed`. Frontmatter is normalized by an awk pass (`handoff-run.sh:145-205`) so every persisted handoff has:

```markdown
---
capture_schema: egregore-capture/v1
capture_mode: addressed
kind: addressed
from: alice
addressed_to: bob            # optional
date: 2026-09-12
topic: auth flow
intent: action | feedback | fyi
content_mode: generated | supplied
claim: <one line — what this handoff is>
ask: <what the receiving agent should do>
receiver_instructions: <optional directive to the receiving agent>
---

## Briefing
<2–4 sentences>

## Key Decisions / ## Current State / ## Open Threads / ## Next Steps / ## Entry Points
...

## Repo State                     <- appended by bin/repo-state.sh --no-pr
| Repo | Branch | PR | Base |
|------|--------|----|------|
| api  | dev/alice/auth-flow | — | develop |

## Session Artifacts              <- appended from graph query (connected only)
- Decision: ... -> knowledge/decisions/....md
```

`memory/handoffs/index.md` gets a line prepended: `- **2026-09-12** — alice: auth flow (handoff to bob)`.

Pipeline (one bash process, three parallel branches, wall-clock = max): A) `index-handoff.sh` → Neo4j `Session` node + `BY`/`HANDED_TO`/`ABOUT` edges; B) memory commit + pull-rebase-push (waits for D = today's artifacts query); C) render HTML via `egregore-artifacts` (node/npx) and publish to emissary API or `publish-artifact.sh`, then create a Telegram notification *proposal* (never sent without a separate AskUserQuestion consent). Result JSON at `$TMPDIR/handoff-run-result.json`; `render-card.sh` prints a 72-col box. Then a detached `handoff-pr-backfill.sh` rewrites `—` → `#N` in the Repo State table once `gh pr list` returns, and `handoff-save-egregore.sh` auto-commits the core repo.

The handoff skill also asks Claude to author a second artefact: a JSON "house-kit render spec" (`{"kind":"handoff","claim":..,"sections":[{"component":"steps|tagcards|panels|compare|ledger|flow|pullquote|note|prose",...}]}`) that is validated for "fidelity" against the markdown before publishing. The markdown is canonical; the JSON is presentation.

Lifecycle: handoffs carry `handoffStatus` pending → read → claimed → done/expired in the graph; `claim-handoff` links the picking-up session with an `IMPLEMENTS` edge; a single-recipient handoff auto-closes when the recipient's session `/wrap`s (`capture-run.sh:18-40`). In local mode none of this exists — status lives only in the greeting grep.

Session captures (`/wrap` and automatic SessionEnd) share the same engine but a simpler shape (`capture-run.sh:210-228`): `# Session: <topic>` / `**Capture Schema**` / `**Capture Mode**` / `**Date**` / `**Author**` / `**To**` / `**Branch**` / `**Session**` / `**Duration**` / `## Summary` / optional `## Files`, `## Commits`. The automatic SessionEnd capture is skipped for sessions <2 min with 0 commits and 0 observed actions, and skipped if a handoff/wrap by the same author already exists for that day.

### 1.9 The other hooks

- **PreCompact** (`bin/pre-compact.sh`): appends a `CompactSnapshot` Cypher to the WAL (no network), then prints:
  ```
  CONTEXT_REINJECT:
    Branch: dev/alice/auth
    Develop: 1a2b3c4
    Unsaved changes: 3 files
    Session activity: 42 tool calls across 9 files
    Most active:
      src/auth.ts (12)
      ...
    Compaction #1 — your earlier work is preserved in the graph.

  IMPORTANT: Tell the user they have 3 unsaved changes. Suggest running /save before continuing.
  ```
- **Stop** (`bin/save-reminder.sh`): silent unless memory or core repo is dirty/unpushed; then once per 10 min prints `Unsaved changes: 2 memory file(s) + 3 code file(s). /wrap to close session, /save to keep working.` A second Stop hook runs `session-autosave.sh --debounce 600` in the background.
- **UserPromptSubmit** `search-hint.sh`: regex-detects recall-shaped prompts ("did we decide", "find the handoff about", "our pricing"...) and once per session emits `hookSpecificOutput.additionalContext` telling the model to run `bash bin/search.sh query "<concept>"` first (hybrid keyword+semantic over `memory/`).
- **SubagentStart** (`subagent-context.sh`): cats `/tmp/egregore-subagent-ctx-<sid>.txt` written by greeting.sh:
  ```
  <!-- egregore-context
  Organization: Acme (github: acme-org)
  Session: dev/alice/auth — 20260912T091937-alice-12345
  Active quests: q1, q2
  Recent handoffs: 12-alice-auth-flow, 11-bob-billing
  Memory: memory/ is a symlink to shared knowledge base. Use bin/graph.sh for Neo4j queries.
  -->
  ```
- **PreToolUse `branch-guard.sh`**: if on `develop|main|master|<base>` and the tool would write a non-exempt path (memory/ and a few dotfiles are exempt), exit 2 with a block message instructing the model to create `dev/<author>/<slug>` first. Consent file `.egregore-branch-consent` (cleared each session) bypasses. Measured 40 ms.
- **PreToolUse `boundary-check.sh`**: reads `/tmp/egregore-boundary-<hash>.json`; denies reads/edits outside `project_dir`, `memory_dir`, `managed_repos`, `read_roots` (`~/Downloads`, `~/Desktop` unless `posture: strict`) and explicitly denies other instances' paths. Measured <10 ms.
- **WorktreeCreate**: implements Claude Code's `EnterWorktree` — `git fetch origin <base>`, `git worktree add .claude/worktrees/<slug> -b dev/<author>/<slug> origin/<base>`, symlinks `memory`, `.env`, state files; must print the path within 2 s.

### 1.10 Exact text shapes injected into Claude's context

**SessionStart stdout (greeting.sh), in order:**

```
  ███████╗ ██████╗ ...   (6 lines of ASCII art, ~70 cols each)

  acme-org/egregore                                    Alice · dev/alice/auth · 3↑
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  ◦ momentum · this week                                  4 of 6 active
  sessions      12   5-week ▂▃▅▇█   +20% vs last week

  commits       31   5-week ▁▃▂▆█   3 authors

  handoffs       4   5-week ▁▁▂▃▂   1.5d avg resolution

  knowledge      7   5-week ...      142 artifacts total
  ◐ 2 pending questions from bob — /answer to engage
  ◇ 1 handoffs for you — say "show my handoffs" to review or close
  ✓ Auto-saved uncommitted work on dev/alice/old-topic
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  ✓ ready                                              ◆ memory synced
  ◆ framework updated from upstream — 3 file(s) replaced: bin/x.sh ...
  ⟲ auto-saved 1 non-coding save(s) → develop while you were away
  ◆ https://egregore.xyz/view/<slug>/board (board)
  ⧖ 2 pending turn(s) on your scrolls: ...

<!-- session-context
{"framework_version":"7","time_of_day":"morning","dashboard_url":"","recent_handoffs":[{"name":"12-alice-auth-flow","preview":"---\ncapture_schema: egregore-capture/v1 ..."}],"addressed_to_user":["..."],"quests":["..."],"last_user_activity":"3 hours ago|feat: ...","team_recent_memory":[{"name":"bob","last_seen":"2h ago","working_on":"billing retries","branches":["billing retries"]}],"soul_self_summary":"...","lifecycle":{"merged_prs":[],"implemented_handoffs":[]},"momentum":{...},"pulse":{}}
-->

<!-- egregore-soul
# <entire contents of egregore.md, the org identity document>
-->
<!-- latest-reflection: memory/soul/2026-09-01-....md — read when org identity, culture, or history context matters -->

IMPORTANT: Display the above greeting to the user exactly as-is (preserve the ASCII art formatting and ornamented status) on their first message. Then ask: What are you working on?

BRANCH RULE: When the user responds with what they're working on, your FIRST action is to create a working branch: git fetch origin develop --quiet && git checkout --no-track -b dev/{author}/{topic-slug} origin/develop. Do this BEFORE any other work. Derive the topic slug from their description. If they ask a pure question with no work intent, skip branching.
```

Size controls visible in source: handoff previews trimmed to 80 chars, quests capped at 20, team trimmed to 8 people × 1 branch × 80-char `working_on`, context JSON emitted with `jq -c` ("whitespace alone is ~1KB"), soul reflection *pointed at* rather than inlined because "injected verbatim it pushed hook stdout past the harness inline threshold, which turns the greeting into a file the model must Read back". The `egregore.md` soul file itself is still inlined in full. The ASCII card is "~1k tokens of box art" that CLAUDE.md orders the model to re-type verbatim on turn 1.

**Plus CLAUDE.md** (32 KB, ~8k tokens, always loaded) with sections: On Launch — MANDATORY FIRST ACTION; After Greeting — BRANCH ON FIRST RESPONSE (EnterWorktree); Starting-work / Returning-work UX contracts (`↳ Context restored: {…} · {source/date}` receipts); Handoff claiming; Knowledge Graph named reads; "Egregore Retrieval Beat" (`⌕ Egregore · searching your organization’s memory` must be printed before any retrieval tool call); Notifications consent; Memory layout; Loom routing; Git workflow; Socratic questioning; Environment isolation. Plus `.claude/rules/voice-bedrock.md` and ~50 skills.

**PostToolUse systemMessage:** `{"continue":true,"systemMessage":"⚠ src/auth.ts also changed on develop — consider running /save soon to rebase"}`.

**UserPromptSubmit additionalContext (search-hint):** `Routing hint: this prompt asks for recall from org memory. FIRST action: \`bash bin/search.sh query "<the concept, not the literal sentence>"\` — one ranked call over all of memory/ … Do NOT improvise ls/grep/graph exploration first …`

### 1.11 Latency (measured and estimated)

Measured on this Mac (M-series, warm cache, no network), per hook invocation:

| Hook | Wall time |
|---|---|
| `observe.sh` (PostToolUse) | 40–60 ms |
| `branch-guard.sh` (PreToolUse) | 40 ms |
| `boundary-check.sh` (PreToolUse) | <10 ms (no boundary file → early exit) |
| `memory-refresh.sh` (UserPromptSubmit) | <10 ms (throttled path) |
| `statusline.sh` | 90 ms |

Those fire on every tool call; three PreToolUse hooks on every Edit/Write means ~100 ms per write in hook overhead before Claude's own tool latency.

SessionStart — **yes, it does git fetch and pull.** Not measured (needs a real instance) but from source:
- Cold path: parallel fetches bounded by the slowest of origin/upstream/memory/managed repos; comments cite "~2s per repo" of network and the upstream fetch is *always* on the critical path (`git-sync.sh:97`). Then memory `pull`, ff-merge of develop, possibly `git checkout develop` (touches working tree), possibly commit+push of a dirty task branch.
- Context gather: 11 subshells in parallel; graph queries each are an HTTPS round-trip (connected mode); local-mode file scans are single awk passes. Comment: team-presence loop "was the single largest block of session-start's boot time (~5s)" before being rewritten in jq.
- Loom doctor: "~2s of jq" when the 6 h cache misses.
- Realistic estimate: 3–8 s cold, 1–2 s when the attendant marker + context tar are fresh. The whole attendant daemon exists because this was too slow; the greeting-card cache and `EGREGORE_CARD_SHOWN` fast path (reverted because Claude Code ≥2.1.89 alt-screen hides pre-launch output) exist because the ~1k-token card re-typing on turn 1 was too slow.
- Output size: card ~1k tokens + context JSON (few hundred tokens to ~2k) + full `egregore.md` (unbounded; "several KB") + rules. Then CLAUDE.md ~8k tokens on top. Realistically 10–15k tokens of fixed overhead per session before the user types anything.

SessionEnd: `session-log.sh` shells out to `python3` twice for ISO-date math; `transcript-archive.sh` gzips the transcript and backgrounds the upload. Hook itself returns fast; work continues detached.

### 1.12 What Egregore does NOT do

- **No live presence.** "Team presence" = last commit date on `origin/dev/<name>/*` refs, Session-node start times (connected), or `**Date**:` lines in capture files. Granularity is "2h ago / yesterday"; it is computed once at SessionStart and never refreshed during the session. No heartbeat, no "Bob is editing `auth.ts` right now".
- **No claims/locks on files or areas.** The only "claim" is graph-level `claim-handoff` (a session says it is implementing a handoff). Drift detection is a *post-hoc* warning after you already edited a file that changed on `develop`.
- **No impact routing.** Nothing maps a change to who should hear about it. Notifications are only for explicitly addressed handoffs, and require a manual Send/Edit/Cancel consent every time (they had an incident; see `.claude/context/notification-consent.md`).
- **No per-tool-call sharing.** The PostToolUse buffer is local `/tmp` and only becomes a `memory/sessions/` file at SessionEnd.
- No cross-session context beyond what fits in the greeting; retrieval is `bin/search.sh` (BM25 + embeddings over `memory/`) or Neo4j named reads, both invoked by the model on demand.
- No transcript sharing by default (opt-in consent).
- No conflict *resolution* for the memory repo, only retry.

### 1.13 Clever / worth stealing

1. **Session ID in a file, not an env var** (`.egregore-session-id`) — hooks can't pass env to Claude; every downstream hook reads the file. Simple and it works across worktrees (symlinked).
2. **Write-ahead log for remote writes** (`graph-wal.sh`): every graph mutation is appended to `~/.egregore/graph-wal-<hash>.jsonl` first (mkdir-lock, 2 MB cap), then attempted live, then drained at SessionStart/SessionEnd. Hooks never block on the network and nothing is lost offline. Directly applicable to any "post to team server" step.
3. **Detached double-fork** `( ( … ) >/dev/null 2>&1 & ) 2>/dev/null` with explicit stdout redirection — the comment at `session-start.sh:76-80` explains that a detached child inheriting the hook's stdout pipe keeps Claude Code waiting. Non-obvious and important.
4. **Guarded `git add -A`** (`lib/git-safe.sh`) that unstages gitlinks not in `.gitmodules` — because non-technical users clone sibling repos inside the checkout.
5. **Completion witnesses** (grep the artefact itself, not the state flag) to self-heal lost state writes.
6. **Throttle by mtime of `FETCH_HEAD`** — zero extra state for "fetch at most every 5 min".
7. **Context-size hygiene**: `jq -c`, per-field trimming, pointing at large docs instead of inlining, and knowing the harness "inline threshold" beyond which hook output becomes a file the model must Read (an extra round-trip). They learned this the hard way.
8. **Handoff = frontmatter contract + free markdown**, with `intent: action|feedback|fyi`, `claim`, `ask`, `receiver_instructions` split from the human body, plus an auto-appended `## Repo State` table (repo / branch / PR / base) so the receiver's agent can `git checkout` the right branches. The `intent` field drives auto-close rules.
9. **Fail-closed boolean parsing** (`_read_auto_update`) — jq `// true` turns `false` into `true`; they document the bug. Worth remembering for any bash+jq config.
10. **Subagent context injection from a cache written at SessionStart** — subagents get 5 lines of org context at zero cost.
11. **PreCompact reinjection** of branch + top-touched files + unsaved count is cheap and genuinely useful after compaction.
12. **The observe buffer format** — one JSON line per tool call `{ts, tool, path}` — is the minimum viable activity signal and costs ~40 ms. If we want live presence, this is the event to ship somewhere shared instead of `/tmp`.

### 1.14 Slow, fragile, or noisy

1. **SessionStart is a monolith** (653 + 1,800 lines of sourced libs) doing identity, git checkout, framework self-update, boundary/permissions rewriting, daemon spawn, 11 gathers, metrics, HTML publish, and greeting. Every boot mutates the working tree (auto-commit, `git checkout develop`, `git reset --hard` in one branch of the logic, rewrite of `settings.local.json`, upstream overwrite of framework paths). That is a lot of surprising side effects for a hook.
2. **Framework auto-update overwrites local edits silently** (`git checkout upstream/main -- …`). They added a greeting line to disclose it, which tells you it bit people.
3. **Memory repo conflicts are unhandled**: 3× `pull --rebase && push`, no `rebase --abort` on failure; `handoffs/index.md` is a guaranteed contention point (every handoff prepends to the same spot). Session-start memory `pull` is not ff-only.
4. **README says no daemons; there is a daemon** (`attendant.sh`, 60 s loop, fetches every 5 min, pre-bakes context, runs handoff-lifecycle jobs). Added because boot was too slow — a symptom of putting too much on SessionStart.
5. **Context bloat and behavioural coercion**: ~1k-token ASCII card that the model must reproduce verbatim, the full `egregore.md` inlined, ~8k-token CLAUDE.md with many MANDATORY/IMPORTANT rules, a required "Retrieval Beat" line before every search, "Transparency Beat", "Socratic Questioning (MANDATORY)". Much of the CLAUDE.md is UX choreography rather than knowledge.
6. **Three PreToolUse hooks on every Edit/Write/Bash** (boundary, onboarding-guard, branch-guard) + two PostToolUse; each spawns bash+jq+git. ~100 ms/tool-call overhead.
7. **Team presence is derived from branch-ref commit dates** — it lies when people rebase/squash, and it says nothing about *now*.
8. **Identity is fragile across machines**: `.egregore-state.json` is per-checkout; the gh-CLI vs `.env` token mismatch warning arrives one session late by design.
9. **Local-mode / connected-mode dual paths everywhere** — every skill has "Mode detection" boilerplate; the greeting file-grep fallbacks (`[Tt]o[*]*: *name`) are brittle.
10. **Handoff pipeline depends on node/npx** (`egregore-artifacts` render) even in local mode for the HTML preview, and warms the npx cache hourly at SessionStart.
11. `python3` shell-outs for date math in SessionEnd; `date -v-7d || date -d` macOS/GNU forks throughout.
12. `jq` is a hard dependency of every hook; a broken `egregore.json` degrades many paths to "true"/"empty" silently.

---

## 2. Entire CLI

### 2.1 What it is

A Go CLI that "hooks into your Git workflow to capture AI agent sessions". It is *not* team-memory in Egregore's sense — it is provenance/traceability: every commit gets an `Entire-Checkpoint: <ULID>` trailer pointing at a checkpoint that holds the transcript, prompts, files touched and token usage. Multi-agent (Claude Code, Codex, Gemini, Cursor, Copilot, Pi, OpenCode, Droid). Optional hosted control plane (`entire login`, orgs/projects/repos, semantic `entire search`, "trails"). Local operation needs no account.

### 2.2 Install / enable

`brew install --cask entire` (or install.sh / Scoop / `go install`). Then `entire enable` in a repo:
- writes `.entire/settings.json` (`{"checkpoints":{"primary":{"type":"git-refs"}}}` for new setups) and `.entire/.gitignore`;
- installs **git hooks** into the active hooks dir: `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-rewrite`, `pre-push` — each a 3-line sh file with an `# Entire CLI hook` marker that runs `if command -v entire >/dev/null 2>&1; then entire hooks git <name> …; else :; fi` (existing hooks backed up with a `.pre-entire` suffix);
- installs **agent hooks** into `.claude/settings.json` (see 2.3), wrapped so a missing binary is a no-op;
- optionally scaffolds `.claude/skills/entire-search/SKILL.md` and an `agent-help` skill;
- optionally imports the last 30 days of existing `~/.claude/projects` transcripts as checkpoints.

Session state lives in `.git/entire-sessions/<session-id>.json` (git common dir, shared across worktrees).

### 2.3 Claude Code hook set (from `agent/claudecode/hooks.go:159-236` and this repo's own `.claude/settings.json`)

| Event | Matcher | Command |
|---|---|---|
| SessionStart | `""` | `sh -c 'if ! command -v entire >/dev/null 2>&1; then printf "{\"systemMessage\":\"…Entire CLI is enabled but not installed…\"}"; exit 0; fi; exec entire hooks claude-code session-start'` |
| UserPromptSubmit | `""` | `… exec entire hooks claude-code user-prompt-submit` |
| Stop | `""` | `… exec entire hooks claude-code stop` |
| SubagentStop | `""` | `… exec entire hooks claude-code subagent-stop` |
| SessionEnd | `""` | `… exec entire hooks claude-code session-end` |
| PreToolUse | `Agent` | `… exec entire hooks claude-code pre-task` |
| PostToolUse | `Agent` | `… exec entire hooks claude-code post-task` |
| PostToolUse | `TaskCreate\|TaskUpdate` | `… exec entire hooks claude-code post-todo` |

Notably **no PostToolUse on Edit/Write** — file changes are recovered later from the transcript (Write/Edit tool calls) plus `git status` deltas, not observed live. The hook installer is idempotent, migrates stale matchers (`Task`/`TodoWrite` → `Agent`/`TaskCreate|TaskUpdate`), and `entire status`/`doctor` report `HooksOutdated`.

### 2.4 What each hook does (`docs/architecture/claude-hooks-integration.md`, `lifecycle.go`)

- **SessionStart** (`handleLifecycleSessionStart`): validates `session_id`; stores an agent-type hint (first-writer-wins so Cursor+Claude double-firing is disambiguated); resolves "trails" enablement scope from the git origin remote with a bounded refresh timeout (control-plane call, cached); counts other active sessions with checkpoints on the same HEAD; prints a `systemMessage` banner; stores model hint; transitions state machine; **spawns a detached zombie-session sweep** (throttled via flock marker) if any session's owning process is gone or ended >24 h ago uncondensed. No git fetch, no pull.
- **UserPromptSubmit** (`handleLifecycleTurnStart`): `EnsureSetup` (gitignore), snapshot untracked files to `.entire/tmp/pre-prompt-<sid>.json`, record transcript line offset, `InitializeSession` → creates/validates the shadow branch `entire/<HEAD[:7]>-<worktreeHash[:6]>` and writes `.git/entire-sessions/<sid>.json` (BaseCommit, WorktreePath, AgentType, Branch, `Owner` = process-ancestry fingerprint of the agent). If another session has uncommitted checkpoints on the same HEAD, returns `{"continue":false,"stopReason":…}` **once** (blocks the prompt with a warning + resume command; flag lets the next prompt through). Emits the one-time `additionalContext` injection (2.6). Session-lock wait bounded to 2 s so a still-running condensation from the previous turn cannot stall the prompt ("~30s" observed before the bound).
- **Stop** (`handleLifecycleTurnEnd` → `commitWithMetadata`): waits for Claude's async transcript flush (sentinel `hooks claude-code stop` in a `hook_progress` line, else size-stable for 500 ms, max 3 s, skipped if file >2 min stale); parses the transcript for Write/Edit tool uses → modified files; diff untracked vs pre-prompt snapshot → new files; `git status` → deleted; computes per-turn token usage (dedup by message id, plus subagent transcripts); writes staging files `.entire/metadata/<sid>/full.jsonl` (sanitized transcript) and `prompt.txt`; builds a git tree **in memory** (go-git) of the worktree + `.entire/metadata/…` overlay and commits it to the shadow branch; message derived from the last user prompt. If mid-turn commits happened, finalizes those checkpoints with the full transcript. Does not fire on Ctrl-C.
- **PreToolUse[Agent] / PostToolUse[Agent] / SubagentStop**: snapshot untracked files per `tool_use_id`; on completion, record a `TaskRecord` (tool_use_id, agent_id, subagent_type, description, declared `agent_transcript_path`, files, tokens). Background subagents: PostToolUse fires at launch, so only `SubagentStop` is treated as final.
- **PostToolUse[TaskCreate|TaskUpdate]**: only inside a subagent; if files changed since last checkpoint, writes an incremental shadow checkpoint labelled from the last completed todo.
- **SessionEnd**: complete live task records, mark session ENDED, eager condense under a deadline; PostCommit retries anything left.
- **Git hooks**: `prepare-commit-msg` finds sessions for this worktree (identity match via process ancestry ∪ worktree match), checks staged files overlap `FilesTouched`, mints a ULID and appends `Entire-Checkpoint: <id>` (agent commits detected by no-TTY take a fast path; human commits get a TTY confirm). `commit-msg` strips the trailer if the message is otherwise empty. `post-commit` condenses: reads the shadow tree, writes the checkpoint tree to `refs/entire/checkpoints/<id[-2:]>/<id>` (or the legacy `entire/checkpoints/v1` branch), deletes the shadow branch, clears `FilesTouched`. `post-rewrite` remaps after amend/rebase. `pre-push` pushes queued checkpoint refs to the *elected* remote only (captured from the user's actual push habit), optionally running an extra OpenAI-Privacy-Filter redaction pass first; a failure there aborts the user's push by design.

### 2.5 What the checkpoint contains

Shadow branch (ephemeral, per base commit + worktree, multiple sessions interleave):
```
<full worktree snapshot>
.entire/metadata/<session-id>/
  full.jsonl        # sanitized (+redacted) transcript so far
  prompt.txt        # user prompts in this checkpoint window, separated by ---
  tasks/<tool-use-id>/   # post-todo incrementals only
```

Committed checkpoint (persistent; one git ref per checkpoint, tree = the checkpoint, no worktree files):
```
metadata.json            # CheckpointSummary
0/                       # first session (stable index per session id)
  metadata.json          # per-session Metadata
  full.jsonl             # sanitized + 8-layer redacted transcript, chunked >MaxChunkSize
  transcript.jsonl       # compacted full session, self-contained; slice at compact_transcript_start
  prompt.txt
  content_hash.txt       # sha256(full.jsonl) for dedup
1/ …                     # concurrent sessions
tasks/<tool-use-id>/
  agent-<agent-id>.jsonl # subagent transcript
  task.json              # files, tokens, timings, transcript_unavailable_reason
assets/ + assets/manifest.json   # images externalized out of the transcript
```

Root `metadata.json`:
```json
{"cli_version":"…","checkpoint_id":"01K9TQ8ZP7X3F5M2WVJ4CNRB6D","strategy":"manual-commit","branch":"main",
 "checkpoints_count":3,"files_touched":["a.go","b.go"],
 "sessions":[{"metadata":"/ab/…/0/metadata.json","transcript":"/ab/…/0/full.jsonl","compact_transcript":"…/transcript.jsonl","content_hash":"…","prompt":"…/prompt.txt"}],
 "token_usage":{"input_tokens":1500,"cache_creation_tokens":200,"cache_read_tokens":800,"output_tokens":500,"api_call_count":3}}
```
Per-session `metadata.json`: `checkpoint_id, session_id (date-prefixed agent UUID), strategy, created_at, branch, checkpoints_count, save_step_count, files_touched`, plus `commit_sha` for imported history. Optional async LLM summary backfill (`BackfillSummary`) and attribution (`entire blame`/`why` map lines back to prompt + session).

Repo-wide policy at `refs/entire/policies/checkpoint` (`policy.json` with `checkpoint_version`/`checkpoint_min_version`) acts as an upgrade nudge / write guard; git hooks never block git on policy, agent hooks warn.

### 2.6 Text injected into Claude's context

**SessionStart `systemMessage`** (shown to user, also in transcript):
```
\n\nEntire CLI will link this conversation to your next commit.
```
or `…found no commits yet — checkpoints will activate after your first commit.`, optionally `\n  2 other active conversation(s) in this workspace will also be included.\n  Use 'entire status' for more information.`

**UserPromptSubmit `additionalContext`** (once per session, only when the repo has trails enabled on the control plane; `lifecycle.go:464-485`):
```
Entire is enabled for this repo. Run `entire agent-help` to see what entire does and which subcommand to use, then `entire agent-help <command>` for that command's exact, current flags. Commits automatically capture the AI session as a checkpoint, so never create checkpoints by hand — just commit normally. Leave setup and destructive commands (enable, disable, clean, auth) to the user. This repo is auto-detected from the git origin remote as github:acme/api; you are already inside it, so never ask the user for the repo name.
```

**Prompt block** (concurrent session): `{"continue":false,"stopReason":"<other session's first prompt> … entire session resume …"}`.

**Optional skill** `.claude/skills/entire-search/SKILL.md` (~350 words): use `entire search --json --compact` (never without `--json`, it opens a TUI) for "previous work, commits, sessions, prompts"; then `entire checkpoint explain <id>`; `--full` streams the whole transcript so use last.

That is the entire footprint: two sentences at start, one paragraph on first prompt, no CLAUDE.md edits. Knowledge is pulled on demand via CLI, not pushed into context.

### 2.7 Latency

- Hooks are a single Go binary exec (no bash/jq/git subprocess chains); go-git is used in-process. The hook wrapper still spawns `sh -c` + `command -v`.
- **Stop**: up to 3 s transcript-flush wait (typically <500 ms via the sentinel or the quiet window; skipped for stale files); redaction is "~99.7% of the metadata-walk blob write" for large sessions and "~82% of that is the betterleaks regex ruleset" — mitigated by an incremental redaction cache keyed on prefix hash + CLI/config fingerprint so cost is O(appended lines). Codex base64 payloads were "tens of seconds per Stop" before sanitization.
- **UserPromptSubmit**: bounded 2 s lock wait; previously could stall ~30 s behind the previous turn's condensation.
- **Commit hooks** (their own benchmark, `docs/architecture/commit-hook-perf-analysis.md`, 2026-02-27): control commit 25–30 ms; with 100/200/500 stale sessions in `.git/entire-sessions/` → 7.3 s / 16.3 s / 51.4 s total, ~73–103 ms per session, PostCommit condensation dominating (30–50 ms each, go-git `packed-refs` scanned linearly per lookup). Matches a user report of "~16 s for ~95 sessions". Hence the zombie sweep, 7-day purge, and `sweepCondenseBudget`.
- **SessionStart**: no git network; one bounded control-plane call (trails scope refresh, cached) and a `.git/entire-sessions` directory scan. Sub-100 ms typical when the cache is warm.
- **pre-push**: pushes checkpoint refs in the same push; with OPF enabled re-redacts unpushed checkpoints (batched shell-out to the filter) — can be seconds.

### 2.8 What Entire does NOT do

- No presence, no "who is working on what now". `entire activity`/`recap`/`dispatch` are retrospective reads over checkpoints (and the hosted API).
- No claims/locks; the only concurrency feature is a *warning* that another session has uncommitted checkpoints on the same HEAD.
- No impact routing / notifications.
- No handoff document. "Resume" = `entire session resume <branch>` restores the transcript files into `~/.claude/projects/...` so `claude --resume` works — logs only, **never worktree files** (rewind was removed).
- No shared human-readable memory; everything is transcripts + metadata. Semantic search requires the hosted control plane (`entire search`).
- Nothing enters Claude's context automatically except the two banners; the model must call the CLI.

### 2.9 Clever / worth stealing

1. **Checkpoint as one git ref per checkpoint** (`refs/entire/checkpoints/<shard>/<id>`, ULID ids, shard = last 2 chars). No shared branch tip → no contention between concurrent writers; fetch exactly one checkpoint on demand; pushed piggy-back on the user's `git push` to the *elected* remote. This is a very good "shared state over git without conflicts" pattern: **content-addressed, append-only refs instead of a mutable branch**.
2. **Shadow branch built with go-git in memory** — capturing worktree state after every turn without touching the index or the user's branch, and without a checkout.
3. **Commit ↔ session linking by process ancestry** (`proclive`): the hook walks its parent chain (skipping shells, the binary itself, the Go toolchain) and matches the recorded agent PID/start-time/boot-id. Robust across worktrees, immune to PID reuse. Unionised with worktree matching for human commits.
4. **Transcript flush sentinel**: Claude Code writes a `hook_progress` line naming the running hook; reading the transcript tail for it (timestamp within ±2 s of hook start) is the authoritative "file is complete" signal. Fallback: size stable for 500 ms. Directly reusable by any Stop hook that reads the transcript.
5. **Bounded lock waits on the prompt path** (2 s) so background work degrades gracefully instead of stalling the user.
6. **Files-touched from the transcript** (Write/Edit tool_use blocks) + untracked-file snapshot diff + `git status` deletions — three cheap signals, no PostToolUse hook needed at all.
7. **Sanitize → externalize images → redact**, per-line stateless redaction with an incremental prefix cache keyed by config fingerprint. If we ever store transcripts, copy this ordering and the fingerprint-invalidated cache.
8. **`agent-help` as the API surface**: instead of a 30 KB CLAUDE.md, the model is told "run `entire agent-help <command>`" and the CLI prints machine-readable, always-current usage. Context cost ~90 words.
9. **Hook wrapper idiom** `sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks …'` — uninstalled binary = silent no-op; settings file can be committed safely.
10. **Zombie sweep on SessionStart, detached and throttled**, with a per-invocation condense budget so a backlog drains gradually.
11. **Self-contained checkpoints**: each stores the full compacted transcript so a rebased/lost mid-history checkpoint doesn't break reconstruction.

### 2.10 Slow / fragile / noisy

1. Commit-time cost scales linearly with leftover session state files; they needed sweeps, purges and budgets to keep `git commit` under a second.
2. `pre-push` can abort the user's push when OPF is enabled and anything goes wrong ("safer failure mode", but surprising).
3. Stop can sit up to 3 s waiting for the transcript; big transcripts cost seconds in redaction.
4. Prompt-blocking on concurrent sessions (`continue:false`) interrupts the user once per conflict.
5. A Go binary must be on PATH for hooks — GUI git clients need `--absolute-git-hook-path`.
6. Heavy: 3,470-line `manual_commit_hooks.go`, a 148 KB CLAUDE.md for contributors; the state machine (IDLE/ACTIVE/ENDED × commit events × worktree/guest linking) is intricate.
7. Value is only realised with a commit; uncommitted exploration sits on a local shadow branch nobody else can see.

---

## 3. Implications for us

- **Don't rebuild**: git-repo-as-memory with markdown handoffs (Egregore does it, plus a whole skill set); per-commit transcript provenance (Entire does it well, multi-agent). Both are installable today; a team could run both side by side.
- **The gap both leave open** is *live* team awareness: who is active now, on what files/areas, and what my current edit collides with — plus routing that information to the right person without a manual handoff. Egregore's presence is a stale greeting field; Entire has none. Neither has claims.
- **Reuse their primitives instead of their products:**
  - `.egregore-session-id`-style file for session identity; Entire's process-ancestry trick if we need commit attribution.
  - Egregore's `observe.sh` event shape (`{ts,tool,path}`, 40 ms) is exactly the presence/claim signal — but ship it to a shared place (a per-user git ref like Entire's `refs/entire/...`, or a tiny server) instead of `/tmp`.
  - Entire's one-ref-per-object pattern for conflict-free shared state over git.
  - Egregore's WAL + drain for anything that talks to a network from a hook.
  - Entire's transcript-flush sentinel if we ever read transcripts in Stop.
  - Egregore's `## Repo State` table and `intent`/`ask`/`claim` frontmatter as the minimal handoff contract.
- **Context budget**: Entire proves ~100 words of injected context + an on-demand CLI is enough; Egregore shows the cost of 10–15k tokens of always-on greeting/CLAUDE.md. Aim for the former; inject only *deltas* that matter now (e.g. "bob touched `auth.ts` 4 min ago; you are editing it") via `PostToolUse`/`UserPromptSubmit` `additionalContext` or `systemMessage`, not a boot-time dump.
- **Hook budget**: keep every per-tool-call hook under ~50 ms (Egregore's measured floor for bash+jq+git) or use a compiled binary; never `git fetch` on the tool-call path except throttled + backgrounded (both do this); never block the prompt path >2 s.
- **SessionStart should not pull/checkout/commit.** Egregore's boot mutates the tree and needed a daemon to stay tolerable; Entire's SessionStart is read-only and instant.
