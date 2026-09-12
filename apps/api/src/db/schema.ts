/**
 * Drizzle schema for the Relay hub — DESIGN.md §10.1, identical on Neon and PGlite.
 *
 * Ids are text: hub records carry the ID_PREFIX of protocol.ts, client events keep
 * their client ULID (the idempotency key). Timestamps are timestamptz in `date`
 * mode; every value the hub stamps comes from `hub.now()` (never SQL now()) so the
 * fake clock used by the tests and the "server-stamped time" rule (§10.1) hold.
 *
 * `events.type` carries 'cwd' in addition to the design list (protocol decision 1).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  ClientKind,
  ContractKind,
  Dependent,
  DevHandle,
  HandoffChangedFile,
  HandoffCommit,
  HandoffDraft,
  HandoffInterfaceChanged,
  HandoffNoteTo,
  HandoffQuality,
  HeatKind,
  ImpactPriority,
  ImpactStatus,
  IsoTime,
  NotificationKind,
  ObjectiveSource,
  RelayConfig,
  SessionEndReason,
  SessionState,
  EventType,
  DecisionSource,
  DeliveryVia,
} from '@relay/core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const devs = pgTable(
  'devs',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull(),
    handle: text('handle').notNull(),
    name: text('name'),
    github: text('github'),
    placeholder: boolean('placeholder').notNull().default(false),
    mergedInto: text('merged_into'),
    /** emails learned from identityHint.gitEmail — the hub-side author filter (§7.2) */
    emails: jsonb('emails').$type<string[]>().notNull().default([]),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
  },
  (t) => [uniqueIndex('devs_team_handle').on(t.teamId, t.handle)],
);

export const repos = pgTable(
  'repos',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull(),
    slug: text('slug').notNull(),
    project: text('project').notNull(),
    config: jsonb('config').$type<RelayConfig | null>(),
    configHash: text('config_hash'),
    firstSeenAt: ts('first_seen_at').notNull(),
  },
  (t) => [uniqueIndex('repos_team_slug').on(t.teamId, t.slug)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    devId: text('dev_id').notNull(),
    repoId: text('repo_id').notNull(),
    client: text('client').$type<ClientKind>().notNull(),
    host: text('host').notNull(),
    cwd: text('cwd').notNull(),
    branch: text('branch').notNull(),
    worktree: text('worktree'),
    startSha: text('start_sha'),
    model: text('model'),
    pluginSha: text('plugin_sha'),
    area: text('area'),
    objective: text('objective'),
    objectiveSource: text('objective_source').$type<ObjectiveSource>(),
    /** last persisted state; the authoritative state is derived at read time (§6.2) */
    state: text('state').$type<SessionState>().notNull().default('working'),
    startedAt: ts('started_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    lastEditAt: ts('last_edit_at'),
    lastPromptAt: ts('last_prompt_at'),
    inTurnSince: ts('in_turn_since'),
    endedAt: ts('ended_at'),
    endReason: text('end_reason').$type<SessionEndReason>(),
    editCount: integer('edit_count').notNull().default(0),
    promptCount: integer('prompt_count').notNull().default(0),
    commitCount: integer('commit_count').notNull().default(0),
    gitEmailHint: text('git_email_hint'),
    /** last 10 edited paths, newest first (§6.1 recentFiles) */
    recentFiles: jsonb('recent_files').$type<string[]>().notNull().default([]),
  },
  (t) => [index('sessions_repo_seen').on(t.repoId, t.lastSeenAt)],
);

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    at: ts('at').notNull(),
    serverAt: ts('server_at').notNull(),
    replay: boolean('replay').notNull().default(false),
    teamId: text('team_id').notNull(),
    repoId: text('repo_id').notNull(),
    devId: text('dev_id').notNull(),
    sessionId: text('session_id').notNull(),
    type: text('type').$type<EventType>().notNull(),
    path: text('path'),
    area: text('area'),
    sha: text('sha'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('events_repo_server_at').on(t.repoId, t.serverAt),
    index('events_session_server_at').on(t.sessionId, t.serverAt),
    // semantic idempotency: a commit/push SHA exists once per repo (§10.1)
    uniqueIndex('events_repo_type_sha')
      .on(t.repoId, t.type, t.sha)
      .where(sql`${t.type} in ('commit', 'push')`),
  ],
);

