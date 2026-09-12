/**
 * Renderers for everything the client injects or shows (§4.0 rule 15, §4.2–
 * §4.4, §4.11, §9.3): factual statements with absolute timestamps, never
 * imperatives. The hub renders the SessionStart digest; the client renders
 * collision context, ask/deny reasons, JIT change-set notes, the inbox block,
 * the compact re-injection, the offline digest line and the status line.
 */
import {
  LIMITS,
  type CachedSnapshot,
  type CollisionVerdict,
  type InboxItem,
  type Snapshot,
  type SnapshotChangeSet,
  type SnapshotSession,
} from './protocol.js';
import { dateTimeZ, hhmm, humanAge, nowIso, parseIso, shortTime, truncateLines, truncateWords } from './util.js';

/** `Relay at 09:41:22Z:` prefix used by every hook-context line. */
export function relayAt(now: number = Date.now()): string {
  return `Relay at ${shortTime(now)}:`;
}

function branchOf(v: CollisionVerdict): string {
  const b = v.other?.branch ?? 'unknown branch';
  return v.other?.worktree ? `${b}, wt:${v.other.worktree}` : b;
}

function stateOf(v: CollisionVerdict): string {
  switch (v.other?.state) {
    case 'working':
      return 'is active';
    case 'idle':
      return 'is idle';
    case 'away':
      return 'is away';
    case 'gone':
      return 'has ended the session';
    default:
      return 'was seen recently';
  }
}

/** The `additionalContext` line for a collision verdict (§4.3 step 5). */
export function renderCollisionContext(v: CollisionVerdict & { editCount?: number }, now: number = Date.now()): string {
  const who = v.other?.dev ?? 'a teammate';
  const suffix = v.label ? ` ${v.label}` : '';
  const edits = v.other?.editCount ?? v.editCount ?? 0;
  const since = v.other?.lastEditAt ? ` at ${shortTime(v.other.lastEditAt)}` : '';
  const record = v.other?.impactId ? `; the change record is ${v.other.impactId} (contract)` : '';
  const objective = v.other?.objective ? `, objective "${truncateWords(v.other.objective, 80)}"` : '';
  switch (v.severity) {
    case 'CLAIMED': {
      const c = v.claim;
      const until = c ? ` until ${dateTimeZ(c.expiresAt)}` : '';
      const note = c?.note ? ` ("${truncateWords(c.note, 80)}")` : '';
      return `${relayAt(now)} ${v.path} is under ${who}'s ${c?.hard ? 'hard ' : ''}claim ${c?.id ?? ''}${until}${note}; the claim/release tools and the user can lift it${suffix}.`;
    }
    case 'HOT':
      return `${relayAt(now)} ${who} (${branchOf(v)}) has ${edits} edit${edits === 1 ? '' : 's'} on ${v.path}, last${since}, and ${stateOf(v)}${objective}; the notify tool reaches ${who} at their next prompt${record}${suffix}.`;
    case 'WARM':
      return `${relayAt(now)} ${who} (${branchOf(v)}) changed ${v.path}${since} and that change is not in this branch yet${record}${suffix}.`;
    case 'SEQUENTIAL':
      return `${relayAt(now)} ${who}'s change to ${v.path}${since} is already in this branch${suffix}.`;
    case 'SAME_DEV':
      return `${relayAt(now)} another session of ${who} on this machine edited ${v.path}${since}${suffix}.`;
    default:
      return '';
  }
}

