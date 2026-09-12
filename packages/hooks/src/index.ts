// Bundle entry for packages/plugin/dist/hook.mjs (DESIGN.md §2.3, §4.0).
//
// The hooks agent replaces the body of this file with `import './main.js';` once
// src/main.ts (dispatch + crash guards + watchdog) exists. Until then this
// placeholder obeys §4.0 rules 1-3 on every path: exit 0, no stdout, no stderr.
process.exitCode = 0;
