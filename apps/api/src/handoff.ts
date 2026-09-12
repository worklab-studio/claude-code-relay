/**
 * Handoff generation (§8): inputs are the session's own event stream on the hub —
 * never a transcript. Tier 1 (heuristic) is written first so a teammate always has
 * something within seconds; tier 2 (LLM, when ANTHROPIC_API_KEY is set and
 * `handoff.llm` is true) replaces the fields; tier 3 (`self`, from the handoff
 * tool) is never overwritten by tier 2. Generation is serialized per session with
 * `pg_try_advisory_xact_lock(hashtext(session_id))` and the row is upserted with
 * `rev + 1` on conflict (§8.1).
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  LIMITS,
  inlineText,
  type HandoffBody,
  type HandoffChangedFile,
  type HandoffCommit,
  type HandoffInterfaceChanged,
  type HandoffNoteTo,
  type HandoffQuality,
  type HandoffRecord,
  type HandoffSelfSummary,
  type SessionEndReason,
} from '@relay/core';
import type { Hub } from './hub.js';
import { rowsOf } from './db/client.js';
import { decisions, events, handoffDrafts, handoffs, heat, impacts, notifications, turns, type DevRow, type HandoffRow, type RepoRow, type SessionRow } from './db/schema.js';
import { sessionById } from './db/queries.js';
import type { HandoffPacket } from './llm.js';
import { areaOf } from './util/config.js';
import { isValidHandle, newId } from './util/ids.js';
import { iso } from './util/time.js';

export type HandoffTrigger = 'end' | 'interim' | 'manual';

export interface GenerateOptions {
  trigger: HandoffTrigger;
  self?: HandoffSelfSummary | null;
  endReason?: SessionEndReason | null;
}

const DONE_RE = /^(Done|I've|I have|Added|Updated|Fixed|Implemented|Removed|Renamed|Migrated)\b/;
const DECISION_RE = /\b(decided|decision|we'll go with|going with|chose|settled on|instead of)\b/i;
const BLOCKER_RE = /\b(blocked|blocker|waiting on|can't proceed|cannot|need .* from)\b/i;
const NEXT_HEADING_RE = /^#{0,4}\s*\**\s*(Next|TODO|Remaining|Next steps)\b/i;

/**
 * Generates (or regenerates) the handoff of a session. Returns null when the
 * session does not qualify (0 edits, 0 commits, < 3 prompts, §8.1) or when
 * another generation holds the per-session lock.
 */