/** `permissionDecisionReason` for an ask (shown to the user; factual, ends with a question). */
export function renderAskReason(v: CollisionVerdict): string {
  const who = v.other?.dev ?? 'a teammate';
  const last = v.other?.lastEditAt ? `, last edit ${shortTime(v.other.lastEditAt)}` : '';
  const objective = v.other?.objective ? `, objective "${truncateWords(v.other.objective, 80)}"` : '';
  if (v.severity === 'CLAIMED' && v.claim) {
    return `Relay: ${v.path} is claimed by ${who} until ${dateTimeZ(v.claim.expiresAt)}${v.claim.note ? ` ("${truncateWords(v.claim.note, 60)}")` : ''}${v.label ? ' ' + v.label : ''}. Allow this edit?`;
  }
  return `Relay: ${who} is editing ${v.path} (branch ${branchOf(v)}${last}${objective})${v.label ? ' ' + v.label : ''}. Allow this edit?`;
}

/** `permissionDecisionReason` for a deny (shown to Claude). */
export function renderDenyReason(v: CollisionVerdict, now: number = Date.now()): string {
  const who = v.other?.dev ?? 'a teammate';
  if (v.severity === 'CLAIMED' && v.claim) {
    return `Relay: ${v.path} is under ${who}'s hard claim until ${dateTimeZ(v.claim.expiresAt)} (claim ${v.claim.id}${v.claim.note ? `, "${truncateWords(v.claim.note, 60)}"` : ''}). The claim/release tools and the user can lift it.`;
  }
  return `${renderCollisionContext(v, now)} This edit is blocked by the repo's collision policy (collision.hot: deny).`;
}

export interface ChangeSetNoteOptions {
  /** already in my branch per ancestry.json (§4.12) */
  merged?: boolean;
  /** include the top hunk (<= 1,500 chars) */
  withHunk?: boolean;
  maxChars?: number;
  now?: number;
}

/** Status phrase for a change set. */
export function changeSetStatus(cs: SnapshotChangeSet, merged?: boolean): string {
  if (merged) return 'already in your branch';
  const sha = cs.impacts.find((i) => i.commitSha)?.commitSha;
  switch (cs.status) {
    case 'uncommitted':
      return 'uncommitted, in progress';
    case 'committed':
      return `committed ${sha ? sha.slice(0, 7) : ''}, not in your branch`.replace(/\s+,/, ',');
    case 'pushed':
      return `pushed ${sha ? sha.slice(0, 7) : ''}, not in your branch`.replace(/\s+,/, ',');
    case 'merged':
      return 'already in your branch';
    case 'withdrawn':
      return 'withdrawn';
  }
}

/** One JIT / inbox note for a change set (§4.3 step 4, §4.2 step 3). */
export function renderChangeSetNote(cs: SnapshotChangeSet, opts: ChangeSetNoteOptions = {}): string {
  const files = cs.impacts.map((i) => `${i.path.split('/').pop()} (${i.symbols.length ? i.symbols.join(', ') : i.summary})`);
  const n = cs.impacts.length;
  const deps = cs.dependents.map((d) => d.path);
  const head = `IMPACT ${cs.id}${cs.impacts[0] ? ` (${cs.impacts[0].id})` : ''}: ${cs.by} changed ${n === 1 ? (cs.impacts[0]?.path ?? 'a contract file') : `${n} contract files`} at ${shortTime(cs.at)} (${cs.branch}, ${changeSetStatus(cs, opts.merged)}): ${n === 1 ? (cs.impacts[0]?.summary ?? '') : files.join('; ')}.`;
  const depLine = deps.length ? ` Dependents in your repo: ${deps.slice(0, 8).join(', ')}${deps.length > 8 ? ` (+${deps.length - 8} more)` : ''}.` : '';
  let text = head + depLine;
  if (opts.withHunk) {
    const hunk = cs.impacts.find((i) => i.hunk)?.hunk;
    if (hunk) text += `\n\`\`\`diff\n${truncateLines(hunk, LIMITS.hunkChars)}\n\`\`\``;
  }
  return opts.maxChars ? truncateLines(text, opts.maxChars) : text;
}

