import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeCurrentFile, writeCurrentFile } from '@relay/core';
import { tmpHome } from '../test/harness.js';
import { resolveLiveSession } from './session.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const h = tmpHome('relay-mcp-session-');
  homes.push(h);
  return h;
}

/** A pid that is certainly not alive (max pid on macOS is 99998; Linux default 4194304). */
const DEAD_PID = 4_190_000;

function current(h: string, pid: number, sessionId: string, cwd: string, atMs: number): void {
  writeCurrentFile(h, makeCurrentFile({ home: h, pid, sessionId, cwd, repoKey: 'abc123abc123', dev: 'deepak', now: atMs }));
}

describe('resolveLiveSession (§9.1)', () => {
  it('prefers current/<ppid>.json over everything else', () => {
    const h = home();
    const cwd = join(h, 'repo');
    mkdirSync(cwd);
    current(h, 777, 'from-ppid', cwd, Date.now());
    current(h, process.pid, 'from-cwd', cwd, Date.now() + 1000);
    const r = resolveLiveSession({ home: h, ppid: 777, cwd, envSessionId: 'from-env' });
    expect(r).toMatchObject({ sessionId: 'from-ppid', source: 'current-file' });
    expect(r.current?.pid).toBe(777);
  });

  it('falls back to the newest live current/*.json whose cwd matches, skipping dead pids', () => {
    const h = home();
    const cwd = join(h, 'repo');
    mkdirSync(cwd);
    current(h, DEAD_PID, 'dead-newer', cwd, Date.now() + 5000);
    current(h, process.pid, 'alive-older', cwd, Date.now());
    const r = resolveLiveSession({ home: h, ppid: 1, cwd, envSessionId: 'from-env' });
    expect(r).toMatchObject({ sessionId: 'alive-older', source: 'cwd-match' });
  });

  it('matches a session whose cwd is a parent or child of the server cwd (after /cd)', () => {
    const h = home();
    const repo = join(h, 'repo');
    const sub = join(repo, 'apps', 'dashboard');
    mkdirSync(sub, { recursive: true });
    current(h, process.pid, 'in-sub', sub, Date.now());
    expect(resolveLiveSession({ home: h, ppid: 1, cwd: repo, envSessionId: null })).toMatchObject({ sessionId: 'in-sub', source: 'cwd-match' });
    rmSync(join(h, 'current'), { recursive: true, force: true });
    current(h, process.pid, 'in-root', repo, Date.now());
    expect(resolveLiveSession({ home: h, ppid: 1, cwd: sub, envSessionId: null })).toMatchObject({ sessionId: 'in-root', source: 'cwd-match' });
  });

  it('ignores sessions in unrelated directories and uses the env var, then none', () => {
    const h = home();
    const a = join(h, 'a');
    const b = join(h, 'b');
    mkdirSync(a);
    mkdirSync(b);
    current(h, process.pid, 'elsewhere', a, Date.now());
    expect(resolveLiveSession({ home: h, ppid: 1, cwd: b, envSessionId: 'from-env' })).toMatchObject({ sessionId: 'from-env', source: 'env', current: null });
    expect(resolveLiveSession({ home: h, ppid: 1, cwd: b, envSessionId: null })).toEqual({ sessionId: null, source: 'none', current: null });
  });

  it('survives a corrupt current file and a missing current directory', () => {
    const h = home();
    mkdirSync(join(h, 'current'), { recursive: true });
    writeFileSync(join(h, 'current', '55.json'), '{not json');
    expect(resolveLiveSession({ home: h, ppid: 55, cwd: h, envSessionId: null }).source).toBe('none');
    const empty = home();
    expect(resolveLiveSession({ home: empty, ppid: 55, cwd: empty, envSessionId: 'e' }).source).toBe('env');
  });
});
