/**
 * Objective derivation (§5.1): task subject > prompt heuristic > branch name.
 * Deterministic, no LLM. `candidateFromPrompt` applies the rejection rules;
 * `nextObjective` applies the replacement rules; `deriveObjective` picks the
 * presence value from the fold.
 */
import { LIMITS, type JournalFold, type ObjectiveSource } from './protocol.js';
import { parseIso, truncateWords } from './util.js';

const STOPLIST = /^(y|yes|no|ok|okay|sure|go ahead|continue|proceed|thanks|thank you|do it|next|k|nope|yep|yeah|please)\b/i;
const IMPERATIVE =
  /^(add|fix|implement|refactor|update|remove|rename|migrate|write|build|create|change|make|move|wire|investigate|debug|test|convert|extract|split|merge|document|deploy)\b/i;
const PIVOT = /\b(now|next|instead|switch to)\b/i;

export const OBJECTIVE_REPLACE_AFTER_MS = 10 * 60_000;
export const OBJECTIVE_REPLACE_AFTER_TOOL_CALLS = 15;

/** Strip fences, paths, URLs, @mentions and stack-trace lines from a prompt; first line only (§5.1 step 2). */
export function cleanPromptLine(prompt: string): string {
  let text = prompt.replace(/\r/g, '');
  text = text.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' ');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\s*at\s+\S/.test(l) && !/^(Traceback|File ".*", line \d+)/.test(l));
  let first = lines[0] ?? '';
  first = first
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:^|\s)@[\w./-]+/g, ' ')
    .replace(/(?:^|\s)(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g, ' ')
    .replace(/`[^`]*`/g, (m) => (m.length > 40 ? ' ' : m))
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return first;
}

/** Ratio of non-alphabetic characters (pasted logs / JSON detection). */
export function nonAlphaRatio(text: string): number {
  if (!text.length) return 1;
  const alpha = (text.match(/[A-Za-z]/g) ?? []).length;
  return 1 - alpha / text.length;
}

export interface PromptCandidateOptions {
  /** the last assistant message ended with "?" (an answer is not an objective) */
  lastTurnWasQuestion?: boolean;
}

/** The prompt-derived candidate or null when rejected (§5.1 step 2). */
export function candidateFromPrompt(prompt: string, opts: PromptCandidateOptions = {}): string | null {
  const raw = prompt.trimStart();
  if (raw.startsWith('/') || /^\[private\]/i.test(raw)) return null;
  const line = cleanPromptLine(prompt);
  if (line.length < 25) return null;
  if (STOPLIST.test(line)) return null;
  if (nonAlphaRatio(line) >= 0.4) return null;
  if (opts.lastTurnWasQuestion && line.length < 60) return null;
  return truncateWords(line, LIMITS.objectiveChars);
}

/** `feat/dashboard-filters` -> `dashboard filters`; default branches -> null (§5.1 step 4). */
export function humanizeBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  if (/^(main|master|develop|dev|trunk|head)$/i.test(branch) || branch.startsWith('detached@')) return null;
  const segments = branch.split('/').filter(Boolean);
  // drop a leading type or user prefix (`feat/`, `deepak/`): short, purely alphabetic
  while (segments.length > 1 && /^[a-z]{1,12}$/i.test(segments[0] ?? '')) segments.shift();
  const s = segments.join(' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length ? truncateWords(s, LIMITS.objectiveChars) : null;
}

/** Branch-source objective: humanized branch or `working in <repo>`. */
export function objectiveFromBranch(branch: string | null | undefined, repoSlug: string): string {
  const h = humanizeBranch(branch);
  if (h) return h;
  const name = repoSlug.split('/').pop() || repoSlug;
  return `working in ${name}`;
}

export interface CurrentObjective {
  text: string | null;
  source: ObjectiveSource | null;
  at: string | null;
  toolCallsSince: number;
}

/**
 * Should `candidate` (from a prompt) replace the current prompt objective?
 * Task objectives are handled by `deriveObjective`; this only governs the
 * prompt trail (§5.1 replacement rules). Returns the text to record or null.
 */
export function nextPromptObjective(current: CurrentObjective, candidate: string | null, now: number = Date.now()): string | null {
  if (!candidate) return null;
  if (!current.text || current.source === 'branch' || current.source === null) return candidate;
  if (candidate === current.text) return null;
  if (IMPERATIVE.test(candidate) || PIVOT.test(candidate)) return candidate;
  const setAt = parseIso(current.at);
  if (setAt !== null && now - setAt >= OBJECTIVE_REPLACE_AFTER_MS) return candidate;
  if (current.toolCallsSince >= OBJECTIVE_REPLACE_AFTER_TOOL_CALLS) return candidate;
  return null;
}

export interface DerivedObjective {
  text: string;
  source: ObjectiveSource;
}

/** The live presence objective: open task > prompt trail head > branch (§5.1). */
export function deriveObjective(
  fold: Pick<JournalFold, 'tasks' | 'objective'>,
  ctx: { branch: string | null; repoSlug: string; objectiveFromPrompts?: boolean },
): DerivedObjective {
  const openTask = fold.tasks.open[fold.tasks.open.length - 1];
  if (openTask && openTask.subject.trim()) return { text: truncateWords(openTask.subject.trim(), LIMITS.objectiveChars), source: 'task' };
  if (ctx.objectiveFromPrompts !== false && fold.objective.text && fold.objective.source !== 'branch') {
    return { text: fold.objective.text, source: fold.objective.source ?? 'prompt' };
  }
  return { text: objectiveFromBranch(ctx.branch, ctx.repoSlug), source: 'branch' };
}
