/**
 * Anthropic client wrapper for tier-2 handoff synthesis (§8.2): one Messages API
 * request with structured output (`output_config.format` = JSON schema of §8.3),
 * a cached stable system prompt, `max_tokens: 2048`, 20 s timeout, no tools.
 * `createLlm(env)` returns null when ANTHROPIC_API_KEY is absent so the heuristic
 * tier stands on its own.
 */
import Anthropic from '@anthropic-ai/sdk';
import { isHandoffBody, type HandoffBody } from '@relay/core';

export interface HandoffPacket {
  dev: string;
  project: string;
  repo: string;
  branch: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  objective: string | null;
  objectiveTrail: string[];
  areas: string[];
  edited: Array<{ path: string; area: string | null; edits: number }>;
  contracts: Array<{
    path: string;
    symbols: string[];
    summary: string;
    status: string;
    commitSha: string | null;
    hunk: string | null;
    changeSetId?: string | null;
    impactId?: string | null;
  }>;
  commits: Array<{ sha: string; subject: string; pushed: boolean }>;
  tasksDone: string[];
  decisions: string[];
  turns: Array<{ at: string; text: string }>;
  draft: HandoffBody | null;
}

export interface LlmClient {
  model: string;
  synthesize: (packet: HandoffPacket, signal?: AbortSignal) => Promise<HandoffBody | null>;
}

export const DEFAULT_HANDOFF_MODEL = 'claude-haiku-4-5';
export const LLM_TIMEOUT_MS = 20_000;

/** JSON schema of HandoffBody (§8.3) for `output_config.format`. */
export const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: { type: ['string', 'null'], description: 'Imperative phrase, <= 140 chars, what the session set out to do' },
    areas: { type: 'array', items: { type: 'string' } },
    done: { type: 'array', items: { type: 'string' }, description: 'What was completed, factual, <= 140 chars each' },
    changed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          area: { type: ['string', 'null'] },
          edits: { type: 'integer' },
          why: { type: ['string', 'null'] },
        },
        required: ['path', 'area', 'edits', 'why'],
      },
    },
    interfaces_changed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changeSetId: { type: ['string', 'null'] },
          impactId: { type: ['string', 'null'] },
          path: { type: 'string' },
          symbols: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          status: { type: 'string', enum: ['uncommitted', 'committed', 'pushed', 'merged', 'withdrawn'] },
          commitSha: { type: ['string', 'null'] },
        },
        required: ['changeSetId', 'impactId', 'path', 'symbols', 'summary', 'status', 'commitSha'],
      },
    },
    decisions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { sha: { type: 'string' }, subject: { type: 'string' }, pushed: { type: 'boolean' } },
        required: ['sha', 'subject', 'pushed'],
      },
    },
    notes_to: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dev: { type: 'string' },
          intent: { type: 'string', enum: ['action', 'feedback', 'fyi'] },
          text: { type: 'string' },
        },
        required: ['dev', 'intent', 'text'],
      },
    },
  },
  required: ['objective', 'areas', 'done', 'changed', 'interfaces_changed', 'decisions', 'blockers', 'next', 'commits', 'notes_to'],
} as const;

const SYSTEM_PROMPT = `You write structured engineering handoffs for a small team that shares repositories.
Input: one developer's session record — objective trail, edited files, contract changes with symbols and diff hunks, own commits, completed tasks, and the prose of the assistant's replies. No transcript is available.
Output: the handoff JSON. Rules: state facts only; keep every string under 160 characters; "done" lists finished work, "next" lists concrete remaining steps, "blockers" only real blockers, "decisions" only choices that constrain teammates; keep "changed", "interfaces_changed" and "commits" from the record, adding a short "why" per changed file when the record supports it; "notes_to" addresses teammates by handle only when the record names a dependency on their area; never invent files, symbols or commits.`;

export function createLlm(env: NodeJS.ProcessEnv): LlmClient | null {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;
  const model = env['RELAY_HANDOFF_MODEL'] ?? DEFAULT_HANDOFF_MODEL;
  const client = new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
  return {
    model,
    async synthesize(packet, signal) {
      const response = await client.messages.create(
        {
          model,
          max_tokens: 2048,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: JSON.stringify(packet) }],
          output_config: { format: { type: 'json_schema', schema: HANDOFF_SCHEMA as unknown as Record<string, unknown> } },
        },
        { timeout: LLM_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      if (response.stop_reason === 'refusal') return null;
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return parseHandoffJson(text);
    },
  };
}

export function parseHandoffJson(text: string): HandoffBody | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isHandoffBody(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
