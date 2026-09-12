/**
 * dist/hook.mjs entry (§4.0 rules 1–4, 12): crash guards first, then the
 * watchdog at the verb's DEADLINE, then `main()` inside try/catch/finally →
 * `process.exit(0)`. Stdout is either nothing or one JSON object built with
 * JSON.stringify (≤ 9,000 chars); stderr carries nothing on controlled paths.
 */
import { DEADLINE_MS, appendStats, type HookInput, type HookOutput, type HookVerb } from '@relay/core';
import { runBg } from './bg.js';
import { capOutput, outcomeOf, parseHookInput, readStdin, writeStdout } from './io.js';
import { createRuntime, deadlineFor, type HookRuntime } from './runtime.js';
import { runCwd } from './verbs/cwd.js';
import { runMute } from './verbs/mute.js';
import { runPostEdit } from './verbs/post-edit.js';
import { runPostGit } from './verbs/post-git.js';
import { runPreEdit } from './verbs/pre-edit.js';
import { runPreRead } from './verbs/pre-read.js';
import { runPrompt } from './verbs/prompt.js';
import { runSessionEnd } from './verbs/session-end.js';
import { runSessionStart } from './verbs/session-start.js';
import { runStop } from './verbs/stop.js';
import { runTask } from './verbs/tasks.js';

// Rule 1: nothing may turn into a non-zero exit or a stack trace on stderr.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const HOOK_VERBS: ReadonlySet<string> = new Set<HookVerb>([
  'session-start',
  'prompt',
  'pre-edit',
  'pre-read',
  'post-edit',
  'post-git',
  'task-created',
  'task-completed',
  'cwd',
  'stop',
  'session-end',
]);

const verb = process.argv[2] ?? '';
const args = process.argv.slice(3);
let watchdog: NodeJS.Timeout | null = null;

function armWatchdog(ms: number): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => process.exit(0), ms); // not unref'd: it must fire even if something keeps the loop alive
}

armWatchdog(deadlineFor(verb));

async function dispatch(rt: HookRuntime, input: HookInput): Promise<HookOutput | null> {
  switch (rt.verb) {
    case 'session-start':
      if (input.hook_event_name !== 'SessionStart') return null;
      if (input.source === 'compact') {
        rt.setDeadline(DEADLINE_MS['session-start-compact']);
        armWatchdog(Math.max(50, DEADLINE_MS['session-start-compact'] - (rt.now() - rt.startedAt)));
      }
      return runSessionStart(rt, input);
    case 'prompt':
      return input.hook_event_name === 'UserPromptSubmit' ? runPrompt(rt, input) : null;
    case 'pre-edit':
      return input.hook_event_name === 'PreToolUse' ? runPreEdit(rt, input) : null;
    case 'pre-read':
      return input.hook_event_name === 'PreToolUse' ? runPreRead(rt, input) : null;
    case 'post-edit':
      return input.hook_event_name === 'PostToolUse' ? runPostEdit(rt, input) : null;
    case 'post-git':
      return input.hook_event_name === 'PostToolUse' ? runPostGit(rt, input) : null;
    case 'task-created':
    case 'task-completed':
      return input.hook_event_name === 'TaskCreated' || input.hook_event_name === 'TaskCompleted' ? runTask(rt, input) : null;
    case 'cwd':
      return input.hook_event_name === 'CwdChanged' ? runCwd(rt, input) : null;
    case 'stop':
      return input.hook_event_name === 'Stop' ? runStop(rt, input) : null;
    case 'session-end':
      return input.hook_event_name === 'SessionEnd' ? runSessionEnd(rt, input) : null;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  if (process.env['RELAY_DISABLE'] === '1') return; // rule 12: recursion guard
  if (verb === 'bg') {
    await runBg(createRuntime({ verb: 'bg', args }));
    return;
  }
  if (verb === 'mute') {
    const line = await runMute(createRuntime({ verb: 'mute', args }));
    if (line) writeStdout(line + '\n');
    return;
  }
  if (!HOOK_VERBS.has(verb)) return;
  const rt = createRuntime({ verb, args });
  const input = parseHookInput(await readStdin());
  if (!input) {
    rt.log('no usable stdin; exiting silently');
    return;
  }
  let out: HookOutput | null = null;
  let error: string | undefined;
  try {
    out = await dispatch(rt, input);
  } catch (err) {
    error = String((err as Error)?.stack ?? err).slice(0, 500);
    rt.log(`verb failed: ${error}`);
    out = null;
  }
  if (out) writeStdout(JSON.stringify(capOutput(out)));
  appendStats(rt.home, {
    at: new Date(rt.now()).toISOString(),
    event: input.hook_event_name,
    verb: verb as HookVerb,
    ms: rt.now() - rt.startedAt,
    out: error ? 'error' : outcomeOf(out),
    sessionId: input.session_id,
    ...(error ? { error: error.slice(0, 200) } : {}),
  });
}

void (async () => {
  try {
    await main();
  } catch {
    /* rule 2: never a non-zero exit from a controlled path */
  } finally {
    process.exit(0);
  }
})();
