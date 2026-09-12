import { describe, expect, it } from 'vitest';
import { T0, iso, makeChangeSet, makeHeat, makeSession, makeSnapshot } from '../test/fixtures.js';
import { assessCollision, degradeForStaleness, heatInMyBranch, isMuted, targetMatches, type CollisionInput } from './collision.js';
import { RELAY_CONFIG_DEFAULTS, STALENESS, type CachedSnapshot, type RelayArea } from './protocol.js';

const PATH = 'packages/contracts/src/billing.ts';
const areas: Record<string, RelayArea> = { contracts: { paths: ['packages/contracts/**'], shared: true }, app: { paths: ['apps/app/**'] } };
const policy = { ...RELAY_CONFIG_DEFAULTS.collision };

function snap(extra: Partial<CachedSnapshot> = {}, fetchedAt = T0): CachedSnapshot {
  return { ...makeSnapshot(T0, extra), fetchedAt: iso(fetchedAt) };
}

function input(overrides: Partial<CollisionInput> = {}): CollisionInput {
  return {
    path: PATH,
    me: { dev: 'deepak', sessionId: 'sess-deepak', branch: 'main', worktree: null },
    snapshot: snap({ sessions: [makeSession('priya')], heat: [makeHeat('priya', PATH)] }),
    policy,
    areas,
    interactive: true,
    now: T0 + 10_000,
    ...overrides,
  };
}

describe('severity matrix (§6.4)', () => {
  it('NONE without a snapshot or without heat on the path', () => {
    expect(assessCollision(input({ snapshot: null })).severity).toBe('NONE');
    expect(assessCollision(input({ path: 'apps/app/other.ts' })).severity).toBe('NONE');
  });

  it('HOT: another dev edited within 15 min and is live -> ask, with asked mark to create', () => {
    const v = assessCollision(input());
    expect(v.severity).toBe('HOT');
    expect(v.decision).toBe('ask');
    expect(v.createAsked).toBe(true);
    expect(v.other).toMatchObject({ dev: 'priya', branch: 'feat/currency', editCount: 6, objective: 'Add currency support to invoices', state: 'working' });
    expect(v.tier).toBe('fresh');
    expect(v.label).toBeNull();
  });

  it('HOT needs recent heat and a session seen within 30 min', () => {
    const oldHeat = input({ snapshot: snap({ sessions: [makeSession('priya')], heat: [makeHeat('priya', PATH, { at: iso(T0 - STALENESS.heatHotMs - 1000) })] }) });
    expect(assessCollision(oldHeat).severity).toBe('WARM');
    const goneSession = input({ snapshot: snap({ sessions: [makeSession('priya', { lastSeenAt: iso(T0 - STALENESS.implicitClaimSeenMs - 1000) })], heat: [makeHeat('priya', PATH)] }) });
    expect(assessCollision(goneSession).severity).toBe('WARM');
    const noSession = input({ snapshot: snap({ sessions: [], heat: [makeHeat('priya', PATH)] }) });
    expect(assessCollision(noSession).severity).toBe('WARM');
  });

  it('WARM: their change not in my branch -> context, once per (path, dev)', () => {
    const v = assessCollision(input({ snapshot: snap({ sessions: [], heat: [makeHeat('priya', PATH, { kind: 'commit', at: iso(T0 - 3_600_000) })] }) }));
    expect(v.severity).toBe('WARM');
    expect(v.decision).toBe('context');
    expect(v.createNoted).toBe(true);
    const noted = assessCollision(input({ snapshot: v.other ? snap({ sessions: [], heat: [makeHeat('priya', PATH, { kind: 'commit', at: iso(T0 - 3_600_000) })] }) : null, marks: () => ({ noted: true }) }));
    expect(noted.severity).toBe('WARM');
    expect(noted.decision).toBe('none');
    expect(noted.downgrades).toContain('noted');
  });

  it('SEQUENTIAL: their change is already in my branch by SHA or blob', () => {
    const heat = makeHeat('priya', PATH, { kind: 'commit', at: iso(T0 - 3_600_000), headSha: 'abc' });
    const v = assessCollision(input({ snapshot: snap({ sessions: [], heat: [heat] }), ancestry: { headSha: 'mine', at: iso(T0), contains: { abc: true }, merged: {} } }));
    expect(v.severity).toBe('SEQUENTIAL');
    expect(v.decision).toBe('note');
    expect(heatInMyBranch(heat, { headSha: 'x', at: iso(T0), contains: { abc: false }, merged: {} })).toBe(false);
    expect(heatInMyBranch(heat, null)).toBeNull();
    expect(heatInMyBranch({ ...heat, blobId: 'b1' }, null, 'b1')).toBe(true);
    const unknown = assessCollision(input({ snapshot: snap({ sessions: [], heat: [heat] }), ancestry: { headSha: 'mine', at: iso(T0), contains: {}, merged: {} } }));
    expect(unknown.severity).toBe('WARM'); // unknown -> warm (harmless)
  });

  it('WARM heat older than 24 h is ignored', () => {
    const v = assessCollision(input({ snapshot: snap({ sessions: [], heat: [makeHeat('priya', PATH, { kind: 'dirty', at: iso(T0 - STALENESS.warmMs - 1000) })] }) }));
    expect(v.severity).toBe('NONE');
  });

  it('SAME_DEV: my other session edited within 10 min -> note; my own session never collides with itself', () => {
    const mine = makeHeat('deepak', PATH, { mine: true, sessionId: 'sess-deepak-2', at: iso(T0 - 60_000) });
    const v = assessCollision(input({ snapshot: snap({ sessions: [], heat: [mine] }) }));
    expect(v.severity).toBe('SAME_DEV');
    expect(v.decision).toBe('note');
    expect(v.createNoted).toBe(true);
    const self = assessCollision(input({ snapshot: snap({ sessions: [], heat: [{ ...mine, sessionId: 'sess-deepak' }] }) }));
    expect(self.severity).toBe('NONE');
    const old = assessCollision(input({ snapshot: snap({ sessions: [], heat: [{ ...mine, at: iso(T0 - STALENESS.sameDevMs - 1000) }] }) }));
    expect(old.severity).toBe('NONE');
  });

  it('CLAIMED: explicit unexpired claim -> ask, hard -> deny; expired claims are ignored; area targets work', () => {
    const claim = { id: 'clm_1', dev: 'priya', target: PATH, note: 'migrating billing', hard: false, expiresAt: iso(T0 + 3_600_000) };
    const v = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [claim] }) }));
    expect(v.severity).toBe('CLAIMED');
    expect(v.decision).toBe('ask');
    expect(v.claim?.id).toBe('clm_1');
    const hard = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [{ ...claim, hard: true }] }) }));
    expect(hard.decision).toBe('deny');
    const expired = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [{ ...claim, expiresAt: iso(T0 + 5_000) }] }), now: T0 + 10_000 }));
    expect(expired.severity).toBe('NONE');
    const area = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [{ ...claim, target: 'contracts' }] }) }));
    expect(area.severity).toBe('CLAIMED');
    const glob = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [{ ...claim, target: 'packages/contracts/**' }] }) }));
    expect(glob.severity).toBe('CLAIMED');
    const own = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [{ ...claim, dev: 'deepak' }] }) }));
    expect(own.severity).toBe('NONE');
    expect(targetMatches('@priya', PATH, areas)).toBe(false);
  });

  it('CLAIMED takes precedence over HOT and carries the impact id', () => {
    const claim = { id: 'clm_1', dev: 'priya', target: 'contracts', note: null, hard: false, expiresAt: iso(T0 + 3_600_000) };
    const v = assessCollision(input({ snapshot: snap({ sessions: [makeSession('priya')], heat: [makeHeat('priya', PATH)], claims: [claim], changeSets: [makeChangeSet('cs_1', ['apps/dashboard/x.tsx'])] }) }));
    expect(v.severity).toBe('CLAIMED');
    expect(v.other?.impactId).toBe('imp_cs_1');
    expect(v.other?.editCount).toBe(6);
  });
});