export async function generateHandoff(hub: Hub, sessionId: string, opts: GenerateOptions): Promise<HandoffRecord | null> {
  const ref = await sessionById(hub, sessionId);
  if (!ref) return null;
  const { session, dev, repo } = ref;
  const config = hub.configOf(repo);
  const [draftRow] = await hub.db.select().from(handoffDrafts).where(eq(handoffDrafts.sessionId, sessionId)).limit(1);
  const draft = draftRow?.draft ?? null;
  const hasActivity = session.editCount > 0 || session.commitCount > 0 || session.promptCount >= 3 || (draft?.changed.length ?? 0) > 0;
  if (!hasActivity && !opts.self) return null;
  if (opts.trigger === 'end' && opts.endReason === 'clear' && session.editCount === 0 && session.commitCount === 0 && !opts.self) return null;

  // Lease (meta row, conditional update) so a SessionEnd and an interim sweep seconds apart
  // produce one synthesis; the LLM call runs outside any transaction because PGlite
  // serializes every query behind an open transaction.
  const now = hub.now();
  if (!(await acquireLease(hub, sessionId, now))) return null;
  try {
    const [existing] = await hub.db.select().from(handoffs).where(eq(handoffs.sessionId, sessionId)).limit(1);
    const packet = await buildPacket(hub, session, dev, repo, draft);
    let body: HandoffBody = heuristic(packet, session);
    let quality: HandoffQuality = 'heuristic';

    if (opts.self) {
      body = mergeSelf(body, opts.self);
      quality = 'self';
    } else if (existing?.quality === 'self') {
      body = rowToBody(existing);
      quality = 'self';
    } else if (hub.llm && config.handoff.llm) {
      try {
        const synthesized = await hub.llm.synthesize(packet);
        if (synthesized) {
          body = normalizeBody(synthesized, body);
          quality = 'llm';
        }
      } catch (err) {
        console.error('[relay] handoff synthesis failed, heuristic stands:', err instanceof Error ? err.message : err);
      }
    }

    const id = existing?.id ?? newId('handoff', now.getTime());
    const endedAt = session.endedAt ?? (opts.trigger === 'end' ? now : null);
    const endReason = session.endReason ?? opts.endReason ?? null;
    const generatedAt = hub.now();
    const markdown = renderMarkdown({
      ...body,
      id,
      rev: (existing?.rev ?? 0) + 1,
      quality,
      dev: dev.handle,
      sessionId,
      project: repo.project,
      repo: repo.slug,
      branch: session.branch,
      worktree: session.worktree,
      client: session.client,
      startedAt: session.startedAt.toISOString(),
      endedAt: iso(endedAt),
      endReason,
      markdown: '',
      generatedAt: generatedAt.toISOString(),
    });
    // resolve note targets before the transaction (no hub.db calls inside it)
    const noteTargets: Array<{ target: DevRow; text: string; intent: HandoffNoteTo['intent'] }> = [];
    for (const note of body.notes_to) {
      if (!isValidHandle(note.dev)) continue;
      // An explicit `handoff` tool call or the client's own heuristic draft may address a teammate who has
      // not started a Relay session yet (they get the note at their first one); an LLM-synthesized summary
      // may only address handles the hub already knows, so an invented handle never creates a dev row (review).
      const target = await hub.devByHandle(note.dev, quality !== 'llm');
      if (!target || target.id === dev.id) continue;
      noteTargets.push({ target, text: clip(note.text, 300), intent: note.intent });
    }

    const values = {
      id,
      sessionId,
      devId: dev.id,
      repoId: repo.id,
      project: repo.project,
      branch: session.branch,
      worktree: session.worktree,
      client: session.client,
      rev: 1,
      quality,
      objective: body.objective,
      areas: body.areas,
      done: body.done,
      changed: body.changed,
      interfacesChanged: body.interfaces_changed,
      decisions: body.decisions,
      blockers: body.blockers,
      next: body.next,
      commits: body.commits,
      notesTo: body.notes_to,
      markdown,
      startedAt: session.startedAt,
      endedAt,
      endReason,
      generatedAt,
    };
    const { id: _id, sessionId: _sid, rev: _rev, ...updates } = values;

    const row = await hub.db.transaction(async (tx) => {
      // §8.1: serialized per session; a concurrent writer that lost the lease race skips
      const lock = rowsOf<{ ok: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${sessionId})) as ok`));
      if (!lock[0]?.ok) return null;
      const [written] = await tx
        .insert(handoffs)
        .values(values)
        .onConflictDoUpdate({ target: handoffs.sessionId, set: { ...updates, rev: sql`${handoffs.rev} + 1` } })
        .returning();
      if (!written) return null;

      // extracted decisions become rows with source "handoff" (§8.2), deduped by text per session
      if (quality !== 'heuristic') {
        for (const text of body.decisions) {
          const [dup] = await tx
            .select({ id: decisions.id })
            .from(decisions)
            .where(and(eq(decisions.sessionId, sessionId), eq(decisions.text, text)))
            .limit(1);
          if (dup) continue;
          await tx.insert(decisions).values({
            id: newId('decision', generatedAt.getTime()),
            repoId: repo.id,
            project: repo.project,
            devId: dev.id,
            sessionId,
            topic: null,
            area: body.areas[0] ?? null,
            text,
            source: 'handoff',
            confidence: quality === 'self' ? 1 : 0.7,
            supersedes: null,
            createdAt: generatedAt,
          });
        }
      }

      // notes_to targets get a handoff notification at their next prompt (§8.4)
      for (const n of noteTargets) {
        const text = `${dev.handle}'s handoff ${written.id} (${n.intent}): ${n.text}`;
        const [dup] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(eq(notifications.refId, written.id), eq(notifications.toDevId, n.target.id), eq(notifications.body, text)))
          .limit(1);
        if (dup) continue;
        await tx.insert(notifications).values({
          id: newId('notification', generatedAt.getTime()),
          teamId: hub.team.id,
          repoId: repo.id,
          toDevId: n.target.id,
          fromDevId: dev.id,
          kind: 'handoff',
          refId: written.id,
          body: text,
          noteKind: n.intent === 'action' ? 'ask' : 'fyi',
          createdAt: generatedAt,
          deliveredAt: null,
          deliveredVia: null,
        });
      }
      return written;
    });
    if (!row) return null;
    hub.invalidateRepo(repo.slug);
    return rowToRecord(row, dev, repo);
  } finally {
    await releaseLease(hub, sessionId);
  }
}

