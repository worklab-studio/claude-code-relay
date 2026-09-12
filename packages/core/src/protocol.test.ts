import { describe, expect, it } from 'vitest';
import {
  CLIENT_EVENT_TYPES,
  DEADLINE_MS,
  PROTOCOL_VERSION,
  RELAY_CONFIG_DEFAULTS,
  editToolPath,
  isCachedSnapshot,
  isHookInput,
  isJournalEntry,
  isOutboxEntry,
  isRelayConfig,
  isRelayEvent,
  isSessionMeta,
  isSnapshot,
  isTeamConfig,
  type Snapshot,
} from './protocol.js';

const snapshot: Snapshot = {
  v: PROTOCOL_VERSION,
  serverTime: '2026-09-12T09:41:07.000Z',
  repo: {
    slug: 'github.com/acme/app',
    project: 'acme-portal',
    config: {
      project: 'acme-portal',
      repo: 'github.com/acme/app',
      areas: {},
      depends: {},
      ...RELAY_CONFIG_DEFAULTS,
    },
  },
  me: { dev: 'deepak', sessionId: 's1' },
  sessions: [],
  heat: [],
  claims: [],
  changeSets: [],
  inbox: [],
  minClient: 1,
};

describe('protocol guards', () => {
  it('accepts a well-formed snapshot and rejects a truncated one', () => {
    expect(isSnapshot(snapshot)).toBe(true);
    expect(isCachedSnapshot(snapshot)).toBe(false);
    expect(isCachedSnapshot({ ...snapshot, fetchedAt: '2026-09-12T09:41:08.000Z' })).toBe(true);
    expect(isSnapshot({ ...snapshot, v: 2 })).toBe(false);
    expect(isSnapshot({ ...snapshot, heat: undefined })).toBe(false);
    expect(isSnapshot('{}')).toBe(false);
    expect(isSnapshot(null)).toBe(false);
  });

  it('recognises client events by discriminant only', () => {
    for (const type of CLIENT_EVENT_TYPES) {
      expect(isRelayEvent({ id: '01J', at: '2026-09-12T00:00:00Z', type })).toBe(true);
    }
    expect(isRelayEvent({ id: '01J', at: '2026-09-12T00:00:00Z', type: 'session_start' })).toBe(false);
    expect(isRelayEvent({ at: '2026-09-12T00:00:00Z', type: 'edit' })).toBe(false);
  });

  it('checks journal, outbox and meta shapes', () => {
    expect(isJournalEntry({ t: 'edit', at: 'x', path: 'a.ts', tool: 'Edit', toolUseId: null })).toBe(true);
    expect(isJournalEntry({ t: 'nope', at: 'x' })).toBe(false);
    expect(
      isOutboxEntry({
        v: 1,
        id: '01J',
        sessionId: 's1',
        at: 'x',
        kind: 'events',
        endpoint: '/v1/events',
        ephemeral: true,
        body: {},
      }),
    ).toBe(true);
    expect(isOutboxEntry({ v: 1, id: '01J' })).toBe(false);
    expect(
      isSessionMeta({
        v: 1,
        sessionId: 's1',
        dev: 'deepak',
        repo: 'github.com/acme/app',
        repoKey: 'abc',
        repoRoot: '/tmp/x',
        branch: 'main',
        startedAt: 'x',
      }),
    ).toBe(true);
    expect(isSessionMeta({ v: 1 })).toBe(false);
  });

  it('validates .relay.json and team.json shallowly', () => {
    expect(isRelayConfig({})).toBe(true);
    expect(isRelayConfig({ areas: { app: { paths: ['apps/app/**'] } } })).toBe(true);
    expect(isRelayConfig({ areas: { app: { paths: 'apps/app/**' } } })).toBe(false);
    expect(isRelayConfig({ project: 3 })).toBe(false);
    expect(isTeamConfig({ hub: 'h', team: 't', token: 'rt_x', members: {} })).toBe(true);
    expect(isTeamConfig({ hub: 'h' })).toBe(false);
  });

  it('reads hook stdin defensively', () => {
    expect(isHookInput({ session_id: 's', hook_event_name: 'Stop', cwd: '/x' })).toBe(true);
    expect(isHookInput({ session_id: 's' })).toBe(false);
    expect(editToolPath({ file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(editToolPath({ notebook_path: '/a/b.ipynb' })).toBe('/a/b.ipynb');
    expect(editToolPath({ file_path: '' })).toBe(null);
    expect(editToolPath(undefined)).toBe(null);
  });

  it('keeps every deadline below its declared hook timeout (§4.0 rule 1)', () => {
    const timeouts: Record<string, number> = {
      'session-start': 8000,
      prompt: 5000,
      'pre-edit': 3000,
      'pre-read': 2000,
      'task-created': 2000,
      'task-completed': 2000,
      cwd: 3000,
      'session-end': 1500,
    };
    for (const [verb, timeout] of Object.entries(timeouts)) {
      expect(DEADLINE_MS[verb as keyof typeof DEADLINE_MS]).toBeLessThan(timeout);
    }
  });
});
