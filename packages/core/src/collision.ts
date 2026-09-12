/**
 * Collision severity (§6.3, §6.4), the staleness ladder (§6.5), interactivity
 * downgrades (§4.0 rule 14), same-branch worktree escalation (§6.6), mutes and
 * the marker-based fatigue rules. `assessCollision` is a pure function over the
 * inputs the pre-edit hook reads; the hook creates the marks it is told to.
 */
import { matchGlob } from './glob.js';
import { hubNowMs, itemAgeMs, snapshotAgeMs, stalenessLabel, stalenessTier } from './cache.js';
import {
  STALENESS,
  type AncestryFile,
  type CachedSnapshot,
  type CollisionDecision,
  type CollisionParty,
  type CollisionPolicy,
  type CollisionSeverity,
  type CollisionVerdict,
  type HeatEntry,
  type MuteTarget,
  type RelayArea,
  type RelayCollisionConfig,
  type SnapshotClaim,
  type SnapshotSession,
  type StalenessTier,
} from './protocol.js';
import { areasOfPath } from './area.js';
import { parseIso } from './util.js';

export interface CollisionMarks {
  /** age of `marks/asked.<key>` for (path, other dev), null when absent */
  askedAgeMs?: number | null;
  /** epoch ms of an unexpired `marks/snooze.<key>`, null when none */
  snoozeUntilMs?: number | null;
  /** `marks/noted.<key>` exists */
  noted?: boolean;
}

export interface CollisionInput {
  path: string;
  me: { dev: string; sessionId: string; branch: string | null; worktree: string | null };
  snapshot: CachedSnapshot | null;
  ancestry?: AncestryFile | null;
  policy: Required<RelayCollisionConfig>;
  areas?: Record<string, RelayArea>;
  /** breaker state from readBreaker */
  breaker?: { open: boolean; sinceMs: number | null };
  /** false in subagents, dontAsk/bypassPermissions, RELAY_INTERACTIVE=0 (§4.0 rule 14) */
  interactive?: boolean;
  /** lookup of marks per other dev (called with the other party's handle) */
  marks?: (otherDev: string) => CollisionMarks;
  mutes?: readonly MuteTarget[];
  now?: number;
}

export interface CollisionAssessment extends CollisionVerdict {
  /** the hook should create `asked.<key>` before printing (§4.3 step 5) */
  createAsked: boolean;
  /** the hook should create `noted.<key>` before printing */
  createNoted: boolean;
  /** why a stronger decision was downgraded */
  downgrades: string[];
  /** heat entry behind HOT/WARM/SEQUENTIAL/SAME_DEV */
  heat: HeatEntry | null;
  /** number of the other party's edits on this path in the snapshot */
  editCount: number;
  /** the other party's live session, when present in the snapshot */
  session: SnapshotSession | null;
}

const NONE = (path: string, tier: StalenessTier, label: string | null): CollisionAssessment => ({
  path,
  severity: 'NONE',
  decision: 'none',
  tier,
  label,
  other: null,
  claim: null,
  escalated: false,
  createAsked: false,
  createNoted: false,
  downgrades: [],
  heat: null,
  editCount: 0,
  session: null,
});

/** Does a claim/mute target cover a path? Targets are areas, exact paths or globs (§6.3). */
export function targetMatches(target: string, path: string, areas: Record<string, RelayArea> = {}): boolean {
  const t = target.trim();
  if (!t) return false;
  if (t.startsWith('@')) return false; // dev targets are handled by the caller
  const area = areas[t];
  if (area) return area.paths.some((g) => matchGlob(g, path));
  return matchGlob(t, path);
}

/** Muted by `/relay:mute <path|glob|area|@dev>` (§5.4)? */
export function isMuted(mutes: readonly MuteTarget[] | undefined, path: string, otherDev: string | null, areas: Record<string, RelayArea> = {}): boolean {
  if (!mutes?.length) return false;
  for (const m of mutes) {
    if (m.kind === 'dev') {
      if (otherDev && m.target.replace(/^@/, '').toLowerCase() === otherDev.toLowerCase()) return true;
      continue;
    }
    if (targetMatches(m.target, path, areas)) return true;
  }
  return false;
}

/** Policy value -> hook decision for the strongest severity. */
function policyDecision(policy: CollisionPolicy): CollisionDecision {
  switch (policy) {
    case 'ask':
      return 'ask';
    case 'deny':
      return 'deny';
    case 'context':
      return 'context';
    case 'note':
      return 'note';
    case 'off':
      return 'none';
  }
}

