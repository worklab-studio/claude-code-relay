# Hook smoke fixtures

One file per verb: `{ verb, env, stdin, expect }` (docs/BUILD-PLAN.md). `stdin` is a
realistic Claude Code 2.1.236 payload per docs/research/hooks.md; `expect.stdout` is
`"json"` (one JSON object with `hookSpecificOutput.hookEventName`) or `"none"`;
`expect.maxMs` is the verb's DEADLINE (§4.10). Placeholders substituted by the runner in
every string: `{{REPO}}` (a throwaway git repo shaped like examples/demo-repo),
`{{HOME}}` ($RELAY_HOME), `{{SESSION}}` (the session id), `{{HUB}}` (the hub URL).

Runners:

- `scripts/smoke/run.mjs` (`pnpm test:hooks`): starts a throwaway hub on PGlite
  (`apps/api/scripts/dev.ts`, first free port from 8787, `RELAY_HUB=<url>` reuses one),
  builds an origin + two clones (priya, deepak) with the fixture's file shape and a
  `.relay.json` (dashboard owned by deepak, `depends` dashboard → contracts), then
  replays the fixtures for deepak in the documented order. The scenario makes every
  `expect` true against the real hub: priya is live, edits + commits `billing.ts` and
  leaves deepak a note *after* deepak's session-start, so his prompt (with
  `RELAY_SNAPSHOT_TTL_MS=1`) delivers the inbox once and his pre-edit on `billing.ts`
  asks. `pre-edit-write` prints the just-in-time note only when the prompt did not
  already deliver the change set (it is high priority here, so it prints nothing —
  the runner checks whichever branch applies). The runner also measures p95 wall time
  for pre-edit (< 120 ms) and prompt (< 150 ms) without a refresh, runs 8 parallel
  pre-edit and 8 parallel post-edit processes on one session (exactly one `ask`, one
  delivery of a mid-turn note, one contract record), and replays a `git pull` of 50
  foreign commits (zero commit events). `KEEP=1` keeps the temp dir;
  `RELAY_SMOKE_TIMING=warn` turns the p95 gates into warnings on slow CI boxes.
- `packages/hooks/test/integration.test.ts` (part of `pnpm test`): the same fixtures
  against a stub hub, plus the hub-unreachable / hub-stalling fail-open cases.
- `scripts/e2e.mjs` (`pnpm test:e2e`): the six §12 M0 moments with priya and arjun on
  examples/demo-repo, including the MCP bundle over stdio (see scripts/e2e.sh).

Every run uses `RELAY_NO_BG=1` so no detached worker is forked; the runners invoke the
`bg` jobs explicitly (`hook.mjs bg <job> --session <sid> --cwd <dir> [--entry <ulid>]`)
right after the verb that would have spawned them, which keeps the replay deterministic.
`CLAUDE_PID` is the runner's own pid (alive, so the liveness sweep leaves the sessions
alone) and `CLAUDE_CODE_ENTRYPOINT=cli` keeps the collision `ask` interactive (B.5).
