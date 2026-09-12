---
name: iam
description: Tell Relay who I am on this machine (/relay:iam <handle>) when the git email is not in the team list; merges the placeholder identity into the real handle on the hub.
argument-hint: <handle>
---

The user wants Relay to record their developer handle for this machine.

Handle to set: `$ARGUMENTS`

1. If `$ARGUMENTS` is empty, ask for the handle (a short lowercase team handle such as
   `priya`) and stop.
2. Call `mcp__plugin_relay_relay__whoami` with `{"iam": "<handle>"}`. The tool writes
   `~/.relay/identity.json` (or `$RELAY_HOME/identity.json`) and asks the hub to merge the
   previous placeholder identity's sessions, heat and impacts into this handle.
3. Confirm with the identity the tool reports back (handle and source). If the tool
   returns an error, show it verbatim; the identity file is still written locally and takes
   effect at the next hook.