describe('staleness ladder (§6.5) and interactivity (§4.0 rule 14)', () => {
  it('degrades deny->ask->context by tier', () => {
    expect(degradeForStaleness('deny', 'fresh')).toBe('deny');
    expect(degradeForStaleness('deny', 'degraded')).toBe('ask');
    expect(degradeForStaleness('ask', 'degraded')).toBe('context');
    expect(degradeForStaleness('deny', 'stale')).toBe('context');
    expect(degradeForStaleness('ask', 'offline')).toBe('context');
    expect(degradeForStaleness('note', 'stale')).toBe('note');
  });

  it('HOT on a 6-minute-old snapshot is context with a label; a hard claim on a 20-minute-old snapshot is context', () => {
    const v = assessCollision(input({ snapshot: snap({ sessions: [makeSession('priya')], heat: [makeHeat('priya', PATH)] }, T0), now: T0 + 6 * 60_000 }));
    expect(v.severity).toBe('HOT');
    expect(v.tier).toBe('degraded');
    expect(v.decision).toBe('context');
    expect(v.label).toBe('(presence as of 09:41Z)');
    expect(v.downgrades).toContain('staleness:degraded');
    const claim = { id: 'clm_1', dev: 'priya', target: PATH, note: null, hard: true, expiresAt: iso(T0 + 3_600_000) };
    const d = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [claim] }, T0), now: T0 + 20 * 60_000 }));
    expect(d.decision).toBe('context');
    expect(d.label).toBe('(presence as of 09:41Z; not refreshed)');
    const d2 = assessCollision(input({ snapshot: snap({ sessions: [], heat: [], claims: [claim] }, T0), now: T0 + 6 * 60_000 }));
    expect(d2.decision).toBe('ask');
  });

  it('breaker open -> context only with the unreachable label', () => {
    const v = assessCollision(input({ breaker: { open: true, sinceMs: T0 + 5_000 } }));
    expect(v.tier).toBe('offline');
    expect(v.decision).toBe('context');
    expect(v.label).toBe('(Relay hub unreachable since 09:41Z)');
  });

  it('a laptop clock skew cannot manufacture or suppress HOT (rule 16)', () => {
    // laptop 10 minutes ahead of the hub at fetch time: the heat is still 10 s old by hub clock
    const skewed = snap({ sessions: [makeSession('priya')], heat: [makeHeat('priya', PATH)] }, T0 + 600_000);
    const v = assessCollision(input({ snapshot: skewed, now: T0 + 600_000 + 10_000 }));
    expect(v.severity).toBe('HOT');
    expect(v.decision).toBe('ask');
  });

  it('non-interactive sessions get context instead of ask; deny is unaffected', () => {
    const v = assessCollision(input({ interactive: false }));
    expect(v.decision).toBe('context');
    expect(v.downgrades).toContain('non-interactive');
    expect(v.createAsked).toBe(false);
    const claim = { id: 'clm_1', dev: 'priya', target: PATH, note: null, hard: true, expiresAt: iso(T0 + 3_600_000) };
    expect(assessCollision(input({ interactive: false, snapshot: snap({ sessions: [], heat: [], claims: [claim] }) })).decision).toBe('deny');
  });

  it('policy values: deny / context / note / off', () => {
    expect(assessCollision(input({ policy: { ...policy, hot: 'deny' } })).decision).toBe('deny');
    expect(assessCollision(input({ policy: { ...policy, hot: 'context' } })).decision).toBe('context');
    expect(assessCollision(input({ policy: { ...policy, hot: 'off' } })).decision).toBe('none');
    const warm = input({ policy: { ...policy, warm: 'off' }, snapshot: snap({ sessions: [], heat: [makeHeat('priya', PATH, { kind: 'commit', at: iso(T0 - 3_600_000) })] }) });
    expect(assessCollision(warm).decision).toBe('none');
  });
});