export const heat = pgTable(
  'heat',
  {
    repoId: text('repo_id').notNull(),
    path: text('path').notNull(),
    devId: text('dev_id').notNull(),
    sessionId: text('session_id').notNull(),
    branch: text('branch').notNull(),
    kind: text('kind').$type<HeatKind>().notNull(),
    /** server-stamped, only moves forward (GREATEST on upsert, §10.1) */
    lastAt: ts('last_at').notNull(),
    count: integer('count').notNull().default(1),
    pushed: boolean('pushed').notNull().default(false),
    blobId: text('blob_id'),
    headSha: text('head_sha'),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.path, t.sessionId, t.kind] }), index('heat_repo_last_at').on(t.repoId, t.lastAt)],
);

export const claims = pgTable('claims', {
  id: text('id').primaryKey(),
  repoId: text('repo_id').notNull(),
  devId: text('dev_id').notNull(),
  sessionId: text('session_id'),
  target: text('target').notNull(),
  note: text('note'),
  hard: boolean('hard').notNull().default(false),
  keep: boolean('keep').notNull().default(false),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  releasedAt: ts('released_at'),
});

export const changeSets = pgTable('change_sets', {
  id: text('id').primaryKey(),
  repoId: text('repo_id').notNull(),
  devId: text('dev_id').notNull(),
  sessionId: text('session_id').notNull(),
  branch: text('branch').notNull(),
  status: text('status').$type<ImpactStatus>().notNull(),
  priority: text('priority').$type<ImpactPriority>().notNull().default('low'),
  firstAt: ts('first_at').notNull(),
  lastAt: ts('last_at').notNull(),
  stableSince: ts('stable_since'),
  acked: jsonb('acked').$type<Record<DevHandle, IsoTime>>().notNull().default({}),
});

export const impacts = pgTable(
  'impacts',
  {
    id: text('id').primaryKey(),
    changeSetId: text('change_set_id').notNull(),
    repoId: text('repo_id').notNull(),
    devId: text('dev_id').notNull(),
    sessionId: text('session_id').notNull(),
    path: text('path').notNull(),
    symbols: jsonb('symbols').$type<string[]>().notNull().default([]),
    kinds: jsonb('kinds').$type<ContractKind[]>().notNull().default([]),
    summary: text('summary').notNull(),
    hunk: text('hunk'),
    hash: text('hash').notNull(),
    blobId: text('blob_id'),
    branch: text('branch').notNull(),
    status: text('status').$type<ImpactStatus>().notNull(),
    commitSha: text('commit_sha'),
    patchId: text('patch_id'),
    authorEmail: text('author_email'),
    rev: integer('rev').notNull().default(1),
    supersededBy: text('superseded_by'),
    /** in-repo dependents as the client reported them (null = grep timed out, §7.3) */
    dependents: jsonb('dependents').$type<string[] | null>(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('impacts_repo_session_path_hash').on(t.repoId, t.sessionId, t.path, t.hash),
    index('impacts_repo_path_updated').on(t.repoId, t.path, t.updatedAt),
  ],
);

export const impactTargets = pgTable(
  'impact_targets',
  {
    changeSetId: text('change_set_id').notNull(),
    devId: text('dev_id').notNull(),
    /** the repo the dependents live in (the receiver's repo, §7.4) */
    repoId: text('repo_id').notNull(),
    dependents: jsonb('dependents').$type<Dependent[]>().notNull().default([]),
    priority: text('priority').$type<ImpactPriority>().notNull(),
    deliveredAt: ts('delivered_at'),
    ackedAt: ts('acked_at'),
    ackNote: text('ack_note'),
  },
  (t) => [primaryKey({ columns: [t.changeSetId, t.devId, t.repoId] })],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull(),
    repoId: text('repo_id'),
    toDevId: text('to_dev_id').notNull(),
    fromDevId: text('from_dev_id'),
    kind: text('kind').$type<NotificationKind>().notNull(),
    refId: text('ref_id'),
    body: text('body').notNull(),
    noteKind: text('note_kind'),
    createdAt: ts('created_at').notNull(),
    deliveredAt: ts('delivered_at'),
    deliveredVia: text('delivered_via').$type<DeliveryVia>(),
  },
  (t) => [index('notifications_to_delivered').on(t.toDevId, t.deliveredAt)],
);

