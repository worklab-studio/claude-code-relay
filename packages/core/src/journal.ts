/**
 * Per-session journal (§4.0 rules 9–10, §4.4, §10.3):
 *   sessions/<sid>/meta.json      identity + repo + branch, rewritten under the lock only
 *   sessions/<sid>/events.jsonl   append-only (O_APPEND, one line <= 4 KB), rotated at 64 KB
 *   sessions/<sid>/fold.json      fold of rotated files
 *   sessions/<sid>/marks/<kind>.<key>   created with 'wx' (atomic, race-free)
 *   sessions/<sid>/.lock/         mkdir lock, 50 ms spin, 300 ms give-up, stale recovery
 *   sessions/<sid>/pending, draft.json
 * Hooks for one session run in parallel; nothing here read-modify-writes a
 * shared JSON file without the lock, and dedup decisions use marks only.
 */
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { loadRelayConfig, type LoadedRelayConfig, type RelayEnv } from './config.js';
import { gitHeadBefore, revParseSet } from './git.js';
import { authorEmails, resolveIdentity } from './identity.js';
import {
  BUDGET_MS,
  LIMITS,
  LOCAL_PATHS,
  SESSION_FILES,
  isJournalEntry,
  isRecord,
  isSessionMeta,
  type AskedMark,
  type HandoffDraft,
  type IsoTime,
  type JournalContract,
  type JournalEntry,
  type JournalFold,
  type JournalObjective,
  type MarkKind,
  type SessionMeta,
  type SessionStartSource,
  type TeamConfig,
} from './protocol.js';
import { isPathUnder, localSlug, normalizeOriginUrl, realpathBestEffort, repoKey, worktreeName } from './repo.js';
import {
  byteLength,
  ensureDir,
  exists,
  fileSize,
  mtimeMs,
  nowIso,
  parseIso,
  readJson,
  readText,
  removeFile,
  sha1,
  sleep,
  writeJsonAtomic,
} from './util.js';

export function sessionsDir(home: string): string {
  return join(home, LOCAL_PATHS.sessionsDir);
}

export function sessionDir(home: string, sessionId: string): string {
  return join(sessionsDir(home), sessionId);
}

/** Create the session directory and marks/ (idempotent). */
export function ensureSessionDir(home: string, sessionId: string): string {
  const dir = sessionDir(home, sessionId);
  ensureDir(join(dir, SESSION_FILES.marksDir));
  return dir;
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

export function readMeta(dir: string): SessionMeta | null {
  const v = readJson(join(dir, SESSION_FILES.meta));
  return isSessionMeta(v) ? v : null;
}

/** Atomic rewrite; callers hold the session lock when merging fields (§4.0 rule 9). */
export function writeMeta(dir: string, meta: SessionMeta): boolean {
  ensureDir(join(dir, SESSION_FILES.marksDir));
  return writeJsonAtomic(join(dir, SESSION_FILES.meta), meta, true);
}

// ---------------------------------------------------------------------------
// events.jsonl (append-only)
// ---------------------------------------------------------------------------

/** Serialize one entry to a single line <= 4 KB, trimming `text` first, then `hunk`-like long strings. */
export function serializeJournalEntry(entry: JournalEntry): string {
  let line = JSON.stringify(entry);
  if (byteLength(line) <= LIMITS.journalLineBytes) return line;
  const copy: Record<string, unknown> = { ...(entry as unknown as Record<string, unknown>) };
  for (const key of ['text', 'subject', 'files', 'contracts', 'symbols']) {
    if (typeof copy[key] === 'string') {
      const over = byteLength(line) - LIMITS.journalLineBytes + 16;
      copy[key] = (copy[key] as string).slice(0, Math.max(0, (copy[key] as string).length - over));
      line = JSON.stringify(copy);
      if (byteLength(line) <= LIMITS.journalLineBytes) return line;
    } else if (Array.isArray(copy[key])) {
      copy[key] = (copy[key] as unknown[]).slice(0, 20);
      line = JSON.stringify(copy);
      if (byteLength(line) <= LIMITS.journalLineBytes) return line;
    }
  }
  return line.length > LIMITS.journalLineBytes ? JSON.stringify({ t: entry.t, at: entry.at, truncated: true }) : line;
}

/** Append one line with O_APPEND (a single write is atomic for lines under PIPE_BUF-ish sizes on POSIX). */
export function appendJournal(dir: string, entry: JournalEntry): boolean {
  const path = join(dir, SESSION_FILES.events);
  const line = serializeJournalEntry(entry) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && attempt === 0) {
        ensureDir(dir);
        continue;
      }
      return false;
    }
  }
  return false;
}