/** Apply the staleness ladder (§6.5): degraded -> deny->ask, ask->context; stale/offline -> context only. */
export function degradeForStaleness(decision: CollisionDecision, tier: StalenessTier): CollisionDecision {
  if (tier === 'fresh') return decision;
  if (tier === 'degraded') return decision === 'deny' ? 'ask' : decision === 'ask' ? 'context' : decision;
  return decision === 'deny' || decision === 'ask' ? 'context' : decision;
}

function partyFrom(dev: string, heat: HeatEntry | null, session: SnapshotSession | null, editCount: number, impactId: string | null): CollisionParty {
  return {
    dev,
    sessionId: heat?.sessionId ?? session?.id ?? null,
    branch: session?.branch ?? heat?.branch ?? null,
    worktree: session?.worktree ?? null,
    objective: session?.objective ?? heat?.objective ?? null,
    state: session?.state ?? null,
    lastEditAt: heat?.at ?? session?.lastEditAt ?? null,
    editCount,
    impactId,
  };
}

/** Is a heat entry already in my branch by SHA (fast path) or by blob (content path)? null = unknown (§6.3). */
export function heatInMyBranch(heat: HeatEntry, ancestry: AncestryFile | null | undefined, myHeadBlob?: string | null): boolean | null {
  if (heat.blobId && myHeadBlob && heat.blobId === myHeadBlob) return true;
  if (!ancestry) return null;
  if (heat.headSha) {
    const c = ancestry.contains[heat.headSha];
    if (c === true) return true;
    if (c === false) return false;
  }
  return null;
}

/**
 * Compute the verdict for one path. Severity precedence: CLAIMED > HOT > WARM
 * > SEQUENTIAL > SAME_DEV > NONE (§6.4). Decisions are then degraded by the
 * staleness ladder, interactivity and the fatigue marks.
 */