export const turns = pgTable(
  'turns',
  {
    sessionId: text('session_id').notNull(),
    promptId: text('prompt_id').notNull(),
    at: ts('at').notNull(),
    text: text('text').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.promptId] })],
);

export const handoffs = pgTable(
  'handoffs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().unique(),
    devId: text('dev_id').notNull(),
    repoId: text('repo_id').notNull(),
    project: text('project').notNull(),
    branch: text('branch').notNull(),
    worktree: text('worktree'),
    client: text('client').$type<ClientKind>().notNull().default('cli'),
    rev: integer('rev').notNull().default(1),
    quality: text('quality').$type<HandoffQuality>().notNull(),
    objective: text('objective'),
    areas: jsonb('areas').$type<string[]>().notNull().default([]),
    done: jsonb('done').$type<string[]>().notNull().default([]),
    changed: jsonb('changed').$type<HandoffChangedFile[]>().notNull().default([]),
    interfacesChanged: jsonb('interfaces_changed').$type<HandoffInterfaceChanged[]>().notNull().default([]),
    decisions: jsonb('decisions').$type<string[]>().notNull().default([]),
    blockers: jsonb('blockers').$type<string[]>().notNull().default([]),
    next: jsonb('next').$type<string[]>().notNull().default([]),
    commits: jsonb('commits').$type<HandoffCommit[]>().notNull().default([]),
    notesTo: jsonb('notes_to').$type<HandoffNoteTo[]>().notNull().default([]),
    markdown: text('markdown').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    endReason: text('end_reason').$type<SessionEndReason>(),
    generatedAt: ts('generated_at').notNull(),
  },
  (t) => [index('handoffs_project_generated').on(t.project, t.generatedAt)],
);

export const handoffDrafts = pgTable('handoff_drafts', {
  sessionId: text('session_id').primaryKey(),
  at: ts('at').notNull(),
  draft: jsonb('draft').$type<HandoffDraft>().notNull(),
});

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull(),
    project: text('project').notNull(),
    devId: text('dev_id').notNull(),
    sessionId: text('session_id'),
    topic: text('topic'),
    area: text('area'),
    text: text('text').notNull(),
    source: text('source').$type<DecisionSource>().notNull(),
    confidence: real('confidence').notNull().default(1),
    supersedes: text('supersedes'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('decisions_project_created').on(t.project, t.createdAt)],
);

export const devRepo = pgTable(
  'dev_repo',
  {
    devId: text('dev_id').notNull(),
    repoId: text('repo_id').notNull(),
    homeAreas: jsonb('home_areas').$type<string[]>().notNull().default([]),
    lastSeenAt: ts('last_seen_at').notNull(),
    lastSessionEndAt: ts('last_session_end_at'),
  },
  (t) => [primaryKey({ columns: [t.devId, t.repoId] })],
);

export const depindex = pgTable('depindex', {
  repoId: text('repo_id').primaryKey(),
  head: text('head').notNull(),
  builtAt: ts('built_at').notNull(),
  imports: jsonb('imports').$type<Record<string, string[]>>().notNull().default({}),
  symbols: jsonb('symbols').$type<Record<string, string[]>>().notNull().default({}),
  contractPaths: jsonb('contract_paths').$type<Record<string, string[]>>().notNull().default({}),
});

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
});

export type TeamRow = typeof teams.$inferSelect;
export type DevRow = typeof devs.$inferSelect;
export type RepoRow = typeof repos.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type HeatRow = typeof heat.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ChangeSetRow = typeof changeSets.$inferSelect;
export type ImpactRow = typeof impacts.$inferSelect;
export type ImpactTargetRow = typeof impactTargets.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type HandoffRow = typeof handoffs.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type DevRepoRow = typeof devRepo.$inferSelect;
export type DepindexRow = typeof depindex.$inferSelect;