export const HANDOFF_LEASE_MS = 60_000;

async function acquireLease(hub: Hub, sessionId: string, now: Date): Promise<boolean> {
  const key = `handoff_lock:${sessionId}`;
  const until = new Date(now.getTime() + HANDOFF_LEASE_MS).toISOString();
  const rows = rowsOf(
    await hub.db.execute(sql`
      insert into meta (key, value) values (${key}, to_jsonb(${until}::text))
      on conflict (key) do update set value = excluded.value
      where (meta.value #>> '{}')::timestamptz < ${now.toISOString()}::timestamptz
      returning key`),
  );
  return rows.length > 0;
}

async function releaseLease(hub: Hub, sessionId: string): Promise<void> {
  const key = `handoff_lock:${sessionId}`;
  await hub.db.execute(sql`update meta set value = to_jsonb('1970-01-01T00:00:00.000Z'::text) where key = ${key}`);
}

// ---------------------------------------------------------------------------
// packet + heuristic tier
// ---------------------------------------------------------------------------

async function buildPacket(hub: Hub, session: SessionRow, dev: DevRow, repo: RepoRow, draft: HandoffBody | null): Promise<HandoffPacket> {
  const cfg = hub.configOf(repo);
  const heatRows = await hub.db
    .select()
    .from(heat)
    .where(and(eq(heat.sessionId, session.id), eq(heat.kind, 'edit')))
    .orderBy(desc(heat.lastAt));
  const impactRows = await hub.db
    .select()
    .from(impacts)
    .where(and(eq(impacts.sessionId, session.id), isNull(impacts.supersededBy)))
    .orderBy(impacts.updatedAt);
  const eventRows = await hub.db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, session.id), inArray(events.type, ['commit', 'push', 'task', 'prompt'])))
    .orderBy(events.serverAt);
  const turnRows = await hub.db.select().from(turns).where(eq(turns.sessionId, session.id)).orderBy(desc(turns.at)).limit(LIMITS.turnsInPacket);
  const decisionRows = await hub.db
    .select()
    .from(decisions)
    .where(and(eq(decisions.sessionId, session.id), eq(decisions.source, 'explicit')))
    .orderBy(decisions.createdAt);

  const pushedShas = new Set(eventRows.filter((e) => e.type === 'push').map((e) => e.sha ?? ''));
  const commits: HandoffCommit[] = eventRows
    .filter((e) => e.type === 'commit')
    .map((e) => ({
      sha: e.sha ?? '',
      subject: String((e.payload as { subject?: string }).subject ?? ''),
      pushed: pushedShas.has(e.sha ?? '') || Boolean((e.payload as { pushed?: boolean }).pushed),
    }));
  const tasksDone = eventRows
    .filter((e) => e.type === 'task' && (e.payload as { status?: string }).status === 'completed')
    .map((e) => String((e.payload as { subject?: string }).subject ?? ''))
    .filter(Boolean)
    .slice(-20);
  const objectiveTrail = eventRows
    .filter((e) => e.type === 'prompt')
    .map((e) => (e.payload as { objective?: string | null }).objective)
    .filter((o): o is string => typeof o === 'string' && o.length > 0)
    .filter((o, i, arr) => arr.indexOf(o) === i)
    .slice(-5)
    .reverse();

  const edited = heatRows.map((h) => ({ path: h.path, area: areaOf(h.path, cfg.areas), edits: h.count }));
  const areas = [...new Set(edited.map((e) => e.area).filter((a): a is string => !!a))];

  return {
    dev: dev.handle,
    project: repo.project,
    repo: repo.slug,
    branch: session.branch,
    startedAt: session.startedAt.toISOString(),
    endedAt: iso(session.endedAt),
    endReason: session.endReason,
    objective: session.objective,
    objectiveTrail,
    areas,
    edited,
    contracts: impactRows
      .filter((i) => i.status !== 'withdrawn')
      .map((i) => ({ path: i.path, symbols: i.symbols, summary: i.summary, status: i.status, commitSha: i.commitSha, hunk: i.hunk, changeSetId: i.changeSetId, impactId: i.id })),
    commits,
    tasksDone,
    decisions: decisionRows.map((d) => d.text),
    turns: turnRows.reverse().map((t) => ({ at: t.at.toISOString(), text: t.text.slice(0, 1500) })),
    draft,
  };
}

