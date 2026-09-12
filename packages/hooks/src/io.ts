/**
 * Stdin/stdout helpers for main.ts (§4.0 rules 3–4), kept side-effect free so
 * tests can import them without arming the watchdog.
 */
import { writeSync } from 'node:fs';
import { LIMITS, isHookInput, type HookInput, type HookOutcome, type HookOutput } from '@relay/core';

const EMPTY_STDIN_WAIT_MS = 1500;

/** Read all of stdin (Claude Code pipes one JSON object and closes). Never throws. */
export function readStdin(stream: NodeJS.ReadStream = process.stdin, idleMs: number = EMPTY_STDIN_WAIT_MS): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const chunks: Buffer[] = [];
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    try {
      if (stream.isTTY) {
        finish();
        return;
      }
      let size = 0;
      // A hook launched without a pipe (manual run) must not hang until the watchdog.
      const idle = setTimeout(finish, idleMs);
      idle.unref();
      stream.on('data', (c: Buffer) => {
        if (size > 4 * 1024 * 1024) return;
        chunks.push(c);
        size += c.length;
      });
      stream.on('end', () => {
        clearTimeout(idle);
        finish();
      });
      stream.on('error', () => {
        clearTimeout(idle);
        finish();
      });
      stream.resume();
    } catch {
      finish();
    }
  });
}

/** Parse stdin defensively; anything but a hook object is treated as "no input". */
export function parseHookInput(text: string): HookInput | null {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isHookInput(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keep the single stdout object under 9,000 chars by trimming context fields (§4.0 rule 3). */
export function capOutput(out: HookOutput, max: number = LIMITS.hookStdoutChars): HookOutput {
  const size = (o: HookOutput): number => JSON.stringify(o).length;
  if (size(out) <= max) return out;
  const copy: HookOutput = JSON.parse(JSON.stringify(out)) as HookOutput;
  const hso = copy.hookSpecificOutput as (Record<string, unknown> & { hookEventName: string }) | undefined;
  for (const key of ['additionalContext', 'systemMessage', 'permissionDecisionReason']) {
    const holder: Record<string, unknown> | undefined = key === 'systemMessage' ? (copy as unknown as Record<string, unknown>) : hso;
    const value = holder?.[key];
    if (!holder || typeof value !== 'string') continue;
    const over = size(copy) - max;
    if (over <= 0) break;
    holder[key] = value.slice(0, Math.max(0, value.length - over - 16)) + '…';
  }
  return copy;
}

/** Write stdout synchronously so `process.exit` cannot truncate it. */
export function writeStdout(text: string): void {
  try {
    writeSync(1, text);
  } catch {
    try {
      process.stdout.write(text);
    } catch {
      /* nothing else to do */
    }
  }
}

/** Stats outcome of a hook's stdout (§4.3 step 6). */
export function outcomeOf(out: HookOutput | null): HookOutcome {
  if (!out) return 'none';
  const h = out.hookSpecificOutput as Record<string, unknown> | undefined;
  if (h?.['permissionDecision'] === 'deny') return 'deny';
  if (h?.['permissionDecision'] === 'ask') return 'ask';
  if (h?.['hookEventName'] === 'SessionStart') return 'digest';
  return 'context';
}
