---
name: handoff
description: Write a structured handoff for this session (done, changed files, interfaces changed, decisions, blockers, next steps, notes to teammates) and store it on the Relay hub for teammates' next session start.
---

Produce a handoff for the current session and store it with the Relay tool
`mcp__plugin_relay_relay__handoff`.

1. Summarize this session from the conversation so far. Be concrete and short:
   - `done`: what was completed (past tense, one line each)
   - `changed`: repo-relative paths that were edited or created
   - `interfaces_changed`: exported types, endpoints, schemas or props that changed, with
     the old and new shape when known
   - `decisions`: choices made and why (one line each)
   - `blockers`: what is unresolved or waiting on someone
   - `next`: the concrete next steps, in order
   - `notes_to`: `[{"dev": "<handle>", "text": "..."}]` for anything a specific teammate
     must know (leave empty when nothing applies)
2. Call `mcp__plugin_relay_relay__handoff` with `{"summary": {...}}` containing those
   fields. A summary provided this way is stored with quality `self` and is never
   overwritten by the automatic heuristic or LLM handoff.
3. Show the returned handoff id and the rendered markdown to the user.

If the user only says "handoff" with no extra instructions, do all three steps without
asking questions. If the hub is unreachable, report the tool's error verbatim; the
automatic handoff still runs at session end from the local journal.