/** Parse a jsonl file into entries, skipping malformed or partial lines. */
export function parseJournalText(text: string | null): JournalEntry[] {
  if (!text) return [];
  const out: JournalEntry[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (isJournalEntry(v)) out.push(v);
    } catch {
      /* partial line from a concurrent writer: skip */
    }
  }
  return out;
}

/** Entries of the live events.jsonl (not the rotated files — those are in fold.json). */
export function readJournalEntries(dir: string): JournalEntry[] {
  return parseJournalText(readText(join(dir, SESSION_FILES.events)));
}

// ---------------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------------

export function emptyFold(): JournalFold {
  return {
    v: 1,
    foldedLines: 0,
    edits: {},
    recentPaths: [],
    contracts: {},
    objective: { text: null, source: null, at: null, toolCallsSince: 0, trail: [] },
    tasks: { open: [], done: [] },
    turns: [],
    commits: [],
    prompts: { count: 0, lastAt: null, lastPromptId: null },
    lastTurnAt: null,
    lastTurnWasQuestion: false,
    ended: null,
  };
}

const RECENT_PATHS_CAP = 100;
const COMMITS_CAP = 100;
const DONE_TASKS_CAP = 20;
const TRAIL_CAP = 5;

/** Apply entries to a fold (pure; returns a new object). */
export function foldEntries(entries: readonly JournalEntry[], base: JournalFold = emptyFold()): JournalFold {
  const f: JournalFold = structuredClone(base);
  for (const e of entries) {
    f.foldedLines += 1;
    switch (e.t) {
      case 'edit': {
        const cur = f.edits[e.path];
        if (cur) {
          cur.count += 1;
          cur.lastAt = e.at;
          cur.tool = e.tool;
        } else {
          f.edits[e.path] = { count: 1, firstAt: e.at, lastAt: e.at, tool: e.tool };
        }
        f.recentPaths = [e.path, ...f.recentPaths.filter((p) => p !== e.path)].slice(0, RECENT_PATHS_CAP);
        f.objective.toolCallsSince += 1;
        break;
      }
      case 'prompt':
        f.prompts.count += 1;
        f.prompts.lastAt = e.at;
        f.prompts.lastPromptId = e.promptId;
        break;
      case 'objective': {
        f.objective.text = e.objective;
        f.objective.source = e.source;
        f.objective.at = e.at;
        f.objective.toolCallsSince = 0;
        f.objective.trail = [e, ...f.objective.trail].slice(0, TRAIL_CAP);
        break;
      }
      case 'contract':
        f.contracts[e.path] = e;
        break;
      case 'commit':
        if (!f.commits.some((c) => c.sha === e.sha)) f.commits = [...f.commits, e].slice(-COMMITS_CAP);
        else f.commits = f.commits.map((c) => (c.sha === e.sha ? { ...c, ...e } : c));
        break;
      case 'task':
        if (e.status === 'created') {
          if (!f.tasks.open.some((t) => t.id === e.id)) f.tasks.open.push({ id: e.id, subject: e.subject, at: e.at });
        } else {
          f.tasks.open = f.tasks.open.filter((t) => t.id !== e.id);
          if (!f.tasks.done.some((t) => t.id === e.id)) f.tasks.done = [...f.tasks.done, { id: e.id, subject: e.subject, at: e.at }].slice(-DONE_TASKS_CAP);
        }
        break;
      case 'turn':
        f.turns = [...f.turns.filter((t) => !(e.promptId && t.promptId === e.promptId)), e].slice(-LIMITS.turnsInPacket);
        f.lastTurnAt = e.at;
        f.lastTurnWasQuestion = e.text.trim().endsWith('?');
        break;
      case 'end':
        f.ended = { at: e.at, reason: e.reason };
        break;
      case 'cwd':
      case 'branch':
        break;
    }
  }
  return f;
}

export function isJournalFold(x: unknown): x is JournalFold {
  return isRecord(x) && x['v'] === 1 && isRecord(x['edits']) && Array.isArray(x['recentPaths']) && isRecord(x['objective']);
}

/** fold.json (rotated history) + the live events.jsonl, in ~1 ms (§4.0 rule 9). */
export function loadFold(dir: string): JournalFold {
  const stored = readJson(join(dir, SESSION_FILES.fold));
  const base = isJournalFold(stored) ? stored : emptyFold();
  return foldEntries(readJournalEntries(dir), base);
}

