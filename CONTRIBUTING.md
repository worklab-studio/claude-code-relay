# Contributing to Relay

Thanks for looking. The most useful contribution right now is **a report from an interactive
run**: the parts of Relay that only a real terminal or the desktop app can exercise (trust-dialog
install, the collision permission prompt, status line, `/reload-plugins`) are exactly the parts
nobody has verified yet — see [docs/VERIFICATION.md](docs/VERIFICATION.md). Run
`sh scripts/demo.sh up`, follow the printed script, and open an issue with what you saw,
including your Claude Code version (`claude --version`) and OS.

## Development setup

```bash
pnpm install
pnpm build            # writes the two committed bundles into packages/plugin/dist
pnpm -r typecheck
pnpm test             # unit tests for core, hooks, mcp, api (vitest projects)
pnpm test:hooks       # hook fixtures replayed through dist/hook.mjs against a throwaway PGlite hub
pnpm test:e2e         # the six demo moments end to end, hooks + MCP over stdio, no claude needed
```

Node ≥ 20 and pnpm 10 to build; the hook bundle itself must keep running on Node ≥ 18.
No test needs a network, an API key or a running server.

## Rules that CI enforces

- `packages/plugin/dist/*.mjs` are the one committed build artifact. Run `pnpm build` and commit
  the bundles with your change; CI fails if a fresh build differs.
- `dist/hook.mjs` must stay zero-dependency (only `node:*` imports).
- `packages/plugin/.claude-plugin/plugin.json` carries no `version` field (commit-SHA versioning).
- Every hook path exits 0. Never `spawnSync`; use `execFile`/`fetch` with an `AbortSignal` under
  the verb's deadline (DESIGN.md §4.0).

## Where things are

[DESIGN.md](DESIGN.md) is the spec and is kept in sync with the code — cite its section in
comments when a choice is non-obvious. [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) maps every file to
its responsibility. [docs/research](docs/research) holds the Claude Code hook/plugin/MCP
contracts as extracted from the docs and tested against the CLI; when the docs and the code
disagree, fix the code or the note, not the assumption.

## Pull requests

Small and focused. Say which DESIGN.md section the change implements or amends, include a test
for logic with edge cases, and note anything you verified on a real `claude` session.