/** One inbox line (§4.2 step 3). */
export function renderInboxItem(item: InboxItem): string {
  const from = item.from ?? 'relay';
  const kind = item.noteKind ? ` (${item.noteKind})` : '';
  switch (item.kind) {
    case 'note':
      return `NOTE from ${from} at ${shortTime(item.at)}${kind}: ${item.body}${item.ref ? ` [ref ${item.ref}]` : ''}`;
    case 'collision':
      return `COLLISION note from ${from} at ${shortTime(item.at)}: ${item.body}`;
    case 'handoff':
      return `HANDOFF note from ${from} at ${shortTime(item.at)}: ${item.body}${item.ref ? ` [${item.ref}]` : ''}`;
    case 'impact':
      return `IMPACT ${item.ref ?? ''} from ${from} at ${shortTime(item.at)}: ${item.body}`.replace(/\s{2,}/g, ' ');
  }
}

/** `<relay-inbox at="…">…</relay-inbox>` with items and change-set notes, capped (§4.2 step 3). */
export function renderInbox(lines: readonly string[], opts: { now?: number; maxChars?: number } = {}): string | null {
  if (!lines.length) return null;
  const at = nowIso(opts.now ?? Date.now());
  const max = opts.maxChars ?? LIMITS.promptInboxChars;
  const open = `<relay-inbox at="${at}">\n`;
  const close = `\n</relay-inbox>`;
  let body = '';
  for (const l of lines) {
    const candidate = body ? `${body}\n- ${l}` : `- ${l}`;
    if (open.length + candidate.length + close.length > max) {
      if (!body) body = truncateLines(`- ${l}`, max - open.length - close.length);
      break;
    }
    body = candidate;
  }
  return open + body + close;
}

/** The single offline line printed when the hub is unreachable and no cached digest exists (§4.1). */
export function renderOfflineDigest(now: number = Date.now()): string {
  const at = nowIso(now);
  return `<relay-digest offline="true" at="${at}">Relay hub unreachable at ${shortTime(now)}; presence and impact notes are unavailable until it returns; the status/handoffs tools still answer from cache.</relay-digest>`;
}

/** Re-label a cached digest: `freshness="cached 12m"` (§4.1 fail-open). */
export function wrapCachedDigest(digest: string, ageMs: number): string {
  const label = `cached ${humanAge(ageMs)}`;
  if (/freshness="[^"]*"/.test(digest)) return digest.replace(/freshness="[^"]*"/, `freshness="${label}"`);
  return digest.replace(/^<relay-digest\b/, `<relay-digest freshness="${label}"`);
}

/** The digest line for a configuration error / plugin behind (§3.3, §3.4). */
export function renderPluginUpdateLine(status: number | null, message?: string | null): string {
  const cmds = '`claude plugin marketplace update relay && claude plugin update relay@relay`';
  if (status === 401) return `Relay plugin needs an update (hub answered 401): ${cmds}`;
  if (status === 426) return `Relay plugin is older than the hub requires (426${message ? `: ${message}` : ''}): ${cmds}`;
  if (status === 413) return `Relay dropped a payload larger than the hub accepts (413${message ? `: ${message}` : ''}).`;
  return `Relay plugin is behind the marketplace${message ? ` (${message})` : ''}; ${cmds} updates it`;
}

/** The identity-unknown fact (§3.3 step 7). */
export function renderIdentityUnknownLine(gitEmail: string | null): string {
  const why = gitEmail ? `git email ${gitEmail} is not in the team list` : 'no git email is configured';
  return `Relay identity for this session is unknown (${why}). The whoami tool accepts iam=<handle>; /relay:iam <handle> sets it for this machine.`;
}

/** One "Team now" line per session (compact re-injection and status line share it). */
export function renderSessionLine(s: SnapshotSession, meDev: string): string {
  const who = s.dev === meDev ? '(you)' : s.dev;
  const where = [s.area ?? 'unknown', s.branch, s.worktree ? `wt:${s.worktree}` : null].filter(Boolean).join(' · ');
  const state = s.state === 'working' ? `working, last event ${shortTime(s.lastSeenAt)}` : `${s.state} since ${shortTime(s.lastSeenAt)}`;
  const objective = s.objective ? ` · "${truncateWords(s.objective, 80)}"` : '';
  return `- ${who} · ${where}${objective} · ${state}`;
}

