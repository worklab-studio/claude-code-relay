/**
 * Relay protocol: every wire and file type shared by the client (hook bundle,
 * MCP server) and the hub (apps/api). Derived from DESIGN.md v1.1; each type
 * cites its section. Where DESIGN.md and docs/research/hooks.md disagree on a
 * Claude Code hook field, the research note wins (see section 12 below).
 *
 * Rules for this file:
 *  - No imports. It is bundled into the zero-dependency hook bundle (§2.2).
 *  - Types only, plus small constants and cheap structural type guards.
 *  - Timestamps are ISO-8601 UTC strings. Hub-stamped fields are `serverAt` /
 *    `serverTime`; client-stamped ones are `at` / `fetchedAt`. Ages are always
 *    same-clock differences (§4.0 rule 16).
 *  - Paths on the wire are repo-relative POSIX paths (§5.3).
 *  - Ids: client events, outbox entries and marks use bare ULIDs; hub records
 *    carry a typed prefix (ID_PREFIX).
 */

// ---------------------------------------------------------------------------
// 1. Versions, ids, headers, shared constants
// ---------------------------------------------------------------------------

/** Wire protocol version carried as `v` in bodies and `X-Relay-Proto` (§3.4, §10.4). */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** ISO-8601 UTC timestamp, e.g. "2026-09-12T09:41:07.123Z" (§4.0 rule 16). */
export type IsoTime = string;
/** Full 40-char git object id (commit or blob) unless stated otherwise. */
export type Sha = string;
/** Developer handle from team.json (or a `unknown-<6hex>` placeholder, §3.3). */
export type DevHandle = string;
/** Normalized repo slug: `github.com/acme/app` or `local/<basename>` (§5.3). */
export type RepoSlug = string;
/** `sha1(repoSlug).slice(0, 12)` — the cache directory key (§4.0 rule 8). */
export type RepoKey = string;

/** Id prefixes for hub records; client event ids are bare ULIDs (§7.5, §8.3, §10.1). */
export const ID_PREFIX = {
  impact: 'imp_',
  changeSet: 'cs_',
  handoff: 'hnd_',
  claim: 'clm_',
  decision: 'dec_',
  notification: 'ntf_',
} as const;

/** Request headers (§10.4). `Authorization: Bearer <team token>` is the standard header. */
export const RELAY_HEADERS = {
  dev: 'x-relay-dev',
  session: 'x-relay-session',
  client: 'x-relay-client',
  proto: 'x-relay-proto',
  plugin: 'x-relay-plugin',
  /** Response header set by the hub when the previous token authenticated (§3.3). */
  warn: 'x-relay-warn',
} as const;

/** Value of `X-Relay-Client` (§10.4). */
export type RequestClient = 'cli' | 'desktop' | 'mcp';
/** Claude Code client kind stored on sessions (§5.3). */
export type ClientKind = 'cli' | 'desktop';

/** Hub response statuses the client treats specially (§4.0 rule 5, §10.4). */
export const HTTP_STATUS = {
  badToken: 401,
  payloadTooLarge: 413,
  clientTooOld: 426,
  rateLimited: 429,
} as const;

/** Hook verbs implemented by dist/hook.mjs (§2.2). */
export type HookVerb =
  | 'session-start'
  | 'prompt'
  | 'pre-edit'
  | 'pre-read'
  | 'post-edit'
  | 'post-git'
  | 'task-created'
  | 'task-completed'
  | 'cwd'
  | 'stop'
  | 'session-end'
  | 'mute'
  | 'bg';

/** Detached background jobs, `hook.mjs bg <job>` (§4.12). */
export type BgJob = 'session-start' | 'prompt' | 'refresh' | 'session-end';

/** Internal deadlines per verb, always below the declared hook timeout (§4.0 rule 1, §4.10). */
export const DEADLINE_MS = {
  'session-start': 3500,
  'session-start-compact': 800,
  prompt: 2000,
  'pre-edit': 900,
  'pre-read': 600,
  'post-edit': 6000,
  'post-git': 6000,
  'task-created': 300,
  'task-completed': 300,
  cwd: 1500,
  stop: 5000,
  'session-end': 600,
  bg: 15000,
} as const;

/** Network / git budgets (§4.1–§4.9, §7.3, §9.1). */
export const BUDGET_MS = {
  sessionStartPost: 3000,
  promptRefresh: 800,
  promptRefreshAfterPause: 1500,
  workerPost: 3000,
  sessionEndPost: 5000,
  mcpFetch: 5000,
  gitRevParse: 300,
  gitDiff: 1000,
  gitGrep: 2000,
} as const;

/** Circuit breaker and refresh policy (§4.0 rule 5, §4.2, §4.3). */
export const BREAKER = {
  /** consecutive worker failures that open the breaker */
  failuresToOpen: 2,
  openMs: 60_000,
  /** 401 / 426 / 413 are configuration errors, not outages */
  configErrorMs: 600_000,
  /** default snapshot TTL on the prompt path; RELAY_SNAPSHOT_TTL_MS overrides */
  snapshotTtlMs: 60_000,
  /** pre-edit spawns `bg refresh` when the cache is older than this */
  preEditRefreshMs: 120_000,
  /** ...unless a refresh-wanted marker younger than this exists */
  refreshWantedDebounceMs: 10_000,
  /** the prompt path uses the longer budget when the cache is older than this */
  pauseMs: 300_000,
} as const;

/** Staleness ladder and collision windows (§6.3, §6.4, §6.5). */
export const STALENESS = {
  /** full policy (deny/ask/context) while the snapshot is at most this old */
  fullPolicyMs: 300_000,
  /** deny -> ask, ask -> context between fullPolicyMs and this */
  degradedMs: 900_000,
  /** a HOT verdict needs an edit heat entry at most this old */
  heatHotMs: 900_000,
  /** an implicit file claim needs the other session seen within this window */
  implicitClaimSeenMs: 1_800_000,
  /** warm heat window */
  warmMs: 86_400_000,
  /** SAME_DEV note window */
  sameDevMs: 600_000,
  /** an `asked` mark with no landing edit expires after this */
  askedExpiryMs: 120_000,
  /** a landing edit turns `asked` into a snooze of this length */
  snoozeMs: 1_800_000,
} as const;

/** Presence state thresholds (§6.2). */
export const PRESENCE = {
  workingMs: 180_000,
  idleMs: 1_800_000,
  awayMs: 7_200_000,
  inTurnCapMs: 7_200_000,
  sweepIntervalMs: 60_000,
} as const;

/** Size caps shared by both sides (§4.0 rule 3, §4.2–§4.8, §9.3, §10.4). */
export const LIMITS = {
  hookStdoutChars: 9000,
  preToolUseContextChars: 4000,
  promptInboxChars: 1500,
  digestChars: 6000,
  deltaDigestChars: 2000,
  compactReinjectChars: 1500,
  hunkChars: 1500,
  turnTextChars: 3000,
  promptWireChars: 2000,
  objectiveChars: 140,
  draftBytes: 8192,
  journalLineBytes: 4096,
  journalRotateBytes: 65_536,
  outboxDrainPerRun: 200,
  outboxInFlightMs: 30_000,
  outboxEphemeralMaxAgeMs: 86_400_000,
  outboxMaxAgeMs: 604_800_000,
  payloadMaxBytes: 262_144,
  /** client-side cap: a body this large is split or shrunk locally instead of drawing a 413 (§10.4) */
  payloadClientMaxBytes: 245_760,
  /** commits per POST when backfilling own commits (§4.1 step 6) */
  commitsPerPost: 10,
  /** files per commit on the wire (heat + attribution; the full list stays in git) */
  commitFilesOnWire: 50,
  /** outbox entries are dropped after this many failed sends (§4.0 rule 6) */
  outboxMaxAttempts: 8,
  dependentsCap: 50,
  dirtyPathsCap: 200,
  recentShas: 20,
  commitBackfillCap: 50,
  recentFiles: 10,
  heatEditCap: 300,
  heatCommitCap: 100,
  heatDirtyCap: 100,
  changeSetMergeWindowMs: 1_800_000,
  changeSetExpiryMs: 604_800_000,
  digestChangeSets: 5,
  digestDiffBlocks: 3,
  digestMessages: 10,
  digestHandoffs: 3,
  digestDecisions: 5,
  jitChangeSetsPerHook: 2,
  turnsPerSession: 40,
  turnsInPacket: 12,
  claimMaxTtlMs: 86_400_000,
  claimDefaultTtlMs: 14_400_000,
  tokenGraceMs: 1_209_600_000,
} as const;

// ---------------------------------------------------------------------------
// 2. Team and identity
// ---------------------------------------------------------------------------