/** Tier 1 (§8.2): regex extraction over the last turns plus the client draft when present. */
export function heuristic(packet: HandoffPacket, session: Pick<SessionRow, 'objective'>): HandoffBody {
  const lastTwo = packet.turns.slice(-2);
  const sentences = lastTwo.flatMap((t) => splitSentences(t.text));
  const done = uniq([
    ...packet.tasksDone,
    ...sentences.filter((s) => DONE_RE.test(s)).map(clip140),
  ]).slice(0, 6);
  const decisionLines = uniq([
    ...packet.decisions,
    ...packet.turns.flatMap((t) => splitSentences(t.text)).filter((s) => DECISION_RE.test(s)).map(clip140),
  ]).slice(0, 6);
  const blockers = uniq(packet.turns.flatMap((t) => splitSentences(t.text)).filter((s) => BLOCKER_RE.test(s)).map(clip140)).slice(0, 4);
  const lastTurn = packet.turns[packet.turns.length - 1]?.text ?? '';
  const next = nextBullets(lastTurn).slice(0, 5);

  const changed: HandoffChangedFile[] = packet.edited.map((e) => ({ path: e.path, area: e.area, edits: e.edits, why: null }));
  const interfaces: HandoffInterfaceChanged[] = packet.contracts.map((c) => ({
    changeSetId: c.changeSetId ?? null,
    impactId: c.impactId ?? null,
    path: c.path,
    symbols: c.symbols,
    summary: c.summary,
    status: c.status as HandoffInterfaceChanged['status'],
    commitSha: c.commitSha,
  }));

  const base: HandoffBody = {
    objective: packet.objective ?? session.objective ?? packet.objectiveTrail[0] ?? null,
    areas: packet.areas,
    done,
    changed,
    interfaces_changed: interfaces,
    decisions: decisionLines,
    blockers,
    next,
    commits: packet.commits,
    notes_to: [],
  };
  return packet.draft ? mergeDraft(base, packet.draft) : base;
}

/** The client draft saw the fold (tasks, objective trail, turns); prefer its non-empty arrays and union the rest. */
function mergeDraft(base: HandoffBody, draft: HandoffBody): HandoffBody {
  const changedPaths = new Set(base.changed.map((c) => c.path));
  return {
    objective: draft.objective ?? base.objective,
    areas: uniq([...base.areas, ...draft.areas]),
    done: uniq([...draft.done, ...base.done]).slice(0, 8),
    changed: [...base.changed, ...draft.changed.filter((c) => !changedPaths.has(c.path))],
    interfaces_changed: base.interfaces_changed.length > 0 ? base.interfaces_changed : draft.interfaces_changed,
    decisions: uniq([...draft.decisions, ...base.decisions]).slice(0, 8),
    blockers: uniq([...draft.blockers, ...base.blockers]).slice(0, 6),
    next: uniq([...draft.next, ...base.next]).slice(0, 6),
    commits: base.commits.length > 0 ? base.commits : draft.commits,
    notes_to: draft.notes_to,
  };
}

