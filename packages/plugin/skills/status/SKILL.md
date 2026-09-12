---
name: status
description: Show who on the team is live right now, on which branch and objective, plus my unacked contract changes and unread notes. Calls the Relay status tool.
---

Call the Relay MCP tool `mcp__plugin_relay_relay__status` with `{"project": "current"}`
(use `"all"` if the user asks about every project).

Then answer in this shape, using only what the tool returned:

- One line per teammate: handle, state (working / in a long turn / idle / away), branch,
  worktree if any, area, objective, last seen (absolute UTC time from the response).
- Explicit claims, if any, with who holds them and until when.
- My counters: unacked change sets and unread inbox items.
- The freshness line: whether the numbers came from the hub or from the local cache and
  how old the cache is.

If the tool reports the hub as unreachable and shows cached data, say so in one sentence
and keep the cached facts. Do not speculate beyond the response.