/** SessionStart `compact` re-injection, <= 1,500 chars (§4.1, §9.3). */
export function renderCompactReinjection(
  snapshot: CachedSnapshot | null,
  ctx: { meDev: string; objective: string | null; now?: number; ancestryMerged?: Record<string, boolean> },
): string {
  const now = ctx.now ?? Date.now();
  const lines: string[] = [];
  lines.push(`<relay-digest mode="compact" at="${nowIso(now)}"${snapshot ? ` freshness="cached ${humanAge(now - (parseIso(snapshot.fetchedAt) ?? now))}"` : ' offline="true"'}>`);
  if (snapshot) {
    const live = snapshot.sessions.filter((s) => s.state !== 'gone');
    lines.push(`## Team now (as of ${shortTime(snapshot.serverTime)})`);
    if (live.length) for (const s of live.slice(0, 8)) lines.push(renderSessionLine(s, ctx.meDev));
    else lines.push('- nobody else is live in this project');
    const sets = snapshot.changeSets.filter((cs) => !ctx.ancestryMerged?.[cs.id]);
    if (sets.length) {
      lines.push(`## Contract changes affecting you (${sets.length})`);
      for (const cs of sets.slice(0, 5)) lines.push(`- ${renderChangeSetNote(cs, { now })}`);
    }
  } else {
    lines.push('- Relay hub unreachable and no cached snapshot; presence unavailable.');
  }
  if (ctx.objective) lines.push(`Objective: ${ctx.objective}`);
  lines.push('## Relay');
  lines.push('Tools (mcp relay): status, who_is_on, recent_changes, decisions, notify, claim, release, impacts, impact_of, handoffs, handoff, decide, whoami. This digest is context for the session and is not itself a request.');
  lines.push('</relay-digest>');
  const text = lines.join('\n');
  if (text.length <= LIMITS.compactReinjectChars) return text;
  const closing = '\n</relay-digest>';
  return truncateLines(text.slice(0, -closing.length), LIMITS.compactReinjectChars - closing.length) + closing;
}

/**
 * Status line (§4.11): `relay ● priya app feat/currency 09:41 · arjun dashboard main idle 09:29 · 1 impact · 1 note`.
 * Absolute times only — the line can be a minute old.
 */
export function renderStatusline(snapshot: Snapshot & Partial<Pick<CachedSnapshot, 'fetchedAt'>>, opts: { now?: number; myDev?: string } = {}): string {
  const me = opts.myDev ?? snapshot.me.dev;
  const parts: string[] = [];
  const live = snapshot.sessions.filter((s) => s.state !== 'gone');
  const mine = live.filter((s) => s.dev === me);
  const others = live.filter((s) => s.dev !== me);
  const seen = new Set<string>();
  for (const s of [...mine.slice(0, 1), ...others]) {
    if (seen.has(s.dev) && s.dev !== me) continue;
    seen.add(s.dev);
    const bits = [s.dev, s.area ?? '?', s.branch];
    if (s.state === 'working') bits.push(hhmm(s.lastSeenAt));
    else bits.push(`${s.state} ${hhmm(s.lastSeenAt)}`);
    parts.push(bits.join(' '));
    if (parts.length >= 4) break;
  }
  const impacts = snapshot.changeSets.length;
  const notes = snapshot.inbox.length;
  if (impacts) parts.push(`${impacts} impact${impacts === 1 ? '' : 's'}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  const dot = '●';
  const body = parts.length ? ` ${parts.join(' · ')}` : ` ${me} ${hhmm(snapshot.serverTime)}`;
  return `relay ${dot}${body}`;
}