/** One entry of team.json `members` (§2.3, §3.3). */
export interface TeamMember {
  name: string;
  emails: string[];
  github?: string;
}

/** packages/plugin/team.json (§2.3). `RELAY_HUB` / `RELAY_TOKEN` override hub/token (§4.0). */
export interface TeamConfig {
  hub: string;
  team: string;
  token: string;
  marketplace?: string;
  members: Record<DevHandle, TeamMember>;
}

/** Where the identity came from, in §3.3 priority order. */
export type IdentitySource =
  | 'env'
  | 'identity-file'
  | 'git-email'
  | 'github-noreply'
  | 'email-local'
  | 'user'
  | 'placeholder';

/** ~/.relay/identity.json (§3.3, §10.3). */
export interface IdentityFile {
  dev: DevHandle;
  source: IdentitySource;
  at: IsoTime;
  /** git email observed when cached; a change forces re-evaluation (§3.3). */
  gitEmail?: string | null;
}

/** Placeholder handle shape for unknown developers (§3.3 step 7). */
export const PLACEHOLDER_PREFIX = 'unknown-' as const;

// ---------------------------------------------------------------------------
// 3. .relay.json (area/ownership map) and its defaults
// ---------------------------------------------------------------------------

/** One area of `.relay.json.areas` (§5.4). */
export interface RelayArea {
  paths: string[];
  owners?: DevHandle[];
  /** shared areas (contracts, migrations) never win the area vote alone (§5.2) */
  shared?: boolean;
}

/** `.relay.json.contracts` (§5.4, §7.1, §7.3). */
export interface RelayContractsConfig {
  /** `"+glob"` entries prepend to DEFAULT_CONTRACT_GLOBS; plain entries replace them */
  globs?: string[];
  /** workspace/npm names other repos import from */
  packages?: string[];
  /** exported-symbol heuristic on .ts/.tsx/.js/.mjs/.py/.go files */
  export_scan?: boolean;
  /** narrows schema-type files with no importers to areas (§7.3) */
  consumers?: Record<string, string[]>;
}

/** `.relay.json.impacts` (§5.4, §7.5 step 7). */
export interface RelayImpactsConfig {
  debounce_minutes?: number;
}

/** Collision policy values (§5.4, §6.4). */
export type CollisionPolicy = 'ask' | 'deny' | 'context' | 'note' | 'off';

/** `.relay.json.collision` (§5.4). */
export interface RelayCollisionConfig {
  hot?: CollisionPolicy;
  claimed?: CollisionPolicy;
  warm?: CollisionPolicy;
  same_dev?: CollisionPolicy;
}

/** `privacy.send_turns` (§11.1). */
export type SendTurns = 'prose' | 'full' | false;
/** `privacy.send_diffs` (§11.1). */
export type SendDiffs = 'contracts' | 'none';

/** `.relay.json.privacy` (§5.4, §11.1). */
export interface RelayPrivacyConfig {
  send_prompts?: boolean;
  send_turns?: SendTurns;
  send_diffs?: SendDiffs;
  objective_from_prompts?: boolean;
}

/** `.relay.json.handoff` (§5.4, §8.1, §8.2). */
export interface RelayHandoffConfig {
  llm?: boolean;
  idle_minutes?: number;
}

/** `.relay.json` as committed at a repo root; every key optional (§5.4). */
export interface RelayConfig {
  project?: string;
  repo?: RepoSlug;
  areas?: Record<string, RelayArea>;
  contracts?: RelayContractsConfig;
  /** area -> areas it consumes (cross-repo fallback, §7.5 step 4) */
  depends?: Record<string, string[]>;
  impacts?: RelayImpactsConfig;
  collision?: RelayCollisionConfig;
  privacy?: RelayPrivacyConfig;
  handoff?: RelayHandoffConfig;
}

/** Effective config after defaults; what `snapshot.repo.config` carries (§5.4, §10.2). */
export interface RelayConfigResolved {
  project: string;
  repo: RepoSlug;
  areas: Record<string, RelayArea>;
  contracts: Required<RelayContractsConfig>;
  depends: Record<string, string[]>;
  impacts: Required<RelayImpactsConfig>;
  collision: Required<RelayCollisionConfig>;
  privacy: Required<RelayPrivacyConfig>;
  handoff: Required<RelayHandoffConfig>;
}

/** Default contract path globs (§7.1). */
export const DEFAULT_CONTRACT_GLOBS: readonly string[] = [
  '**/contracts/**',
  '**/shared/**',
  'packages/*/src/index.ts',
  '**/*.contract.{ts,js}',
  '**/types/**',
  '**/*.d.ts',
  '**/schema.prisma',
  '**/*.prisma',
  '**/migrations/**',
  '**/openapi*.{json,yaml,yml}',
  '**/swagger*.{json,yaml,yml}',
  '**/*.graphql',
  '**/*.proto',
  '**/*.schema.{ts,json}',
  '**/api/**/route.ts',
  '**/routes/**',
  '**/zod/**',
  '**/*.env.example',
];

/** Basenames excluded from cross-repo `contractPaths` matching (§7.4). */
export const GENERIC_BASENAMES: readonly string[] = [
  'index',
  'types',
  'schema',
  'route',
  'routes',
  'client',
  'api',
  'utils',
  'constants',
];

/** Defaults applied when `.relay.json` is absent or partial (§5.4). */
export const RELAY_CONFIG_DEFAULTS = {
  contracts: {
    globs: DEFAULT_CONTRACT_GLOBS as string[],
    packages: [] as string[],
    export_scan: true,
    consumers: {} as Record<string, string[]>,
  },
  impacts: { debounce_minutes: 3 },
  collision: { hot: 'ask', claimed: 'ask', warm: 'context', same_dev: 'note' },
  privacy: {
    send_prompts: false,
    send_turns: 'prose',
    send_diffs: 'contracts',
    objective_from_prompts: true,
  },
  handoff: { llm: true, idle_minutes: 20 },
} satisfies Pick<RelayConfigResolved, 'contracts' | 'impacts' | 'collision' | 'privacy' | 'handoff'>;

/** Per-machine mute targets, ~/.relay/mute/<repoKey>.json (§5.4, §9.2 /relay:mute). */
export interface MuteFile {
  v: 1;
  targets: MuteTarget[];
}

/** One `/relay:mute <path|glob|area|@dev>` entry. */
export interface MuteTarget {
  target: string;
  kind: 'path' | 'glob' | 'area' | 'dev';
  at: IsoTime;
}

// ---------------------------------------------------------------------------
// 4. Session, repo and git descriptors
// ---------------------------------------------------------------------------

/** SessionStart `source` as verified in docs/research/hooks.md (§4.1). */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork';

/** Claude Code's own SessionEnd reasons (docs/research/hooks.md §4.2). */
export type ClaudeSessionEndReason = 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other';

/** Stored end reason: Claude's reasons plus the two Relay-generated ones (§4.9, §6.2, §10.1). */
export type SessionEndReason = ClaudeSessionEndReason | 'crash' | 'timeout';

/** Repo identity as sent on session start (§4.1 step 3, §5.3). */
export interface RepoDescriptor {
  slug: RepoSlug;
  /** absent since v1.1 review: the absolute checkout path carries the OS user name and nothing on the hub reads it (§11.1) */
  root?: string;
  /** `.relay.json.project` or the default (origin owner/name); null lets the hub derive it */
  project: string | null;
  /** the raw .relay.json (uploaded once per hash) or null when absent */
  config: RelayConfig | null;
  configHash: string | null;
}

/** `session` object of POST /v1/session/start (§4.1 step 3). */
export interface SessionDescriptor {
  id: string;
  source: SessionStartSource;
  client: ClientKind;
  host: string;
  cwd: string;
  repo: RepoDescriptor;
  branch: string;
  worktree: string | null;
  startSha: Sha | null;
  model: string | null;
  /** `basename(CLAUDE_PLUGIN_ROOT)`; also sent as X-Relay-Plugin (§3.4) */
  pluginSha?: string | null;
}

/** Presence fields carried by every POST /v1/events (§6.1, §10.4). Optional fields let the hub lazily create a session row that SessionStart never registered (§4.0 rule 10). */
export interface SessionPresence {
  id: string;
  repo: RepoSlug;
  branch: string;
  worktree: string | null;
  area: string | null;
  objective: string | null;
  objectiveSource: ObjectiveSource | null;
  cwd?: string;
  client?: ClientKind;
  host?: string;
  project?: string | null;
  startSha?: Sha | null;
  pluginSha?: string | null;
}