/** Rotate events.jsonl into fold.json when it passes 64 KB (worker chore, under the lock). */
export async function rotateJournalIfLarge(dir: string, threshold: number = LIMITS.journalRotateBytes): Promise<boolean> {
  const live = join(dir, SESSION_FILES.events);
  const size = fileSize(live);
  if (size === null || size < threshold) return false;
  return withSessionLock(dir, async ({ locked }) => {
    if (!locked) return false;
    const rotated = join(dir, `events.${Date.now()}.jsonl`);
    try {
      renameSync(live, rotated);
    } catch {
      return false;
    }
    const stored = readJson(join(dir, SESSION_FILES.fold));
    const base = isJournalFold(stored) ? stored : emptyFold();
    const folded = foldEntries(parseJournalText(readText(rotated)), base);
    if (!writeJsonAtomic(join(dir, SESSION_FILES.fold), folded)) return false;
    removeFile(rotated);
    return true;
  });
}

// ---------------------------------------------------------------------------
// marks (race-free dedup, §4.0 rule 9)
// ---------------------------------------------------------------------------

/** `sha1(path|dev)` — the key of asked/snooze/noted marks (§4.3, §6.4). */
export function markKey(path: string, dev: string): string {
  return sha1(`${path}|${dev}`);
}

export function markPath(dir: string, kind: MarkKind, key?: string): string {
  return join(dir, SESSION_FILES.marksDir, key ? `${kind}.${key}` : kind);
}

export type MarkResult = 'created' | 'exists' | 'error';

/** Create a mark with 'wx': exactly one of N parallel callers gets `created`. */
export function createMark(dir: string, kind: MarkKind, key?: string, content = ''): MarkResult {
  const path = markPath(dir, kind, key);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        if (content) writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return 'created';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      if (code === 'ENOENT' && attempt === 0) {
        ensureDir(join(dir, SESSION_FILES.marksDir));
        continue;
      }
      return 'error';
    }
  }
  return 'error';
}

export function hasMark(dir: string, kind: MarkKind, key?: string): boolean {
  return exists(markPath(dir, kind, key));
}

export function readMark(dir: string, kind: MarkKind, key?: string): string | null {
  return readText(markPath(dir, kind, key));
}

/** Age of a mark in ms (mtime), or null when absent. */
export function markAgeMs(dir: string, kind: MarkKind, key: string | undefined, now: number = Date.now()): number | null {
  const m = mtimeMs(markPath(dir, kind, key));
  return m === null ? null : Math.max(0, now - m);
}

export function removeMark(dir: string, kind: MarkKind, key?: string): boolean {
  return removeFile(markPath(dir, kind, key));
}

/**
 * `createMark` that treats an existing mark older than `maxAgeMs` as gone: unlink and
 * retry `wx` once. An `asked` mark whose ask was denied (no landing edit, so no snooze)
 * would otherwise downgrade every later HOT verdict to context for the rest of the
 * session (§4.3 step 5, §6.4). A lost race yields at most one duplicate ask.
 */
export function renewMark(dir: string, kind: MarkKind, key: string | undefined, content: string, maxAgeMs: number, now: number = Date.now()): MarkResult {
  const first = createMark(dir, kind, key, content);
  if (first !== 'exists') return first;
  const age = markAgeMs(dir, kind, key, now);
  if (age === null) return createMark(dir, kind, key, content); // vanished between the two calls
  if (age < maxAgeMs) return 'exists';
  removeMark(dir, kind, key);
  return createMark(dir, kind, key, content);
}

/** Overwrite (or create) a mark's content — used to refresh `snooze` expiries. */
export function setMark(dir: string, kind: MarkKind, key: string | undefined, content: string): boolean {
  try {
    ensureDir(join(dir, SESSION_FILES.marksDir));
    writeFileSync(markPath(dir, kind, key), content);
    return true;
  } catch {
    return false;
  }
}

/** Parse an `asked` mark. */
export function readAskedMark(dir: string, key: string): AskedMark | null {
  const text = readMark(dir, 'asked', key);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isRecord(v) && typeof v['at'] === 'string' ? (v as unknown as AskedMark) : null;
  } catch {
    return null;
  }
}

/** Snooze expiry (epoch ms) for a key; null when no snooze or already expired. */
export function snoozeUntil(dir: string, key: string, now: number = Date.now()): number | null {
  const text = readMark(dir, 'snooze', key);
  const until = parseIso(text?.trim());
  if (until === null) return null;
  return until > now ? until : null;
}

