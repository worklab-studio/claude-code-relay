import { describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { authorEmails, placeholderHandle, readIdentityFile, resolveIdentity, resolveIdentityFrom, writeIdentityFile } from './identity.js';
import type { TeamConfig } from './protocol.js';

const team: TeamConfig = {
  hub: 'h',
  team: 't',
  token: 'rt_x',
  members: {
    deepak: { name: 'Deepak', emails: ['Deepak@Example.com'], github: 'deepakpc' },
    priya: { name: 'Priya', emails: ['priya@acme.com'] },
  },
};
const base = { envDev: null, file: null, team, gitEmail: null, user: null, hostname: 'mac' };

describe('identity ladder', () => {
  it('follows the §3.3 order', () => {
    expect(resolveIdentityFrom({ ...base, envDev: 'arjun', gitEmail: 'priya@acme.com' })).toMatchObject({ dev: 'arjun', source: 'env' });
    expect(resolveIdentityFrom({ ...base, file: { dev: 'priya', source: 'identity-file', at: '2026-01-01T00:00:00Z' }, gitEmail: 'deepak@example.com' })).toMatchObject({ dev: 'priya', source: 'identity-file' });
    expect(resolveIdentityFrom({ ...base, gitEmail: 'deepak@example.com' })).toMatchObject({ dev: 'deepak', source: 'git-email', placeholder: false });
    expect(resolveIdentityFrom({ ...base, gitEmail: '123+deepakPC@users.noreply.github.com' })).toMatchObject({ dev: 'deepak', source: 'github-noreply' });
    expect(resolveIdentityFrom({ ...base, gitEmail: 'priya@personal.io' })).toMatchObject({ dev: 'priya', source: 'email-local' });
    expect(resolveIdentityFrom({ ...base, gitEmail: 'nobody@x.io', user: 'Deepak' })).toMatchObject({ dev: 'deepak', source: 'user' });
    const ph = resolveIdentityFrom({ ...base, gitEmail: 'nobody@x.io', user: 'someone' });
    expect(ph.source).toBe('placeholder');
    expect(ph.placeholder).toBe(true);
    expect(ph.dev).toBe(placeholderHandle('mac', 'someone'));
    expect(ph.dev).toMatch(/^unknown-[0-9a-f]{6}$/);
    expect(placeholderHandle('mac', 'a')).not.toBe(placeholderHandle('mac', 'b'));
  });

  it('honours a cached evaluation for 24 h while the git email is unchanged', () => {
    const now = Date.parse('2026-09-12T10:00:00Z');
    const fresh = { dev: 'priya', source: 'git-email' as const, at: '2026-09-12T09:00:00Z', gitEmail: 'x@y' };
    expect(resolveIdentityFrom({ ...base, team: null, file: fresh, gitEmail: 'x@y', now })).toMatchObject({ dev: 'priya', source: 'git-email' });
    // email changed -> re-evaluated -> placeholder (no team)
    expect(resolveIdentityFrom({ ...base, team: null, file: fresh, gitEmail: 'z@y', now }).source).toBe('placeholder');
    // too old -> re-evaluated
    expect(resolveIdentityFrom({ ...base, team: null, file: { ...fresh, at: '2026-09-10T09:00:00Z' }, gitEmail: 'x@y', now }).source).toBe('placeholder');
  });

  it('author emails combine team.json and the git email', () => {
    expect(authorEmails(team, 'deepak', 'Other@X.com')).toEqual(['deepak@example.com', 'other@x.com']);
    expect(authorEmails(null, 'x', null)).toEqual([]);
  });

  it('caches resolvable identities on disk but never placeholders', () => {
    const { file: _file, ...noFile } = base;
    const t = tmpHome();
    try {
      const r = resolveIdentity(t.home, { ...noFile, gitEmail: 'priya@acme.com' });
      expect(r.dev).toBe('priya');
      expect(readIdentityFile(t.home)).toMatchObject({ dev: 'priya', source: 'git-email', gitEmail: 'priya@acme.com' });
      const t2 = tmpHome();
      try {
        resolveIdentity(t2.home, { ...noFile, gitEmail: 'nobody@x' });
        expect(readIdentityFile(t2.home)).toBeNull();
        writeIdentityFile(t2.home, { dev: 'arjun', source: 'identity-file', at: '2026-01-01T00:00:00Z' });
        expect(resolveIdentity(t2.home, { ...noFile, gitEmail: 'priya@acme.com' }).dev).toBe('arjun');
      } finally {
        t2.cleanup();
      }
    } finally {
      t.cleanup();
    }
  });
});