/** Identity hint sent on session start (§3.3, §4.1 step 3). */
export interface IdentityHint {
  gitEmail: string | null;
  /** previous placeholder handle to merge into X-Relay-Dev (§3.3 step 7) */
  placeholder?: string;
  source?: IdentitySource;
}

// ---------------------------------------------------------------------------
// 5. Presence and the snapshot document
// ---------------------------------------------------------------------------

/** Presence states derived at read time from hub timestamps (§6.2). */
export type SessionState = 'working' | 'idle' | 'away' | 'gone';

/** Objective provenance (§5.1). */
export type ObjectiveSource = 'task' | 'prompt' | 'llm' | 'branch';

/** One presence record per Claude session, never typed (§6.1). */
export interface PresenceRecord {
  dev: DevHandle;
  sessionId: string;
  client: ClientKind;
  host: string;
  repo: RepoSlug;
  project: string;
  branch: string;
  worktree: string | null;
  area: string | null;
  objective: string | null;
  objectiveSource: ObjectiveSource | null;
  state: SessionState;
  startedAt: IsoTime;
  lastSeenAt: IsoTime;
  lastEditAt: IsoTime | null;
  /** set on prompt, cleared on turn_end; "in a long turn" while set (§6.2) */
  inTurnSince: IsoTime | null;
  editCount: number;
  recentFiles: string[];
  pluginSha?: string | null;
  endedAt?: IsoTime | null;
  endReason?: SessionEndReason | null;
}

/** `snapshot.sessions[]` — live sessions in this project, 2 h window, mine included (§10.2). */
export interface SnapshotSession {
  dev: DevHandle;
  id: string;
  client: ClientKind;
  host: string;
  branch: string;
  worktree: string | null;
  area: string | null;
  objective: string | null;
  state: SessionState;
  lastSeenAt: IsoTime;
  lastEditAt: IsoTime | null;
  inTurnSince: IsoTime | null;
  /** repo slug; sessions of the other repos of the project carry theirs */
  repo?: RepoSlug;
}

/** Heat kinds (§6.3, §10.1). */
export type HeatKind = 'edit' | 'dirty' | 'commit';

/** `snapshot.heat[]` — this repo, 24 h, own sessions tagged `mine` (§10.2). */
export interface HeatEntry {
  path: string;
  dev: DevHandle;
  sessionId: string;
  mine: boolean;
  branch: string;
  objective: string | null;
  kind: HeatKind;
  /** hub-stamped `serverAt` (§4.0 rule 16) */
  at: IsoTime;
  pushed: boolean;
  headSha: Sha | null;
  blobId: Sha | null;
  count?: number;
}

/** `snapshot.claims[]` — other developers' unexpired explicit claims (§6.3, §10.2). */
export interface SnapshotClaim {
  id: string;
  dev: DevHandle;
  target: string;
  note: string | null;
  hard: boolean;
  expiresAt: IsoTime;
}

/** Impact / change-set status ladder (§7.2, §10.1). */
export type ImpactStatus = 'uncommitted' | 'committed' | 'pushed' | 'merged' | 'withdrawn';

/** Routing priority (§7.5 step 6). */
export type ImpactPriority = 'high' | 'normal' | 'low';

/** How a dependent was found (§7.5 step 3, §10.1 impact_targets). */
export type DependentVia = 'import' | 'depends' | 'basename';

/** One dependent file of a change set (§7.5, §10.2). */
export interface Dependent {
  path: string;
  area: string | null;
  via: DependentVia;
  /** present on cross-repo views (§7.4); absent when filtered to one repo */
  repo?: RepoSlug;
}

/** `snapshot.changeSets[].impacts[]` (§10.2). */
export interface SnapshotImpact {
  id: string;
  rev: number;
  path: string;
  symbols: string[];
  summary: string;
  hunk: string | null;
  blobId: Sha | null;
  commitSha: Sha | null;
  status: ImpactStatus;
}

/** `snapshot.changeSets[]` — targeting me, routable, unacked, <= 7 d; dependents filtered to THIS repo (§10.2). */
export interface SnapshotChangeSet {
  id: string;
  by: DevHandle;
  branch: string;
  status: ImpactStatus;
  priority: ImpactPriority;
  /** hub-stamped last update */
  at: IsoTime;
  impacts: SnapshotImpact[];
  dependents: Dependent[];
  /** source repo of the change (differs from the snapshot repo for cross-repo change sets) */
  repo?: RepoSlug;
}

/** Notification kinds (§10.1). */
export type NotificationKind = 'impact' | 'note' | 'collision' | 'handoff';

/** `notify` message kinds (§9.2). */
export type NoteKind = 'fyi' | 'ask' | 'blocker';

/** `snapshot.inbox[]` — undelivered notifications for me (§10.2). */
export interface InboxItem {
  id: string;
  kind: NotificationKind;
  from: DevHandle | null;
  body: string;
  /** change set / handoff id or path (§9.2 notify.ref) */
  ref: string | null;
  at: IsoTime;
  noteKind?: NoteKind;
}

/** Known `snapshot.warn[]` values; the hub may add more strings (§3.3, §10.2). */
export type HubWarning = 'token-rotated' | (string & {});

/** The snapshot document returned on every hub response (§10.2). */
export interface Snapshot {
  v: ProtocolVersion;
  serverTime: IsoTime;
  repo: {
    slug: RepoSlug;
    project: string;
    config: RelayConfigResolved;
  };
  me: {
    dev: DevHandle;
    /** null when fetched without a session context (GET /v1/snapshot from MCP) */
    sessionId: string | null;
  };
  sessions: SnapshotSession[];
  heat: HeatEntry[];
  claims: SnapshotClaim[];
  changeSets: SnapshotChangeSet[];
  inbox: InboxItem[];
  warn?: HubWarning[];
  minClient: number;
}

/** ~/.relay/cache/<repoKey>/snapshot.json — the wire snapshot plus the client clock (§4.0 rule 8, §10.3). */
export interface CachedSnapshot extends Snapshot {
  fetchedAt: IsoTime;
}

// ---------------------------------------------------------------------------
// 6. Events posted to /v1/events (§4.2–§4.8)
// ---------------------------------------------------------------------------

/** Every event type the hub stores (§10.1). `session_start`/`session_end` are recorded by the session endpoints, `cwd` is a v1.1 protocol addition (see docs/BUILD-PLAN.md). */
export type EventType =
  | 'prompt'
  | 'edit'
  | 'contract'
  | 'retract'
  | 'commit'
  | 'push'
  | 'branch'
  | 'task'
  | 'turn_end'
  | 'cwd'
  | 'session_start'
  | 'session_end';

