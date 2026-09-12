import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { defaultProject, inferAreaFromPath, isPathUnder, localSlug, normalizeOriginUrl, repoKey, toRepoRelative, worktreeName } from './repo.js';

describe('normalizeOriginUrl', () => {
  it('maps ssh, https, scp-like and .git variants to one slug', () => {
    const want = 'github.com/acme/app';
    for (const u of [
      'git@github.com:acme/app.git',
      'git@github.com:acme/app',
      'ssh://git@github.com/acme/app.git',
      'https://github.com/acme/app',
      'https://github.com/acme/app.git/',
      'https://user:token@github.com/acme/app.git',
      'git://github.com/acme/app.git',
      'https://GitHub.com/Acme/App.git',
      'ssh://git@github.com:22/acme/app.git',
    ]) {
      expect(normalizeOriginUrl(u), u).toBe(want);
    }
  });

  it('maps file and path origins to local slugs', () => {
    expect(normalizeOriginUrl('file:///tmp/relay-demo/origin.git')).toBe('local/origin');
    expect(normalizeOriginUrl('/tmp/relay-demo/origin.git')).toBe('local/origin');
    expect(normalizeOriginUrl('../origin')).toBe('local/origin');
    expect(normalizeOriginUrl('')).toBeNull();
    expect(normalizeOriginUrl(null)).toBeNull();
  });

  it('derives keys and projects', () => {
    expect(localSlug('/Users/x/code/My-App')).toBe('local/my-app');
    expect(repoKey('github.com/acme/app')).toMatch(/^[0-9a-f]{12}$/);
    expect(defaultProject('github.com/acme/app')).toBe('acme/app');
    expect(defaultProject('local/app')).toBe('local/app');
  });
});

describe('toRepoRelative', () => {
  const dirs: Array<() => void> = [];
  afterEach(() => dirs.splice(0).forEach((c) => c()));

  it('normalizes absolute and relative inputs and rejects paths outside the repo', () => {
    const root = '/repo/root';
    expect(toRepoRelative('/repo/root/apps/app/src/a.ts', root)).toBe('apps/app/src/a.ts');
    expect(toRepoRelative('src/a.ts', root, '/repo/root/apps/app')).toBe('apps/app/src/a.ts');
    expect(toRepoRelative('/repo/root', root)).toBeNull();
    expect(toRepoRelative('/repo/rootx/a.ts', root)).toBeNull();
    expect(toRepoRelative('/other/a.ts', root)).toBeNull();
    expect(toRepoRelative('../../../etc/passwd', root, '/repo/root/apps/app')).toBeNull();
    expect(toRepoRelative('../../lib/x.ts', root, '/repo/root/apps/app')).toBe('lib/x.ts');
  });

  it('reconciles symlinked roots', () => {
    const t = tmpHome();
    dirs.push(t.cleanup);
    const real = join(t.home, 'real');
    mkdirSync(join(real, 'src'), { recursive: true });
    const link = join(t.home, 'link');
    symlinkSync(real, link);
    expect(toRepoRelative(join(link, 'src', 'new-file.ts'), real)).toBe('src/new-file.ts');
    expect(toRepoRelative(join(real, 'src', 'a.ts'), link)).toBe('src/a.ts');
  });

  it('helpers', () => {
    expect(isPathUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isPathUnder('/a/bc', '/a/b')).toBe(false);
    expect(worktreeName('/repo/wt1', '/repo/.git/worktrees/wt1', '/repo/.git')).toBe('wt1');
    expect(worktreeName('/repo', '.git', '.git')).toBeNull();
    expect(worktreeName('/repo', '/repo/.git', '../../.git', '/repo/apps/app')).toBeNull();
    expect(worktreeName('/repo/wt1', '/repo/.git/worktrees/wt1', '../.git', '/repo/wt1/src')).toBe('wt1');
    expect(inferAreaFromPath('apps/app/src/a.ts')).toBe('apps/app');
    expect(inferAreaFromPath('README.md')).toBe('root');
    expect(inferAreaFromPath('src/a.ts')).toBe('src');
  });
});