/** Every free-text field of a self / LLM handoff: one line, capped (they become digest lines for other developers). */
function boundBody(b: HandoffBody): HandoffBody {
  const list = (xs: readonly string[], n: number, max: number): string[] => xs.map((x) => clip(x, max)).filter(Boolean).slice(0, n);
  return {
    ...b,
    objective: b.objective ? clip(b.objective, 140) : b.objective,
    areas: list(b.areas, 20, 80),
    done: list(b.done, 20, 300),
    changed: b.changed.slice(0, 200).map((c) => ({ ...c, path: clip(c.path, 500), area: c.area ? clip(c.area, 80) : c.area, why: c.why ? clip(c.why, 300) : c.why })),
    interfaces_changed: b.interfaces_changed.slice(0, 50).map((i) => ({ ...i, path: clip(i.path, 500), summary: clip(i.summary, 300), symbols: i.symbols.slice(0, 50).map((s) => clip(s, 120)) })),
    decisions: list(b.decisions, 20, 300),
    blockers: list(b.blockers, 20, 300),
    next: list(b.next, 20, 300),
    commits: b.commits.slice(0, 100).map((c) => ({ ...c, subject: clip(c.subject, 200) })),
    notes_to: b.notes_to.slice(0, 20).map((n) => ({ ...n, dev: clip(n.dev, 64), text: clip(n.text, 300) })),
  };
}

function mergeSelf(base: HandoffBody, self: HandoffSelfSummary): HandoffBody {
  const changed: HandoffChangedFile[] = (self.changed ?? []).map((c) =>
    typeof c === 'string' ? { path: c, area: null, edits: base.changed.find((b) => b.path === c)?.edits ?? 0, why: null } : c,
  );
  const interfaces: HandoffInterfaceChanged[] = (self.interfaces_changed ?? []).map((i) =>
    typeof i === 'string'
      ? { changeSetId: null, impactId: null, path: i, symbols: [], summary: i, status: 'uncommitted' as const, commitSha: null }
      : {
          changeSetId: i.changeSetId ?? null,
          impactId: i.impactId ?? null,
          path: i.path ?? '',
          symbols: i.symbols ?? [],
          summary: i.summary ?? i.path ?? '',
          status: i.status ?? 'uncommitted',
          commitSha: i.commitSha ?? null,
        },
  );
  return boundBody({
    objective: self.objective ?? base.objective,
    areas: base.areas,
    done: self.done ?? base.done,
    changed: changed.length > 0 ? changed : base.changed,
    interfaces_changed: interfaces.length > 0 ? interfaces : base.interfaces_changed,
    decisions: self.decisions ?? base.decisions,
    blockers: self.blockers ?? base.blockers,
    next: self.next ?? base.next,
    commits: base.commits,
    notes_to: self.notes_to ?? base.notes_to,
  });
}

/** LLM output may drop record-backed lists; keep the heuristic's record fields when the model returned none. */
function normalizeBody(llm: HandoffBody, base: HandoffBody): HandoffBody {
  return boundBody({
    objective: llm.objective ?? base.objective,
    areas: llm.areas.length > 0 ? llm.areas : base.areas,
    done: llm.done,
    changed: llm.changed.length > 0 ? llm.changed : base.changed,
    interfaces_changed: llm.interfaces_changed.length > 0 ? llm.interfaces_changed : base.interfaces_changed,
    decisions: llm.decisions,
    blockers: llm.blockers,
    next: llm.next,
    commits: llm.commits.length > 0 ? llm.commits : base.commits,
    notes_to: llm.notes_to,
  });
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 8);
}

function nextBullets(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inNext = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (NEXT_HEADING_RE.test(line)) {
      inNext = true;
      continue;
    }
    if (!inNext) continue;
    if (/^#{1,4}\s/.test(line) || (line === '' && out.length > 0)) break;
    const m = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (m && m[1]) out.push(clip140(m[1]));
  }
  return out;
}