/** Event types a client may post (subset of EventType). */
export const CLIENT_EVENT_TYPES = [
  'prompt',
  'edit',
  'contract',
  'retract',
  'commit',
  'push',
  'branch',
  'task',
  'turn_end',
  'cwd',
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** Edit tools hooked by PreToolUse/PostToolUse (§4.0). */
export type EditToolName = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';

/** Symbol/contract kinds produced by extraction (§7.1). Decided here; the design lists the categories without naming them. */
export type ContractKind =
  | 'export'
  | 'member'
  | 'prisma'
  | 'openapi'
  | 'graphql'
  | 'proto'
  | 'sql'
  | 'zod'
  | 'trpc'
  | 'python'
  | 'go'
  | 'file';

/** Common envelope: client ULID (idempotency key) and client clock (§10.1). */
export interface EventBase {
  id: string;
  at: IsoTime;
}

/** Posted by the prompt worker (§4.2 step 4). `text` only when `privacy.send_prompts` (<= 2,000 chars, redacted, §11.1). */
export interface PromptEvent extends EventBase {
  type: 'prompt';
  promptId: string | null;
  objective: string | null;
  objectiveSource: ObjectiveSource | null;
  /** `git status --porcelain` paths, generated/lock files excluded, cap 200 */
  dirty: string[];
  branch: string;
  text?: string;
}

/** One successful edit tool call (§4.5 step 3). */
export interface EditEvent extends EventBase {
  type: 'edit';
  path: string;
  tool: EditToolName;
  toolUseId: string | null;
  area?: string | null;
}

/** A contract candidate detected by post-edit / stop (§4.5 step 2–3, §7.2). */
export interface ContractEvent extends EventBase {
  type: 'contract';
  path: string;
  symbols: string[];
  kinds: ContractKind[];
  /** <= 1,500 chars, `-U0 -w`, redacted; omitted when `privacy.send_diffs === "none"` */
  hunk?: string;
  /** sha1 of the normalized hunk — dedup key with (session, path) (§7.5 step 1) */
  hash: string;
  /** `git hash-object <path>` of the working tree (§4.5) */
  blobId: Sha | null;
  /** in-repo dependents (cap 50); null when the grep timed out (§7.3) */
  dependents: string[] | null;
  summary?: string;
  branch?: string;
}

/** Withdraws an open contract record whose diff became empty (§4.5 step 2, §7.2). `hash` identifies the record when `impactId` is unknown client-side. */
export interface RetractEvent extends EventBase {
  type: 'retract';
  path: string;
  impactId: string | null;
  hash: string | null;
}

/** Contract file inside an own commit (§4.6). */
export interface CommitContract {
  path: string;
  symbols: string[];
  kinds?: ContractKind[];
  hunk?: string;
  hash: string;
  /** `git rev-parse <sha>:<path>` */
  blobId: Sha | null;
}

/** An own-author commit (§4.6, §7.2). The hub ignores commits whose authorEmail does not resolve to the sender. */
export interface CommitEvent extends EventBase {
  type: 'commit';
  sha: Sha;
  /** `git patch-id --stable` (rebase-safe identity) */
  patchId: string | null;
  authorEmail: string;
  subject: string;
  files: string[];
  contracts: CommitContract[];
  branch?: string;
}

/** `git push` observed, or HEAD found on a remote branch (§4.6). */
export interface PushEvent extends EventBase {
  type: 'push';
  branch: string;
  sha: Sha;
}

/** Branch / worktree change (§4.6, §5.3). */
export interface BranchEvent extends EventBase {
  type: 'branch';
  branch: string;
  worktree: string | null;
  /** new `meta.startSha` (merge-base) after the switch */
  startSha?: Sha | null;
}

/** TaskCreated / TaskCompleted (§4.7). */
export interface TaskEvent extends EventBase {
  type: 'task';
  taskId: string;
  subject: string;
  status: 'created' | 'completed';
}

/** Stop (§4.8 step 4): prose of the last assistant message and the heuristic draft. */
export interface TurnEndEvent extends EventBase {
  type: 'turn_end';
  promptId: string | null;
  /** <= 3,000 chars, prose-stripped and redacted; null when `send_turns === false` */
  text: string | null;
  draft: HandoffDraft | null;
}

/** CwdChanged that moved the session to another repo root (§4.7). */
export interface CwdEvent extends EventBase {
  type: 'cwd';
  from: string;
  to: string;
  repo?: RepoSlug;
  branch?: string;
}

/** Union of everything a client posts to /v1/events. */
export type RelayEvent =
  | PromptEvent
  | EditEvent
  | ContractEvent
  | RetractEvent
  | CommitEvent
  | PushEvent
  | BranchEvent
  | TaskEvent
  | TurnEndEvent
  | CwdEvent;

// ---------------------------------------------------------------------------
// 7. HTTP endpoints — request and response bodies (§10.4)
// ---------------------------------------------------------------------------

/** GET /health (unauthenticated). */
export interface HealthResponse {
  ok: true;
  version: string;
  db: 'pglite' | 'neon';
  time: IsoTime;
}

/** Digest modes (§4.1, §9.3). `compact` is rendered locally and never requested from the hub. */
export type DigestMode = 'full' | 'delta' | 'compact';

/** POST /v1/session/start (§4.1 step 3). */
export interface SessionStartRequest {
  v: ProtocolVersion;
  session: SessionDescriptor;
  mode: 'full' | 'delta';
  /** delta mode: previous `meta.lastStopAt` (§4.1) */
  since?: IsoTime;
  /** last 20 SHAs on the branch, newest first */
  recentShas: Sha[];
  identityHint: IdentityHint;
}

/** Response of POST /v1/session/start. */
export interface SessionStartResponse {
  /** rendered `<relay-digest …>…</relay-digest>` (§9.3) */
  digest: string;
  snapshot: Snapshot;
  minClient: number;
  warn?: HubWarning[];
}

/** POST /v1/events (§4.2, §4.5, §4.6, §4.8, §10.4). */
export interface EventsRequest {
  v?: ProtocolVersion;
  session: SessionPresence;
  events: RelayEvent[];
  /** inbox item ids printed by the prompt hook (§4.2 step 4) */
  delivered?: string[];
  /** drained from the outbox: never revives a session or rewinds presence (§4.0 rule 6, §10.1) */
  replay?: boolean;
}

/** Response of POST /v1/events. */
export interface EventsResponse {
  snapshot: Snapshot;
  inbox: InboxItem[];
}

/** Per-file summary from the fold, carried by session end (§4.9). */
export interface SessionFileSummary {
  path: string;
  area: string | null;
  edits: number;
}

/** POST /v1/session/end (§4.9, §10.4). */
export interface SessionEndRequest {
  sessionId: string;
  reason: SessionEndReason;
  /** client clock of the end */
  at?: IsoTime;
  files: SessionFileSummary[];
  commits: HandoffCommit[];
  draft: HandoffDraft | null;
  replay?: boolean;
}

/** Response of POST /v1/session/end. */
export interface OkResponse {
  ok: true;
}

/** GET /v1/snapshot?repo=<slug> returns a bare `Snapshot` (§4.2 step 2). */
export type SnapshotResponse = Snapshot;

/** POST /v1/depindex — the per-repo dependency index (§7.4). */
export interface DepIndex {
  repo: RepoSlug;
  head: Sha;
  builtAt: IsoTime;
  /** normalized specifier (package name, deep specifier, repo-relative path) -> importing files */
  imports: Record<string, string[]>;
  /** imported identifier -> importing files */
  symbols: Record<string, string[]>;
  /** basename or path of contract files -> files referencing them */
  contractPaths: Record<string, string[]>;
}

/** POST /v1/iam — merge a placeholder identity into the caller's handle (§3.3 step 7, `whoami iam=`). Added by the scaffold; the design routes the merge through session start only. */
export interface IamRequest {
  placeholder: string;
  sessionId?: string;
}

/** Response of POST /v1/iam. */
export interface IamResponse {
  merged: boolean;
  sessions: number;
}

/** Error body for 4xx/5xx (§10.4). */
export interface HubErrorBody {
  error: string;
  message?: string;
  /** on 426 */
  minClient?: number;
}

/** POST /admin/token/rotate (§3.3). */
export interface TokenRotateResponse {
  ok: true;
  rotatedAt: IsoTime;
  graceUntil: IsoTime;
}

/** GET /admin/export?project= (§11.2). */
export interface AdminExport {
  project: string;
  exportedAt: IsoTime;
  sessions: PresenceRecord[];
  handoffs: HandoffRecord[];
  decisions: DecisionRecord[];
  changeSets: ChangeSetRecord[];
  impacts: ImpactRecord[];
}

/** DELETE /admin/purge?repo= (§11.2). */
export interface PurgeResponse {
  ok: true;
  repo: RepoSlug;
  deleted: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 8. Hub records (camelCase views of §10.1 tables used by tools and exports)
// ---------------------------------------------------------------------------

/** `devs` (§10.1). */
export interface DevRecord {
  handle: DevHandle;
  name: string | null;
  github: string | null;
  placeholder: boolean;
  mergedInto: DevHandle | null;
  firstSeenAt: IsoTime;
  lastSeenAt: IsoTime;
}

/** `repos` (§10.1). */
export interface RepoRecord {
  slug: RepoSlug;
  project: string;
  config: RelayConfig | null;
  configHash: string | null;
  firstSeenAt: IsoTime;
}

/** `claims` — dev-scoped, session id is metadata (§6.3, §10.1). */
export interface ClaimRecord {
  id: string;
  repo: RepoSlug;
  dev: DevHandle;
  sessionId: string | null;
  target: string;
  note: string | null;
  hard: boolean;
  keep: boolean;
  createdAt: IsoTime;
  expiresAt: IsoTime;
  releasedAt: IsoTime | null;
}

/** `impacts` (§7.5 step 1, §10.1). */
export interface ImpactRecord {
  id: string;
  changeSetId: string;
  repo: RepoSlug;
  dev: DevHandle;
  sessionId: string;
  path: string;
  symbols: string[];
  kinds: ContractKind[];
  summary: string;
  hunk: string | null;
  hash: string;
  blobId: Sha | null;
  branch: string;
  status: ImpactStatus;
  commitSha: Sha | null;
  patchId: string | null;
  authorEmail: string | null;
  rev: number;
  supersededBy: string | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** `change_sets` (§7.5 step 2, §10.1). */
export interface ChangeSetRecord {
  id: string;
  repo: RepoSlug;
  dev: DevHandle;
  sessionId: string;
  branch: string;
  status: ImpactStatus;
  priority: ImpactPriority;
  firstAt: IsoTime;
  lastAt: IsoTime;
  /** hash stable since; routable once older than `impacts.debounce_minutes` (§7.5 step 7) */
  stableSince: IsoTime | null;
  acked: Record<DevHandle, IsoTime>;
}

/** `impact_targets` (§7.5 step 8, §10.1). */
export interface ImpactTargetRecord {
  changeSetId: string;
  dev: DevHandle;
  repo: RepoSlug;
  dependents: Dependent[];
  priority: ImpactPriority;
  deliveredAt: IsoTime | null;
  ackedAt: IsoTime | null;
  ackNote: string | null;
}

/** How a notification reached its target (§7.5 step 9, §8.4). */
export type DeliveryVia = 'digest' | 'prompt' | 'post-edit' | 'post-git' | 'pre-edit' | 'pre-read' | 'mcp';

/** `notifications` (§10.1). */
export interface NotificationRecord {
  id: string;
  repo: RepoSlug;
  toDev: DevHandle;
  fromDev: DevHandle | null;
  kind: NotificationKind;
  refId: string | null;
  body: string;
  createdAt: IsoTime;
  deliveredAt: IsoTime | null;
  deliveredVia: DeliveryVia | null;
}

/** `turns` (§8.2, §10.1). */
export interface TurnRecord {
  sessionId: string;
  promptId: string;
  at: IsoTime;
  text: string;
}

/** `decisions` (§8.2, §9.2, §10.1). */
export type DecisionSource = 'explicit' | 'handoff' | 'auto';

/** One decision record (§10.1). */
export interface DecisionRecord {
  id: string;
  repo: RepoSlug;
  project: string;
  dev: DevHandle;
  sessionId: string | null;
  topic: string | null;
  area: string | null;
  text: string;
  source: DecisionSource;
  confidence: number;
  supersedes: string | null;
  createdAt: IsoTime;
}

/** `dev_repo` (§7.5 step 5, §10.1). */
export interface DevRepoRecord {
  dev: DevHandle;
  repo: RepoSlug;
  homeAreas: string[];
  lastSeenAt: IsoTime;
  lastSessionEndAt: IsoTime | null;
}

// ---------------------------------------------------------------------------
// 9. Handoffs (§8)
// ---------------------------------------------------------------------------

/** Handoff tiers (§8.2). */
export type HandoffQuality = 'heuristic' | 'llm' | 'self';

/** `changed[]` entry (§8.3). */
export interface HandoffChangedFile {
  path: string;
  area: string | null;
  edits: number;
  why?: string | null;
}

/** `interfaces_changed[]` entry (§8.3). */
export interface HandoffInterfaceChanged {
  changeSetId: string | null;
  impactId: string | null;
  path: string;
  symbols: string[];
  summary: string;
  status: ImpactStatus;
  commitSha: Sha | null;
}

/** `commits[]` entry (§8.3). */
export interface HandoffCommit {
  sha: Sha;
  subject: string;
  pushed: boolean;
}

/** Egregore-compatible addressed-note intent (§8.3). */
export type NoteIntent = 'action' | 'feedback' | 'fyi';

/** `notes_to[]` entry (§8.3). */
export interface HandoffNoteTo {
  dev: DevHandle;
  intent: NoteIntent;
  text: string;
}

/** The synthesized content of a handoff (§8.3), shared by drafts, records and the LLM output schema. */
export interface HandoffBody {
  objective: string | null;
  areas: string[];
  done: string[];
  changed: HandoffChangedFile[];
  interfaces_changed: HandoffInterfaceChanged[];
  decisions: string[];
  blockers: string[];
  next: string[];
  commits: HandoffCommit[];
  notes_to: HandoffNoteTo[];
}

/** Stored handoff (§8.3, §10.1). */
export interface HandoffRecord extends HandoffBody {
  id: string;
  rev: number;
  quality: HandoffQuality;
  dev: DevHandle;
  sessionId: string;
  project: string;
  repo: RepoSlug;
  branch: string;
  worktree: string | null;
  client: ClientKind;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  endReason: SessionEndReason | null;
  markdown: string;
  generatedAt: IsoTime;
}

/** Client-side heuristic draft written at every Stop, <= 8 KB (§4.8 step 3, §8.2 tier 1). */
export interface HandoffDraft extends HandoffBody {
  at: IsoTime;
  quality: 'heuristic';
  /** objective trail head-first (§5.1) */
  objectiveTrail?: string[];
}

/** `handoff` tool `summary` argument (§9.2). Strings are accepted where the record uses objects. */
export interface HandoffSelfSummary {
  done?: string[];
  changed?: Array<string | HandoffChangedFile>;
  interfaces_changed?: Array<string | Partial<HandoffInterfaceChanged>>;
  decisions?: string[];
  blockers?: string[];
  next?: string[];
  notes_to?: HandoffNoteTo[];
  objective?: string;
}

// ---------------------------------------------------------------------------
// 10. MCP tool arguments and the /v1/query and /v1/<action> payloads (§9.2)
// ---------------------------------------------------------------------------

/** MCP tool names, `mcp__plugin_relay_relay__<name>` (§9.1, §9.2). */
export const MCP_TOOL_NAMES = [
  'status',
  'who_is_on',
  'recent_changes',
  'decisions',
  'notify',
  'claim',
  'release',
  'impacts',
  'impact_of',
  'handoffs',
  'handoff',
  'decide',
  'whoami',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Where a tool answer came from (§9.1 read tools fall back to the cache). */
export interface Freshness {
  source: 'hub' | 'cache';
  at: IsoTime;
  /** age of the cached snapshot when `source === "cache"` */
  ageMs?: number;
  breakerOpen?: boolean;
}

/** `status` args (§9.2). */
export interface StatusRequest {
  project?: 'current' | 'all';
}

/** One developer in `status` (§6.1 developer-level presence). */
export interface StatusDev {
  dev: DevHandle;
  sessions: PresenceRecord[];
  claims: ClaimRecord[];
  lastSeenAt: IsoTime | null;
}

/** GET /v1/query/status?project= (§9.2). */
export interface StatusResponse {
  at: IsoTime;
  scope: 'current' | 'all';
  projects: Array<{
    project: string;
    repos: RepoSlug[];
    devs: StatusDev[];
  }>;
  me: {
    dev: DevHandle;
    sessionId: string | null;
    unackedChangeSets: number;
    unreadInbox: number;
  };
  freshness: Freshness;
}

/** `who_is_on` args (§9.2). */
export interface WhoIsOnRequest {
  target: string;
}

/** GET /v1/query/who_is_on?target= (§9.2). */
export interface WhoIsOnResponse {
  at: IsoTime;
  target: string;
  targetKind: 'area' | 'path' | 'glob';
  live: PresenceRecord[];
  /** edit/commit heat in the last 24 h */
  recentEditors: HeatEntry[];
  /** dirty (uncommitted) files reported at the last prompt */
  dirty: HeatEntry[];
  claims: ClaimRecord[];
  freshness: Freshness;
}

/** `recent_changes` args (§9.2). */
export interface RecentChangesRequest {
  area?: string;
  /** ISO time or "1d" / "7d" */
  since?: string;
  kind?: 'contracts' | 'commits' | 'edits' | 'all';
}

/** One `recent_changes` item (§9.2). */
export type RecentChangeItem =
  | {
      kind: 'contract';
      at: IsoTime;
      dev: DevHandle;
      repo: RepoSlug;
      branch: string;
      changeSetId: string;
      impactId: string;
      rev: number;
      path: string;
      symbols: string[];
      summary: string;
      hunk: string | null;
      status: ImpactStatus;
      priority: ImpactPriority;
      commitSha: Sha | null;
    }
  | {
      kind: 'commit';
      at: IsoTime;
      dev: DevHandle;
      repo: RepoSlug;
      branch: string;
      sha: Sha;
      subject: string;
      pushed: boolean;
      files: string[];
    }
  | {
      kind: 'edit';
      at: IsoTime;
      dev: DevHandle;
      repo: RepoSlug;
      branch: string;
      path: string;
      count: number;
    }
  | {
      kind: 'handoff';
      at: IsoTime;
      dev: DevHandle;
      repo: RepoSlug;
      branch: string;
      handoffId: string;
      objective: string | null;
      /** the one-line digest rendering (§8.4) */
      line: string;
    };

/** GET /v1/query/recent_changes (§9.2). */
export interface RecentChangesResponse {
  at: IsoTime;
  since: IsoTime;
  items: RecentChangeItem[];
  freshness: Freshness;
}

/** `decisions` args (§9.2). */
export interface DecisionsRequest {
  topic?: string;
  area?: string;
  since?: string;
}

/** GET /v1/query/decisions (§9.2). */
export interface DecisionsResponse {
  at: IsoTime;
  items: DecisionRecord[];
}

/** `handoffs` args (§9.2). */
export interface HandoffsRequest {
  dev?: 'me' | DevHandle;
  n?: number;
  repo?: RepoSlug;
  full?: boolean;
}

/** GET /v1/query/handoffs (§9.2). */
export interface HandoffsResponse {
  at: IsoTime;
  items: HandoffRecord[];
  freshness: Freshness;
}

/** `impacts` args (§9.2). `ack` is routed to POST /v1/ack. */
export interface ImpactsRequest {
  mine?: boolean;
  ack?: string;
}

/** A change set as the `impacts` tool shows it: snapshot view plus routing metadata (§9.2). */
export interface ChangeSetView extends SnapshotChangeSet {
  sessionId: string;
  firstAt: IsoTime;
  stableSince: IsoTime | null;
  acked: Record<DevHandle, IsoTime>;
  targets: ImpactTargetRecord[];
}

/** GET /v1/query/impacts?mine= (§9.2). */
export interface ImpactsResponse {
  at: IsoTime;
  changeSets: ChangeSetView[];
  freshness: Freshness;
}

/** `impact_of` args (§9.2). */
export interface ImpactOfRequest {
  path?: string;
  sha?: Sha;
}

/** GET /v1/query/impact_of?path=|sha= (§9.2). Dependents carry `repo` (§7.4). */
export interface ImpactOfResponse {
  at: IsoTime;
  path: string | null;
  sha: Sha | null;
  symbols: string[];
  kinds: ContractKind[];
  dependents: Dependent[];
  owners: DevHandle[];
  active: PresenceRecord[];
  heat: HeatEntry[];
  openChangeSets: string[];
}

/** POST /v1/notify (§9.2). */
export interface NotifyRequest {
  dev: DevHandle | 'all';
  message: string;
  ref?: string;
  kind?: NoteKind;
}

/** Response of POST /v1/notify. */
export interface NotifyResponse {
  ids: string[];
  targets: Array<{
    dev: DevHandle;
    active: boolean;
    lastSeenAt: IsoTime | null;
    via: 'next-prompt' | 'next-session';
  }>;
  /** human-readable delivery note (§9.2) */
  note: string;
}

/** POST /v1/claim (§6.3, §9.2). */
export interface ClaimRequest {
  target: string;
  note?: string;
  /** "4h" default, "24h" max */
  ttl?: string;
  hard?: boolean;
  keep?: boolean;
}

/** Response of POST /v1/claim. */
export interface ClaimResponse {
  claim: ClaimRecord;
  conflicts: {
    claims: ClaimRecord[];
    heat: HeatEntry[];
    sessions: PresenceRecord[];
  };
}

/** POST /v1/release (§9.2). */
export interface ReleaseRequest {
  target?: string | 'all';
}

/** Response of POST /v1/release. */
export interface ReleaseResponse {
  released: string[];
}

/** POST /v1/decide (§9.2). */
export interface DecideRequest {
  text: string;
  topic?: string;
  area?: string;
  supersedes?: string;
}

/** Response of POST /v1/decide. */
export interface DecideResponse {
  decision: DecisionRecord;
}

/** POST /v1/ack — change set or impact id (§7.5 step 10, §9.2). */
export interface AckRequest {
  id: string;
  note?: string;
  /** automatic ack from the ancestry worker (§4.12) */
  auto?: boolean;
}

/** Response of POST /v1/ack. */
export interface AckResponse {
  changeSetId: string;
  ackedAt: IsoTime;
  notifiedAuthor: boolean;
}

/** POST /v1/handoff (§8.1, §9.2). */
export interface HandoffRequest {
  sessionId?: string;
  summary?: HandoffSelfSummary;
}

/** Response of POST /v1/handoff. */
export interface HandoffResponse {
  handoff: HandoffRecord;
}

/** `whoami` args (§9.2). Answered locally; `iam` also calls POST /v1/iam. */
export interface WhoamiRequest {
  iam?: DevHandle;
}

/** `whoami` result (§9.2). */
export interface WhoamiResult {
  dev: DevHandle;
  identitySource: IdentitySource;
  team: string | null;
  hub: string | null;
  repo: RepoSlug | null;
  project: string | null;
  sessionId: string | null;
  sessionSource: 'current-file' | 'cwd-match' | 'env' | 'none';
  cacheAgeMs: number | null;
  breaker: {
    open: boolean;
    until: IsoTime | null;
    configError: ConfigErrorFile | null;
  };
  plugin: {
    sha: string | null;
    remoteSha: string | null;
    behind: boolean | null;
  };
  hookCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 11. Local files under $RELAY_HOME (§10.3)
// ---------------------------------------------------------------------------

/** Relative paths inside $RELAY_HOME (default ~/.relay) (§10.3). */
export const LOCAL_PATHS = {
  identity: 'identity.json',
  nodePath: 'node-path',
  downUntil: 'down-until',
  downCount: 'down-count',
  configError: 'config-error.json',
  refreshWanted: 'refresh-wanted',
  pluginRemote: 'plugin-remote.json',
  statusline: 'statusline.sh',
  statuslineChain: 'statusline-chain',
  lastError: 'last-error',
  currentDir: 'current',
  cacheDir: 'cache',
  sessionsDir: 'sessions',
  muteDir: 'mute',
  outboxDir: 'outbox',
  bgDir: 'bg',
  logDir: 'log',
  log: 'log/relay.log',
  stats: 'log/stats.jsonl',
} as const;

/** File names inside cache/<repoKey>/ (§10.3). */
export const CACHE_FILES = {
  snapshot: 'snapshot.json',
  digest: 'digest.md',
  statusline: 'statusline.txt',
  ancestry: 'ancestry.json',
  state: 'state.json',
} as const;

/** File names inside sessions/<session_id>/ (§4.0 rule 9, §10.3). */
export const SESSION_FILES = {
  meta: 'meta.json',
  events: 'events.jsonl',
  fold: 'fold.json',
  marksDir: 'marks',
  pending: 'pending',
  draft: 'draft.json',
  lockDir: '.lock',
} as const;

/** sessions/<sid>/meta.json (§4.0 rule 9, §4.1 step 2). */
export interface SessionMeta {
  v: 1;
  sessionId: string;
  dev: DevHandle;
  identitySource: IdentitySource;
  repo: RepoSlug;
  project: string;
  repoKey: RepoKey;
  repoRoot: string;
  cwd: string;
  branch: string;
  worktree: string | null;
  startSha: Sha | null;
  lastStopSha: Sha | null;
  lastStopAt: IsoTime | null;
  client: ClientKind;
  host: string;
  /** CLAUDE_PID */
  pid: number | null;
  startedAt: IsoTime;
  source: SessionStartSource | null;
  gitEmail: string | null;
  /** author-filter set: this dev's team.json emails plus the git email (§4.0 rule 7) */
  gitEmails: string[];
  configHash: string | null;
  model: string | null;
  pluginSha: string | null;
  /** rev-parse phase timed out: repo/root are guesses; never persisted, re-healed by the next hook (§4.0 rule 10) */
  provisional?: boolean;
}

/** Journal line kinds in events.jsonl (§4.0 rule 9). */
export const JOURNAL_KINDS = [
  'edit',
  'prompt',
  'objective',
  'contract',
  'commit',
  'task',
  'turn',
  'cwd',
  'branch',
  'end',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** Common fields of every journal line (<= 4 KB, O_APPEND). */
export interface JournalBase {
  at: IsoTime;
}

/** `{t:"edit"}` (§4.5 step 1). */
export interface JournalEdit extends JournalBase {
  t: 'edit';
  path: string;
  tool: EditToolName;
  toolUseId: string | null;
}

/** `{t:"prompt"}` (§4.2 step 1). `text` only when `privacy.send_prompts` (<= 300 chars, redacted). */
export interface JournalPrompt extends JournalBase {
  t: 'prompt';
  promptId: string | null;
  len: number;
  sha1: string;
  text?: string;
}

/** `{t:"objective"}` appended when the objective changes (§4.2 step 1, §5.1). */
export interface JournalObjective extends JournalBase {
  t: 'objective';
  objective: string;
  source: ObjectiveSource;
}

/** `{t:"contract"}` (§4.5 step 2). `eventId` is the posted ContractEvent id, kept for retracts. */
export interface JournalContract extends JournalBase {
  t: 'contract';
  path: string;
  hash: string;
  blobId: Sha | null;
  symbols: string[];
  kinds: ContractKind[];
  eventId: string;
  retracted?: boolean;
}

/** `{t:"commit"}` (§4.6). */
export interface JournalCommit extends JournalBase {
  t: 'commit';
  sha: Sha;
  subject: string;
  files: string[];
  contracts: string[];
  pushed?: boolean;
}

/** `{t:"task"}` (§4.7). */
export interface JournalTask extends JournalBase {
  t: 'task';
  id: string;
  subject: string;
  status: 'created' | 'completed';
}

/** `{t:"turn"}` (§4.8 step 1). */
export interface JournalTurn extends JournalBase {
  t: 'turn';
  promptId: string | null;
  text: string;
}

/** `{t:"cwd"}` (§4.7). */
export interface JournalCwd extends JournalBase {
  t: 'cwd';
  from: string;
  to: string;
}

/** `{t:"branch"}` (§4.6). */
export interface JournalBranch extends JournalBase {
  t: 'branch';
  branch: string;
  worktree: string | null;
  startSha: Sha | null;
}

/** `{t:"end"}` (§4.9). */
export interface JournalEnd extends JournalBase {
  t: 'end';
  reason: SessionEndReason;
}

/** One line of events.jsonl. */
export type JournalEntry =
  | JournalEdit
  | JournalPrompt
  | JournalObjective
  | JournalContract
  | JournalCommit
  | JournalTask
  | JournalTurn
  | JournalCwd
  | JournalBranch
  | JournalEnd;

/** sessions/<sid>/fold.json — the folded journal readers rebuild in ~1 ms (§4.0 rule 9, §5.1, §5.2, §8.2). */
export interface JournalFold {
  v: 1;
  /** journal lines folded so far (rotated files included) */
  foldedLines: number;
  /** per repo-relative path */
  edits: Record<string, { count: number; firstAt: IsoTime; lastAt: IsoTime; tool: EditToolName }>;
  /** paths by most recent edit, newest first (area vote uses the first 20, §5.2) */
  recentPaths: string[];
  /** last contract line per path (dedup by hash, retract detection) */
  contracts: Record<string, JournalContract>;
  objective: {
    text: string | null;
    source: ObjectiveSource | null;
    at: IsoTime | null;
    /** tool calls since the objective was set (§5.1 replacement rule) */
    toolCallsSince: number;
    /** last 5 objectives, newest first */
    trail: JournalObjective[];
  };
  tasks: {
    open: Array<{ id: string; subject: string; at: IsoTime }>;
    /** <= 20 completed subjects (§4.7) */
    done: Array<{ id: string; subject: string; at: IsoTime }>;
  };
  /** last 12 turns (§8.2) */
  turns: JournalTurn[];
  commits: JournalCommit[];
  prompts: { count: number; lastAt: IsoTime | null; lastPromptId: string | null };
  lastTurnAt: IsoTime | null;
  /** last assistant message ended with "?" (§5.1 rejection rule) */
  lastTurnWasQuestion: boolean;
  ended: { at: IsoTime; reason: SessionEndReason } | null;
}

/** Marker file prefixes in sessions/<sid>/marks/ (§4.0 rule 9). */
export type MarkKind = 'seen' | 'jit' | 'noted' | 'asked' | 'snooze' | 'stop' | 'ended';

/** Content of `marks/asked.<sha1(path|dev)>` (§4.3 step 5). `snooze.*` holds an IsoTime expiry; others are empty. */
export interface AskedMark {
  toolUseId: string | null;
  at: IsoTime;
  path: string;
  dev: DevHandle;
}

/** sessions/<sid>/pending — change-set ids with undelivered dependents in this repo, one per line (§4.4). */
export type PendingFile = string[];

/** Outbox entry kinds; `endpoint` says where the body goes (§4.0 rule 6). */
export type OutboxKind = 'session_start' | 'events' | 'session_end' | 'depindex';

/** outbox/<ulid>.json — write-ahead log of every POST body (§4.0 rule 6, §10.3). */
export interface OutboxEntry {
  v: 1;
  /** the ULID in the file name */
  id: string;
  sessionId: string;
  at: IsoTime;
  kind: OutboxKind;
  /** e.g. "/v1/events" */
  endpoint: string;
  /** prompt / edit / turn_end / presence-only bodies: dropped after 24 h instead of 7 d */
  ephemeral: boolean;
  body: SessionStartRequest | EventsRequest | SessionEndRequest | DepIndex;
  /** failed sends so far; the drain drops the entry at LIMITS.outboxMaxAttempts */
  attempts?: number;
  lastError?: string;
}

/** current/<CLAUDE_PID>.json — liveness and live-session lookup (§4.0 rule 11, §9.1). */
export interface CurrentFile {
  v: 1;
  sessionId: string;
  cwd: string;
  repoKey: RepoKey;
  dev: DevHandle;
  at: IsoTime;
  /** absolute path of cache/<repoKey>/statusline.txt (§4.11) */
  statusline: string;
  pid: number;
}

/** cache/<repoKey>/ancestry.json (§4.12). */
export interface AncestryFile {
  headSha: Sha;
  at: IsoTime;
  /** sha -> is an ancestor of HEAD */
  contains: Record<string, boolean>;
  /** changeSetId -> already in my branch by SHA or by content */
  merged: Record<string, boolean>;
}

/** cache/<repoKey>/state.json — rewritten under the bg lock only (§10.3). */
export interface RepoStateFile {
  v: 1;
  /** branch -> last own commit reported to the hub (§4.6, §7.2) */
  lastReportedSha: Record<string, Sha>;
  depindexHead: Sha | null;
  depindexAt: IsoTime | null;
}

/** config-error.json for 401 / 426 / 413 (§4.0 rule 5). */
export interface ConfigErrorFile {
  status: number;
  message: string;
  at: IsoTime;
}

/** plugin-remote.json (§3.4). */
export interface PluginRemoteFile {
  sha: Sha;
  checkedAt: IsoTime;
}

/** What a hook wrote to stdout, for log/stats.jsonl (§4.3 step 6, §9.2 whoami). */
export type HookOutcome = 'none' | 'context' | 'ask' | 'deny' | 'digest' | 'error';

/** One line of log/stats.jsonl. */
export interface StatsLine {
  at: IsoTime;
  event: HookEventName;
  verb: HookVerb;
  ms: number;
  out: HookOutcome;
  sessionId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 12. Collision verdicts (§6.4, §6.5)
// ---------------------------------------------------------------------------

/** Collision severities in precedence order (§6.4). */
export const COLLISION_SEVERITIES = ['CLAIMED', 'HOT', 'WARM', 'SEQUENTIAL', 'SAME_DEV', 'NONE'] as const;
export type CollisionSeverity = (typeof COLLISION_SEVERITIES)[number];

/** What the pre-edit hook emits for a verdict (§4.3 step 5). */
export type CollisionDecision = 'deny' | 'ask' | 'context' | 'note' | 'none';

/** Snapshot staleness tier (§6.5). */
export type StalenessTier = 'fresh' | 'degraded' | 'stale' | 'offline';

/** The other party of a collision (§4.3 step 5 phrasing needs all of these). */
export interface CollisionParty {
  dev: DevHandle;
  sessionId: string | null;
  branch: string | null;
  worktree: string | null;
  objective: string | null;
  state: SessionState | null;
  lastEditAt: IsoTime | null;
  editCount: number;
  impactId: string | null;
}

/** Result of the severity computation for one path (§6.4, §6.5). */
export interface CollisionVerdict {
  path: string;
  severity: CollisionSeverity;
  decision: CollisionDecision;
  tier: StalenessTier;
  /** staleness label such as "(presence as of 09:41Z)", null when fresh */
  label: string | null;
  other: CollisionParty | null;
  claim: SnapshotClaim | null;
  /** same-branch worktree escalation applied (§6.6) */
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// 13. Claude Code hook contract used by Relay (docs/research/hooks.md §4–§5; §4.0 stdin list)
// ---------------------------------------------------------------------------

/** Events Relay hooks (§4.0 hooks.json). */
export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'CwdChanged'
  | 'Stop'
  | 'SessionEnd';

/** `permission_mode` values (hooks.md §4.1); absent -> treated as `default` (§4.0). */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';

/** Fields common to every hook stdin object (hooks.md §4.1). All reads are defensive. */
export interface HookInputBase {
  session_id: string;
  hook_event_name: HookEventName;
  cwd: string;
  transcript_path?: string;
  /** v2.1.196+; absent before the first prompt */
  prompt_id?: string;
  permission_mode?: PermissionMode;
  /** only inside a subagent */
  agent_id?: string;
  agent_type?: string;
  scratchpad_dir?: string;
}

/** SessionStart stdin (hooks.md §4.2). */
export interface SessionStartInput extends HookInputBase {
  hook_event_name: 'SessionStart';
  source: SessionStartSource;
  model?: string;
  session_title?: string;
}

/** UserPromptSubmit stdin. */
export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

/** `tool_input` of the edit tools (§4.3); MultiEdit carries one `file_path`. */
export interface EditToolInput {
  file_path?: string;
  notebook_path?: string;
  [key: string]: unknown;
}

/** `tool_input` of Bash (§4.6). */
export interface BashToolInput {
  command: string;
  description?: string;
  [key: string]: unknown;
}

/** `tool_response` of Bash on PostToolUse (§4.6). */
export interface BashToolResponse {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  [key: string]: unknown;
}

/** PreToolUse stdin. */
export interface PreToolUseInput extends HookInputBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/** PostToolUse stdin (fires only on success, §4.5). */
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
}

/** TaskCreated / TaskCompleted stdin (§4.7). */
export interface TaskHookInput extends HookInputBase {
  hook_event_name: 'TaskCreated' | 'TaskCompleted';
  task_id: string;
  task_subject: string;
  task_description?: string;
}

/** CwdChanged stdin (§4.7). */
export interface CwdChangedInput extends HookInputBase {
  hook_event_name: 'CwdChanged';
  old_cwd: string;
  new_cwd: string;
}

/** Stop stdin (§4.8). */
export interface StopInput extends HookInputBase {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message?: string;
}

/** SessionEnd stdin (§4.9). */
export interface SessionEndInput extends HookInputBase {
  hook_event_name: 'SessionEnd';
  reason: ClaudeSessionEndReason;
}

/** Union of the stdin shapes Relay reads. */
export type HookInput =
  | SessionStartInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PostToolUseInput
  | TaskHookInput
  | CwdChangedInput
  | StopInput
  | SessionEndInput;

/** `hookSpecificOutput` shapes Relay emits (hooks.md §5.5; §4.1–§4.5). Relay never emits `allow`, `updatedInput` or `decision: "block"`. */
export type HookSpecificOutput =
  | { hookEventName: 'SessionStart'; additionalContext?: string; sessionTitle?: string }
  | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
  | {
      hookEventName: 'PreToolUse';
      permissionDecision?: 'ask' | 'deny';
      permissionDecisionReason?: string;
      additionalContext?: string;
    }
  | { hookEventName: 'PostToolUse'; additionalContext?: string };

/** The single JSON object a hook prints, or nothing (§4.0 rule 3). */
export interface HookOutput {
  hookSpecificOutput?: HookSpecificOutput;
  /** UserPromptSubmit only, and only if Appendix B.11 verifies it is shown (§4.2 step 3) */
  systemMessage?: string;
}

/** Environment variables read by the client (§4.0). */
export const RELAY_ENV = {
  home: 'RELAY_HOME',
  dev: 'RELAY_DEV',
  hub: 'RELAY_HUB',
  token: 'RELAY_TOKEN',
  node: 'RELAY_NODE',
  debug: 'RELAY_DEBUG',
  disable: 'RELAY_DISABLE',
  interactive: 'RELAY_INTERACTIVE',
  snapshotTtlMs: 'RELAY_SNAPSHOT_TTL_MS',
  bg: 'RELAY_BG',
  project: 'RELAY_PROJECT',
  pluginRoot: 'CLAUDE_PLUGIN_ROOT',
  envFile: 'CLAUDE_ENV_FILE',
  entrypoint: 'CLAUDE_CODE_ENTRYPOINT',
  pid: 'CLAUDE_PID',
  sessionId: 'CLAUDE_CODE_SESSION_ID',
} as const;

// ---------------------------------------------------------------------------
// 14. Cheap structural type guards (no schema library; §2.2 zero-dep hook bundle)
// ---------------------------------------------------------------------------

/** Plain object check used by every guard below. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isString);
}

/** A client event has a string id, a string `at` and a known client type. */
export function isRelayEvent(x: unknown): x is RelayEvent {
  return (
    isRecord(x) &&
    isString(x['id']) &&
    isString(x['at']) &&
    isString(x['type']) &&
    (CLIENT_EVENT_TYPES as readonly string[]).includes(x['type'])
  );
}

/** Snapshot shape check for cache reads (§4.3 fail-open: unparseable -> no decision). */
export function isSnapshot(x: unknown): x is Snapshot {
  if (!isRecord(x) || x['v'] !== PROTOCOL_VERSION || !isString(x['serverTime'])) return false;
  const repo = x['repo'];
  const me = x['me'];
  return (
    isRecord(repo) &&
    isString(repo['slug']) &&
    isRecord(me) &&
    isString(me['dev']) &&
    Array.isArray(x['sessions']) &&
    Array.isArray(x['heat']) &&
    Array.isArray(x['claims']) &&
    Array.isArray(x['changeSets']) &&
    Array.isArray(x['inbox'])
  );
}

/** Cached snapshot = snapshot plus the client's `fetchedAt`. */
export function isCachedSnapshot(x: unknown): x is CachedSnapshot {
  return isSnapshot(x) && isString((x as unknown as Record<string, unknown>)['fetchedAt']);
}

/** meta.json check (§4.0 rule 10 recreates it when this fails). */
export function isSessionMeta(x: unknown): x is SessionMeta {
  return (
    isRecord(x) &&
    x['v'] === 1 &&
    isString(x['sessionId']) &&
    isString(x['dev']) &&
    isString(x['repo']) &&
    isString(x['repoKey']) &&
    isString(x['repoRoot']) &&
    isString(x['branch']) &&
    isString(x['startedAt'])
  );
}

/** One journal line. */
export function isJournalEntry(x: unknown): x is JournalEntry {
  return (
    isRecord(x) &&
    isString(x['at']) &&
    isString(x['t']) &&
    (JOURNAL_KINDS as readonly string[]).includes(x['t'])
  );
}

/** Outbox WAL entry (§4.0 rule 6). */
export function isOutboxEntry(x: unknown): x is OutboxEntry {
  return (
    isRecord(x) &&
    x['v'] === 1 &&
    isString(x['id']) &&
    isString(x['sessionId']) &&
    isString(x['at']) &&
    isString(x['kind']) &&
    isString(x['endpoint']) &&
    typeof x['ephemeral'] === 'boolean' &&
    isRecord(x['body'])
  );
}

/** current/<pid>.json (§4.0 rule 11). */
export function isCurrentFile(x: unknown): x is CurrentFile {
  return (
    isRecord(x) &&
    x['v'] === 1 &&
    isString(x['sessionId']) &&
    isString(x['cwd']) &&
    isString(x['repoKey']) &&
    isString(x['dev']) &&
    isString(x['at']) &&
    typeof x['pid'] === 'number'
  );
}

/** Minimal hook stdin check: `session_id`, `hook_event_name` and `cwd` are always present. */
export function isHookInput(x: unknown): x is HookInput {
  return isRecord(x) && isString(x['session_id']) && isString(x['hook_event_name']) && isString(x['cwd']);
}

/** `.relay.json` shape check (deep validation and defaults live in config.ts). */
export function isRelayConfig(x: unknown): x is RelayConfig {
  if (!isRecord(x)) return false;
  if ('project' in x && x['project'] !== undefined && !isString(x['project'])) return false;
  if ('repo' in x && x['repo'] !== undefined && !isString(x['repo'])) return false;
  if ('areas' in x && x['areas'] !== undefined) {
    const areas = x['areas'];
    if (!isRecord(areas)) return false;
    for (const area of Object.values(areas)) {
      if (!isRecord(area) || !isStringArray(area['paths'])) return false;
    }
  }
  return true;
}

/** team.json check (§2.3). */
export function isTeamConfig(x: unknown): x is TeamConfig {
  return (
    isRecord(x) &&
    isString(x['hub']) &&
    isString(x['team']) &&
    isString(x['token']) &&
    isRecord(x['members'])
  );
}

/** Handoff body arrays present (draft / record / LLM output). */
export function isHandoffBody(x: unknown): x is HandoffBody {
  return (
    isRecord(x) &&
    Array.isArray(x['done']) &&
    Array.isArray(x['changed']) &&
    Array.isArray(x['interfaces_changed']) &&
    Array.isArray(x['decisions']) &&
    Array.isArray(x['blockers']) &&
    Array.isArray(x['next']) &&
    Array.isArray(x['commits']) &&
    Array.isArray(x['notes_to']) &&
    Array.isArray(x['areas'])
  );
}

/** Edit-tool input carries `file_path` or `notebook_path` (§4.3 step 1). */
export function editToolPath(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const p = input['file_path'] ?? input['notebook_path'];
  return isString(p) && p.length > 0 ? p : null;
}