describe('fatigue, escalation and mutes', () => {
  it('one ask per (path, dev) per 30 min: fresh asked mark or snooze -> context', () => {
    const asked = assessCollision(input({ marks: () => ({ askedAgeMs: 30_000 }) }));
    expect(asked.decision).toBe('context');
    expect(asked.downgrades).toContain('asked-recently');
    expect(asked.createAsked).toBe(false);
    const expiredAsk = assessCollision(input({ marks: () => ({ askedAgeMs: STALENESS.askedExpiryMs + 1 }) }));
    expect(expiredAsk.decision).toBe('ask');
    expect(expiredAsk.createAsked).toBe(true);
    const snoozed = assessCollision(input({ marks: () => ({ snoozeUntilMs: T0 + 10_000 + 60_000 }) }));
    expect(snoozed.decision).toBe('context');
    expect(snoozed.downgrades).toContain('snoozed');
    const snoozeOver = assessCollision(input({ marks: () => ({ snoozeUntilMs: T0 + 10_000 - 1 }) }));
    expect(snoozeOver.decision).toBe('ask');
  });

  it('same-branch different-worktree HOT escalates context -> ask (§6.6)', () => {
    const v = assessCollision(input({ policy: { ...policy, hot: 'context' }, me: { dev: 'deepak', sessionId: 's', branch: 'feat/currency', worktree: 'wt-b' }, snapshot: snap({ sessions: [makeSession('priya', { worktree: 'wt-a' })], heat: [makeHeat('priya', PATH)] }) }));
    expect(v.decision).toBe('ask');
    expect(v.escalated).toBe(true);
    const other = assessCollision(input({ policy: { ...policy, hot: 'context' }, me: { dev: 'deepak', sessionId: 's', branch: 'main', worktree: null } }));
    expect(other.escalated).toBe(false);
    expect(other.decision).toBe('context');
  });

  it('mutes silence path, glob, area and @dev targets', () => {
    const at = iso(T0);
    expect(isMuted([{ target: PATH, kind: 'path', at }], PATH, 'priya', areas)).toBe(true);
    expect(isMuted([{ target: 'packages/contracts/**', kind: 'glob', at }], PATH, 'priya', areas)).toBe(true);
    expect(isMuted([{ target: 'contracts', kind: 'area', at }], PATH, 'priya', areas)).toBe(true);
    expect(isMuted([{ target: '@priya', kind: 'dev', at }], PATH, 'priya', areas)).toBe(true);
    expect(isMuted([{ target: '@arjun', kind: 'dev', at }], PATH, 'priya', areas)).toBe(false);
    expect(isMuted([], PATH, 'priya', areas)).toBe(false);
    const v = assessCollision(input({ mutes: [{ target: '@priya', kind: 'dev', at }] }));
    expect(v.severity).toBe('NONE');
    expect(v.downgrades).toContain('muted');
  });
});
