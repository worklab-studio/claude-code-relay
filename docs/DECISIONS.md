# Decisions each team makes before going to M1

None of these block the local demo. Each changes what you deploy or how developers join.
The defaults in parentheses are what the code does today.

1. **Handoff synthesis.** Put one Anthropic API key on the hub (Haiku, roughly cents per developer
   per day; *default when `ANTHROPIC_API_KEY` is set*) — or stay heuristic-only (*default without a
   key*: handoffs are built from the session's own edits, commits and derived objective, no LLM).
   A third option, per-developer `claude -p` synthesis on subscriptions, is not implemented.
2. **Identity and auth.** A shared team token in the private plugin repo plus git-email identity
   (*default*: zero per-developer steps; teammates could impersonate each other; rotation with a
   14-day dual-token grace) — or per-developer invite tokens with revocation (planned for M2).
3. **Repos you don't own.** For a client's repo, `init-project --local` writes
   `.claude/settings.local.json` and commits nothing (*default for `--local`*); for your own repos
   the committed `.claude/settings.json` + `.relay.json` contain no secrets or hub URL, but the
   area map and developer handles are visible to anyone with repo access.
4. **How two repos of one project share contracts.** A published or workspace package gives
   high-confidence dependency matching by package name; copied type files fall back to
   symbol-name matching and the `depends` map in `.relay.json`. Decide which you have before
   tuning `contracts` globs.
5. **Privacy defaults.** By default the derived objective, repo-relative paths, contract-file
   hunks (≤ 1,500 chars) and the code-stripped prose of Claude's replies (≤ 3,000 chars) go to
   your hub. For sensitive engagements set `privacy.send_turns: false` and/or
   `privacy.send_diffs: "none"` in that repo's `.relay.json` (weaker handoffs and just-in-time
   notes, same presence and collision behaviour).
6. **Hosting.** The hub is small; the question is cold starts. A Postgres that suspends when
   idle adds 0.5–1.5 s to the first request after a quiet stretch, which the client absorbs as
   one stale refresh; a plan without auto-suspend keeps every snapshot under ~300 ms.