export function assessCollision(input: CollisionInput): CollisionAssessment {
  const now = input.now ?? Date.now();
  const snapshot = input.snapshot;
  const breaker = input.breaker ?? { open: false, sinceMs: null };
  const ageMs = snapshotAgeMs(snapshot, now);
  const tier = stalenessTier(ageMs, breaker.open);
  const label = stalenessLabel(tier, snapshot, breaker.sinceMs);
  const areas = input.areas ?? snapshot?.repo.config.areas ?? {};
  if (!snapshot) return NONE(input.path, tier, label);
  const path = input.path;
  const me = input.me;
  const hubNow = hubNowMs(snapshot, now);
  const pathAreas = areasOfPath(path, areas);
  const downgrades: string[] = [];

  // --- CLAIMED: another dev's unexpired explicit claim covering the path (§6.3)
  const claims = snapshot.claims.filter((c) => c.dev !== me.dev && (hubNow === null || (parseIso(c.expiresAt) ?? 0) > hubNow));
  const claim: SnapshotClaim | null = claims.find((c) => targetMatches(c.target, path, areas) || pathAreas.includes(c.target)) ?? null;

  // --- heat on this exact path, newest first
  const heatOnPath = snapshot.heat.filter((h) => h.path === path).sort((a, b) => (parseIso(b.at) ?? 0) - (parseIso(a.at) ?? 0));
  const others = heatOnPath.filter((h) => !h.mine && h.dev !== me.dev);
  const sessionOf = (dev: string, sessionId: string | null): SnapshotSession | null =>
    snapshot.sessions.find((s) => s.id === sessionId) ?? snapshot.sessions.find((s) => s.dev === dev && s.state !== 'gone') ?? null;
  const editCountOf = (dev: string): number =>
    heatOnPath.filter((h) => h.dev === dev && h.kind === 'edit').reduce((n, h) => n + (h.count ?? 1), 0);

  // --- HOT: other dev's edit heat <= 15 min and their session seen <= 30 min (§6.3 implicit claim)
  let hot: HeatEntry | null = null;
  for (const h of others) {
    if (h.kind !== 'edit') continue;
    const heatAge = itemAgeMs(snapshot, h.at, now);
    if (heatAge === null || heatAge > STALENESS.heatHotMs) continue;
    const s = sessionOf(h.dev, h.sessionId);
    const seenAge = s ? itemAgeMs(snapshot, s.lastSeenAt, now) : null;
    if (s && seenAge !== null && seenAge <= STALENESS.implicitClaimSeenMs && s.state !== 'gone') {
      hot = h;
      break;
    }
  }

  // --- WARM / SEQUENTIAL: other dev's heat <= 24 h; in my branch by content -> SEQUENTIAL
  let warm: HeatEntry | null = null;
  let sequential: HeatEntry | null = null;
  for (const h of others) {
    const heatAge = itemAgeMs(snapshot, h.at, now);
    if (heatAge === null || heatAge > STALENESS.warmMs) continue;
    const inBranch = heatInMyBranch(h, input.ancestry);
    if (inBranch === true) {
      if (!sequential) sequential = h;
    } else if (!warm) {
      warm = h; // unknown -> treated as warm (context only, harmless)
    }
  }

  // --- SAME_DEV: my other session edited it <= 10 min ago
  const sameDev =
    heatOnPath.find((h) => {
      if (!(h.mine || h.dev === me.dev) || h.kind !== 'edit') return false;
      if (h.sessionId === me.sessionId) return false;
      const a = itemAgeMs(snapshot, h.at, now);
      return a !== null && a <= STALENESS.sameDevMs;
    }) ?? null;

  let severity: CollisionSeverity = 'NONE';
  let heat: HeatEntry | null = null;
  let otherDev: string | null = null;
  if (claim) {
    severity = 'CLAIMED';
    otherDev = claim.dev;
    heat = others.find((h) => h.dev === claim.dev) ?? null;
  } else if (hot) {
    severity = 'HOT';
    heat = hot;
    otherDev = hot.dev;
  } else if (warm) {
    severity = 'WARM';
    heat = warm;
    otherDev = warm.dev;
  } else if (sequential) {
    severity = 'SEQUENTIAL';
    heat = sequential;
    otherDev = sequential.dev;
  } else if (sameDev) {
    severity = 'SAME_DEV';
    heat = sameDev;
    otherDev = me.dev;
  }
  if (severity === 'NONE') return NONE(path, tier, label);
  if (isMuted(input.mutes, path, otherDev, areas)) {
    const n = NONE(path, tier, label);
    n.downgrades.push('muted');
    return n;
  }

  const session = otherDev ? sessionOf(otherDev, heat?.sessionId ?? null) : null;
  const impactId = snapshot.changeSets.flatMap((cs) => cs.impacts).find((i) => i.path === path)?.id ?? null;
  const other = partyFrom(otherDev as string, heat, session, otherDev ? editCountOf(otherDev) : 0, impactId);

  // --- base decision from policy
  let decision: CollisionDecision;
  let escalated = false;
  switch (severity) {
    case 'CLAIMED':
      decision = claim?.hard ? 'deny' : policyDecision(input.policy.claimed);
      break;
    case 'HOT':
      decision = policyDecision(input.policy.hot);
      // same branch, different worktree: context -> ask (§6.6)
      if (decision === 'context' && other.branch && me.branch && other.branch === me.branch && (other.worktree ?? null) !== (me.worktree ?? null)) {
        decision = 'ask';
        escalated = true;
      }
      break;
    case 'WARM':
      decision = policyDecision(input.policy.warm);
      break;
    case 'SEQUENTIAL':
      decision = 'note';
      break;
    case 'SAME_DEV':
      decision = policyDecision(input.policy.same_dev);
      break;
    default:
      decision = 'none';
  }
  if (decision === 'none') return { ...NONE(path, tier, label), severity, other, claim, heat, session, editCount: other.editCount };

  // --- staleness ladder (hard claims deny is still degraded: never deny on stale data, §6.5)
  const degraded = degradeForStaleness(decision, tier);
  if (degraded !== decision) downgrades.push(`staleness:${tier}`);
  decision = degraded;

  // --- interactivity (§4.0 rule 14): ask -> context; deny unaffected
  if (decision === 'ask' && input.interactive === false) {
    decision = 'context';
    downgrades.push('non-interactive');
  }

  // --- fatigue marks (§6.4)
  const marks = input.marks?.(otherDev as string) ?? {};
  let createAsked = false;
  let createNoted = false;
  if (decision === 'ask') {
    const askedFresh = marks.askedAgeMs !== null && marks.askedAgeMs !== undefined && marks.askedAgeMs < STALENESS.askedExpiryMs;
    const snoozed = marks.snoozeUntilMs !== null && marks.snoozeUntilMs !== undefined && marks.snoozeUntilMs > now;
    if (askedFresh || snoozed) {
      decision = 'context';
      downgrades.push(askedFresh ? 'asked-recently' : 'snoozed');
    } else {
      createAsked = true;
    }
  }
  if (decision === 'note' || decision === 'context') {
    if (severity !== 'CLAIMED' && severity !== 'HOT' && marks.noted) {
      // WARM/SEQUENTIAL/SAME_DEV notes are emitted once per (path, dev) per session
      return { ...NONE(path, tier, label), severity, other, claim, heat, session, editCount: other.editCount, downgrades: [...downgrades, 'noted'] };
    }
    if (severity !== 'CLAIMED' && severity !== 'HOT') createNoted = true;
  }

  return {
    path,
    severity,
    decision,
    tier,
    label,
    other,
    claim,
    escalated,
    createAsked,
    createNoted,
    downgrades,
    heat,
    editCount: other.editCount,
    session,
  };
}