function clip140(s: string): string {
  return clip(s, 140);
}

/** One line, block-safe, capped on a word boundary (§11: these strings are rendered into other developers' context). */
function clip(s: string, max: number): string {
  return inlineText(s, max);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// records + markdown
// ---------------------------------------------------------------------------

export function rowToBody(row: HandoffRow): HandoffBody {
  return {
    objective: row.objective,
    areas: row.areas,
    done: row.done,
    changed: row.changed,
    interfaces_changed: row.interfacesChanged,
    decisions: row.decisions,
    blockers: row.blockers,
    next: row.next,
    commits: row.commits,
    notes_to: row.notesTo,
  };
}

export function rowToRecord(row: HandoffRow, dev: DevRow, repo: RepoRow): HandoffRecord {
  return {
    ...rowToBody(row),
    id: row.id,
    rev: row.rev,
    quality: row.quality,
    dev: dev.handle,
    sessionId: row.sessionId,
    project: row.project,
    repo: repo.slug,
    branch: row.branch,
    worktree: row.worktree,
    client: row.client,
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
    endReason: row.endReason,
    markdown: row.markdown,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/** Markdown with Egregore's addressed-handoff frontmatter (`from`, `addressed_to`, `intent`, `claim`, `ask`) and the fixed §8.3 headings. */
export function renderMarkdown(h: HandoffRecord): string {
  const addressed = h.notes_to.map((n) => n.dev);
  const intent = h.notes_to.find((n) => n.intent === 'action')?.intent ?? h.notes_to[0]?.intent ?? 'fyi';
  const claim = h.done[0] ?? h.objective ?? '';
  const ask = h.notes_to.find((n) => n.intent === 'action')?.text ?? h.next[0] ?? '';
  const fm = [
    '---',
    `id: ${h.id}`,
    `rev: ${h.rev}`,
    `quality: ${h.quality}`,
    `from: ${h.dev}`,
    `addressed_to: [${addressed.join(', ')}]`,
    `intent: ${intent}`,
    `claim: ${yamlString(claim)}`,
    `ask: ${yamlString(ask)}`,
    `project: ${h.project}`,
    `repo: ${h.repo}`,
    `branch: ${h.branch}`,
    `session: ${h.sessionId}`,
    `started_at: ${h.startedAt}`,
    `ended_at: ${h.endedAt ?? ''}`,
    `end_reason: ${h.endReason ?? ''}`,
    `generated_at: ${h.generatedAt}`,
    '---',
  ];
  const lines: string[] = [...fm, '', `# ${h.objective ?? 'Session handoff'}${h.quality === 'heuristic' ? ' (auto-summary)' : ''}`, ''];
  const section = (title: string, items: string[]) => {
    lines.push(`## ${title}`);
    if (items.length === 0) lines.push('- (none)');
    else for (const i of items) lines.push(`- ${i}`);
    lines.push('');
  };
  section('Done', h.done);
  section(
    'Changed',
    h.changed.map((c) => `${c.path}${c.area ? ` (${c.area})` : ''} · ${c.edits} edit${c.edits === 1 ? '' : 's'}${c.why ? ` · ${c.why}` : ''}`),
  );
  section(
    'Interfaces changed',
    h.interfaces_changed.map((i) => `${i.path}${i.symbols.length > 0 ? ` (${i.symbols.join(', ')})` : ''}: ${i.summary} [${i.status}${i.commitSha ? ` ${i.commitSha.slice(0, 7)}` : ''}${i.changeSetId ? `, ${i.changeSetId}` : ''}]`),
  );
  section('Decisions', h.decisions);
  section('Blockers', h.blockers);
  section('Next', h.next);
  section('Commits', h.commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}${c.pushed ? ' (pushed)' : ''}`));
  section('Notes to', h.notes_to.map((n: HandoffNoteTo) => `${n.dev} (${n.intent}): ${n.text}`));
  return lines.join('\n').trimEnd() + '\n';
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}