/** The landing edit turns `asked` into a 30-min `snooze` (§4.5 step 1). Returns true when a snooze was written. */
export function promoteAskedToSnooze(dir: string, key: string, now: number = Date.now(), snoozeMs = 1_800_000): boolean {
  if (!hasMark(dir, 'asked', key)) return false;
  const ok = setMark(dir, 'snooze', key, nowIso(now + snoozeMs));
  removeMark(dir, 'asked', key);
  return ok;
}

/** All mark keys of a kind (e.g. every `asked.*`), for post-edit's "any dev" lookup. */
export function listMarks(dir: string, kind: MarkKind): string[] {
  try {
    return readdirSync(join(dir, SESSION_FILES.marksDir))
      .filter((f) => f === kind || f.startsWith(`${kind}.`))
      .map((f) => f.slice(kind.length + 1));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// lock (mkdir; 50 ms spin, 300 ms give-up, stale recovery)
// ---------------------------------------------------------------------------

export interface LockOptions {
  spinMs?: number;
  giveUpMs?: number;
  /** a lock dir older than this is considered abandoned and removed */
  staleMs?: number;
}

export interface LockState {
  locked: boolean;
}

/**
 * Run `fn` holding `sessions/<sid>/.lock`. After `giveUpMs` the function runs
 * lock-free (`locked: false`) — fail open, never hang (§4.0 rule 9).
 */
export async function withSessionLock<T>(dir: string, fn: (state: LockState) => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const spinMs = opts.spinMs ?? 50;
  const giveUpMs = opts.giveUpMs ?? 300;
  const staleMs = opts.staleMs ?? 10_000;
  const lock = join(dir, SESSION_FILES.lockDir);
  const started = Date.now();
  let locked = false;
  ensureDir(dir);
  while (!locked) {
    try {
      mkdirSync(lock);
      locked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') break;
      const age = Date.now() - (mtimeMs(lock) ?? Date.now());
      if (age > staleMs) {
        try {
          rmdirSync(lock);
        } catch {
          /* somebody else recovered it */
        }
        continue;
      }
      if (Date.now() - started >= giveUpMs) break;
      await sleep(spinMs);
    }
  }
  try {
    return await fn({ locked });
  } finally {
    if (locked) {
      try {
        rmdirSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}

/** `bg/<job>.<repoKey>.lock` single-flight worker lock, stale after 30 s (§4.12). Non-blocking: returns a release function or null when another worker holds it. */
export function acquireBgLock(home: string, job: string, repoKey: string, opts: { staleMs?: number; now?: number } = {}): (() => void) | null {
  const dir = join(home, LOCAL_PATHS.bgDir);
  const lock = join(dir, `${job}.${repoKey}.lock`);
  const staleMs = opts.staleMs ?? 30_000;
  ensureDir(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return () => {
        try {
          rmdirSync(lock);
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const age = (opts.now ?? Date.now()) - (mtimeMs(lock) ?? 0);
      if (age <= staleMs) return null;
      try {
        rmdirSync(lock);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// pending, draft
// ---------------------------------------------------------------------------

export function readPending(dir: string): string[] {
  const text = readText(join(dir, SESSION_FILES.pending));
  return text ? text.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/** Rewrite pending; an empty list deletes the file so guard-read.sh stays a 6 ms no-op (§4.4). */
export function writePending(dir: string, ids: readonly string[]): boolean {
  const path = join(dir, SESSION_FILES.pending);
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) {
    removeFile(path);
    return true;
  }
  try {
    ensureDir(dir);
    writeFileSync(path, unique.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

export function readDraft(dir: string): HandoffDraft | null {
  const v = readJson(join(dir, SESSION_FILES.draft));
  return isRecord(v) && v['quality'] === 'heuristic' && Array.isArray(v['done']) ? (v as unknown as HandoffDraft) : null;
}

export function writeDraft(dir: string, draft: HandoffDraft): boolean {
  let text = JSON.stringify(draft);
  if (byteLength(text) > LIMITS.draftBytes) {
    const slim: HandoffDraft = { ...draft, changed: draft.changed.slice(0, 40), done: draft.done.slice(0, 10), next: draft.next.slice(0, 10) };
    text = JSON.stringify(slim);
  }
  return writeJsonAtomic(join(dir, SESSION_FILES.draft), JSON.parse(text));
}

/** Sessions directories, for the liveness sweep and the 7-day purge. */
export function listSessionIds(home: string): string[] {
  try {
    return readdirSync(sessionsDir(home)).filter((d) => {
      try {
        return statSync(join(sessionsDir(home), d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// self-healing meta (§4.0 rule 10)
// ---------------------------------------------------------------------------

export interface EnsureMetaInput {
  home: string;
  sessionId: string;
  cwd: string;
  env: RelayEnv;
  team: TeamConfig | null;
  pid?: number | null;
  source?: SessionStartSource | null;
  model?: string | null;
  pluginSha?: string | null;
  /** rebuild even when meta exists and covers cwd (SessionStart) */
  force?: boolean;
  now?: number;
  signal?: AbortSignal;
}

export interface EnsureMetaResult {
  meta: SessionMeta;
  /** true when meta was (re)built from git this call */
  healed: boolean;
  config: LoadedRelayConfig | null;
  gitOk: boolean;
  /** the rev-parse phase timed out: `meta` is an in-memory guess and was NOT written (§4.0 rule 10) */
  provisional: boolean;
}

/**
 * Read meta.json; when missing, or when `cwd` lies outside `meta.repoRoot`,
 * rebuild it from three parallel rev-parse calls (<= 300 ms) and identity.
 * Covers fork sessions, killed SessionStarts, `/cd` and worktree entry.
 */
export async function ensureSessionMeta(input: EnsureMetaInput): Promise<EnsureMetaResult> {
  const dir = ensureSessionDir(input.home, input.sessionId);
  const existing = readMeta(dir);
  const cwdReal = realpathBestEffort(input.cwd);
  if (existing && !existing.provisional && !input.force && (isPathUnder(input.cwd, existing.repoRoot) || isPathUnder(cwdReal, realpathBestEffort(existing.repoRoot)))) {
    return { meta: existing, healed: false, config: null, gitOk: true, provisional: false };
  }
  const now = input.now ?? Date.now();
  const rp = await revParseSet(input.cwd, input.signal ? { signal: input.signal } : undefined);
  const gitOk = rp.toplevel !== null;
  // No toplevel because git was cut off (a short-deadline verb on a cold machine), not because cwd is
  // outside a repo: the slug/root below would be `local/<dir>` guesses. Such a meta must never be
  // persisted — later hooks would take the fast path above and post presence under the wrong repo.
  const provisional = rp.toplevel === null && rp.incomplete;
  const repoRoot = rp.toplevel ?? cwdReal;
  const originSlug = normalizeOriginUrl(rp.originUrl) ?? localSlug(repoRoot);
  const config = loadRelayConfig(repoRoot, { slug: originSlug, project: input.env.project });
  const slug = config.resolved.repo;
  const identity = resolveIdentity(input.home, {
    envDev: input.env.dev,
    team: input.team,
    gitEmail: rp.userEmail,
    user: input.env.user,
    hostname: input.env.hostname,
    now,
  });
  const sameRepoAndBranch = existing && existing.repo === slug && existing.branch === (rp.branch ?? existing.branch);
  const meta: SessionMeta = {
    v: 1,
    sessionId: input.sessionId,
    dev: identity.dev,
    identitySource: identity.source,
    repo: slug,
    project: config.resolved.project,
    repoKey: repoKey(slug),
    repoRoot,
    cwd: input.cwd,
    branch: rp.branch ?? existing?.branch ?? 'unknown',
    worktree: rp.toplevel ? worktreeName(rp.toplevel, rp.gitDir, rp.commonDir, input.cwd) : null,
    startSha: sameRepoAndBranch && existing?.startSha ? existing.startSha : rp.head,
    lastStopSha: sameRepoAndBranch ? (existing?.lastStopSha ?? null) : null,
    lastStopAt: existing?.lastStopAt ?? null,
    client: input.env.entrypoint === 'claude-desktop' ? 'desktop' : 'cli',
    host: input.env.hostname,
    pid: input.pid ?? input.env.pid ?? null,
    startedAt: existing?.startedAt ?? nowIso(now),
    source: input.source ?? existing?.source ?? null,
    gitEmail: rp.userEmail,
    gitEmails: identity.emails,
    configHash: config.hash,
    model: input.model ?? existing?.model ?? null,
    pluginSha: input.pluginSha ?? existing?.pluginSha ?? null,
  };
  if (provisional) {
    if (existing) return { meta: existing, healed: false, config: null, gitOk: false, provisional: true };
    return { meta: { ...meta, provisional: true }, healed: false, config, gitOk: false, provisional: true };
  }
  await withSessionLock(dir, () => writeMeta(dir, meta));
  return { meta, healed: true, config, gitOk, provisional: false };
}

/**
 * Did the SessionStart rev-parse phase leave holes (a timeout on a cold machine)?
 * `branch: unknown`, no start SHA, or no author-filter email: every later commit
 * would be misread as a branch switch and never attributed (§4.6, §4.8).
 */
export function isMetaIncomplete(meta: SessionMeta): boolean {
  return meta.branch === 'unknown' || meta.startSha === null || (meta.gitEmail === null && meta.gitEmails.length === 0);
}

export interface RepairMetaInput {
  home: string;
  sessionId: string;
  cwd: string;
  team: TeamConfig | null;
  now?: number;
  signal?: AbortSignal;
}

/**
 * Fill the holes of an incomplete meta.json from git, for async hooks and workers
 * only (sync verbs stay git-free, §4.0 rule 7). The identity handle never changes
 * here (the hub already knows the session under it); only branch, worktree, the
 * author-filter emails and the start SHA are patched. A missing start SHA is
 * reconstructed as HEAD at `startedAt` (`rev-list -1 --before`), so commits made
 * since the session began are still reported, and falls back to the current HEAD.
 */
export async function repairSessionMeta(input: RepairMetaInput): Promise<{ meta: SessionMeta | null; repaired: boolean }> {
  const dir = sessionDir(input.home, input.sessionId);
  const existing = readMeta(dir);
  if (!existing) return { meta: null, repaired: false };
  if (!isMetaIncomplete(existing)) return { meta: existing, repaired: false };
  const o = { timeoutMs: BUDGET_MS.gitDiff, ...(input.signal ? { signal: input.signal } : {}) };
  const rp = await revParseSet(input.cwd, o);
  if (!rp.toplevel) return { meta: existing, repaired: false };
  const patch: Partial<SessionMeta> = {};
  if (existing.branch === 'unknown' && rp.branch) {
    patch.branch = rp.branch;
    patch.worktree = worktreeName(rp.toplevel, rp.gitDir, rp.commonDir, input.cwd);
  }
  const email = existing.gitEmail ?? rp.userEmail;
  if (existing.gitEmail === null && rp.userEmail) patch.gitEmail = rp.userEmail;
  if (existing.gitEmails.length === 0 && email) patch.gitEmails = authorEmails(input.team, existing.dev, email);
  if (existing.startSha === null && rp.head) {
    patch.startSha = (await gitHeadBefore(input.cwd, existing.startedAt, o)) ?? rp.head;
  }
  if (Object.keys(patch).length === 0) return { meta: existing, repaired: false };
  const next = await withSessionLock(dir, () => {
    const cur = readMeta(dir) ?? existing;
    const merged: SessionMeta = { ...cur, ...patch };
    return writeMeta(dir, merged) ? merged : null;
  });
  return { meta: next ?? existing, repaired: next !== null };
}

/** Apply a branch/worktree change to meta under the lock (§4.6). */
export async function updateMetaBranch(
  dir: string,
  patch: Partial<Pick<SessionMeta, 'branch' | 'worktree' | 'startSha' | 'lastStopSha' | 'lastStopAt' | 'cwd' | 'repoRoot' | 'repo' | 'repoKey' | 'project' | 'configHash'>>,
): Promise<SessionMeta | null> {
  return withSessionLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return null;
    const next: SessionMeta = { ...meta, ...patch };
    return writeMeta(dir, next) ? next : null;
  });
}

/** Resolve config for a session from its meta (re-reads `.relay.json`; cheap). */
export function configForMeta(meta: SessionMeta): LoadedRelayConfig {
  return loadRelayConfig(meta.repoRoot, { slug: meta.repo, project: meta.project });
}

/** Objective-trail helper: the newest trail entry (head) or null. */
export function objectiveHead(fold: JournalFold): JournalObjective | null {
  return fold.objective.trail[0] ?? null;
}

/** Open (not retracted) contract records of this session by path. */
export function openContracts(fold: JournalFold): Record<string, JournalContract> {
  const out: Record<string, JournalContract> = {};
  for (const [path, c] of Object.entries(fold.contracts)) if (!c.retracted) out[path] = c;
  return out;
}

/** Sanity check used by tests and doctor: an IsoTime string. */
export function isIsoTime(x: unknown): x is IsoTime {
  return typeof x === 'string' && parseIso(x) !== null;
}
