import { describe, expect, it } from 'vitest';
import { areaFromBranch, areaOfPath, areasOfPath, recencyWeight, voteArea } from './area.js';
import type { RelayArea } from './protocol.js';

const areas: Record<string, RelayArea> = {
  app: { paths: ['apps/app/**'], owners: ['priya'] },
  dashboard: { paths: ['apps/dashboard/**'], owners: ['deepak'] },
  api: { paths: ['packages/api/**'] },
  contracts: { paths: ['packages/contracts/**', 'prisma/**'], shared: true },
};
const now = Date.parse('2026-09-12T10:00:00Z');
const ago = (min: number): string => new Date(now - min * 60_000).toISOString();

describe('area', () => {
  it('maps paths to areas and infers when unconfigured', () => {
    expect(areasOfPath('apps/app/src/a.ts', areas)).toEqual(['app']);
    expect(areaOfPath('prisma/schema.prisma', areas)).toBe('contracts');
    expect(areaOfPath('README.md', areas)).toBeNull();
    expect(areasOfPath('apps/app/src/a.ts', {})).toEqual(['apps/app']);
  });

  it('weights recency: 3/(1+min/10)', () => {
    expect(recencyWeight(now, now)).toBe(3);
    expect(recencyWeight(now - 10 * 60_000, now)).toBeCloseTo(1.5);
  });

  it('votes by recency-weighted edits and never lets a shared area win alone', () => {
    const v = voteArea({
      now,
      areas,
      recentEdits: [
        { path: 'packages/contracts/src/billing.ts', at: ago(1) },
        { path: 'packages/contracts/src/orders.ts', at: ago(2) },
        { path: 'apps/app/src/service.ts', at: ago(30) },
      ],
    });
    expect(v.area).toBe('app');
    expect(v.display).toBe('app (+contracts)');
    expect(v.source).toBe('edits');
  });

  it('prefers the most recent area under equal counts', () => {
    const v = voteArea({ now, areas, recentEdits: [{ path: 'apps/dashboard/x.tsx', at: ago(1) }, { path: 'apps/app/y.ts', at: ago(60) }] });
    expect(v.area).toBe('dashboard');
  });

  it('falls back to branch token, owner, cwd and unknown', () => {
    expect(areaFromBranch('feat/dashboard-legend', Object.keys(areas))).toBe('dashboard');
    expect(voteArea({ now, areas, recentEdits: [], branch: 'feat/dashboard-legend' })).toMatchObject({ area: 'dashboard', source: 'branch' });
    expect(voteArea({ now, areas, recentEdits: [], branch: 'main', dev: 'priya' })).toMatchObject({ area: 'app', source: 'owner' });
    expect(voteArea({ now, areas, recentEdits: [], branch: 'main', dev: 'nobody', cwdRel: 'packages/api/src' })).toMatchObject({ area: 'api', source: 'cwd' });
    expect(voteArea({ now, areas: {}, recentEdits: [], cwdRel: 'apps/app' })).toMatchObject({ area: 'app', source: 'cwd' });
    expect(voteArea({ now, areas, recentEdits: [], branch: 'main', dev: 'nobody' })).toMatchObject({ area: 'unknown', source: 'unknown' });
  });

  it('shows a shared area alone only when nothing else applies', () => {
    const v = voteArea({ now, areas, recentEdits: [{ path: 'prisma/schema.prisma', at: ago(1) }], branch: 'main', dev: 'nobody' });
    expect(v.area).toBe('contracts');
    expect(v.display).toBe('contracts');
    const v2 = voteArea({ now, areas, recentEdits: [{ path: 'prisma/schema.prisma', at: ago(1) }], branch: 'feat/app-thing', dev: 'nobody' });
    expect(v2.display).toBe('app (+contracts)');
  });

  it('breaks exact ties by branch then owner', () => {
    const edits = [{ path: 'apps/app/a.ts', at: ago(5) }, { path: 'apps/dashboard/b.ts', at: ago(5) }];
    expect(voteArea({ now, areas, recentEdits: edits, branch: 'feat/dashboard-x' }).area).toBe('dashboard');
    expect(voteArea({ now, areas, recentEdits: edits, branch: 'main', dev: 'priya' }).area).toBe('app');
  });
});
