import { PROTOCOL_VERSION, RELAY_CONFIG_DEFAULTS, type HeatEntry, type Snapshot, type SnapshotChangeSet, type SnapshotSession } from '../src/protocol.js';

export const T0 = Date.parse('2026-09-12T09:41:07Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export function makeSnapshot(serverTime: number, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    v: PROTOCOL_VERSION,
    serverTime: iso(serverTime),
    repo: { slug: 'github.com/acme/app', project: 'acme-portal', config: { project: 'acme-portal', repo: 'github.com/acme/app', areas: {}, depends: {}, ...RELAY_CONFIG_DEFAULTS } },
    me: { dev: 'deepak', sessionId: 's1' },
    sessions: [],
    heat: [],
    claims: [],
    changeSets: [],
    inbox: [],
    minClient: 1,
    ...extra,
  };
}

export function makeChangeSet(id: string, deps: string[], extra: Partial<SnapshotChangeSet> = {}): SnapshotChangeSet {
  return {
    id,
    by: 'priya',
    branch: 'feat/currency',
    status: 'committed',
    priority: 'high',
    at: iso(T0),
    impacts: [
      { id: `imp_${id}`, rev: 1, path: 'packages/contracts/src/billing.ts', symbols: ['Invoice', 'createInvoice'], summary: 'billing.ts: Invoice: -total, +amountDue, +currency', hunk: '@@ -12,1 +12,2 @@ export interface Invoice {\n-  total: number\n+  amountDue: number\n+  currency: Currency', blobId: 'blob1', commitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', status: 'committed' },
    ],
    dependents: deps.map((path) => ({ path, area: 'dashboard', via: 'import' as const })),
    ...extra,
  };
}

export function makeSession(dev: string, extra: Partial<SnapshotSession> = {}): SnapshotSession {
  return {
    dev,
    id: `sess-${dev}`,
    client: 'cli',
    host: 'mac',
    branch: 'feat/currency',
    worktree: null,
    area: 'app',
    objective: 'Add currency support to invoices',
    state: 'working',
    lastSeenAt: iso(T0),
    lastEditAt: iso(T0),
    inTurnSince: null,
    ...extra,
  };
}

export function makeHeat(dev: string, path: string, extra: Partial<HeatEntry> = {}): HeatEntry {
  return {
    path,
    dev,
    sessionId: `sess-${dev}`,
    mine: false,
    branch: 'feat/currency',
    objective: 'Add currency support to invoices',
    kind: 'edit',
    at: iso(T0),
    pushed: false,
    headSha: 'headsha-' + dev,
    blobId: null,
    count: 6,
    ...extra,
  };
}
