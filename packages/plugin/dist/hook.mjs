// Relay hook program (DESIGN.md §4): built by packages/hooks/scripts/build.mjs from
// packages/hooks/src + packages/core/src. Invoked as `node hook.mjs <verb>` by
// scripts/hook.sh with Claude Code hook JSON on stdin; every path exits 0.
// Do not edit: regenerate with `pnpm --filter @relay/hooks build`.

// ../core/src/protocol.ts
var PROTOCOL_VERSION = 1;
var RELAY_HEADERS = {
  dev: "x-relay-dev",
  session: "x-relay-session",
  client: "x-relay-client",
  proto: "x-relay-proto",
  plugin: "x-relay-plugin",
  /** Response header set by the hub when the previous token authenticated (§3.3). */
  warn: "x-relay-warn"
};
var HTTP_STATUS = {
  badToken: 401,
  payloadTooLarge: 413,
  clientTooOld: 426,
  rateLimited: 429
};
var DEADLINE_MS = {
  "session-start": 3500,
  "session-start-compact": 800,
  prompt: 2e3,
  "pre-edit": 900,
  "pre-read": 600,
  "post-edit": 6e3,
  "post-git": 6e3,
  "task-created": 300,
  "task-completed": 300,
  cwd: 1500,
  stop: 5e3,
  "session-end": 600,
  bg: 15e3
};
var BUDGET_MS = {
  sessionStartPost: 3e3,
  promptRefresh: 800,
  promptRefreshAfterPause: 1500,
  workerPost: 3e3,
  sessionEndPost: 5e3,
  mcpFetch: 5e3,
  gitRevParse: 300,
  gitDiff: 1e3,
  gitGrep: 2e3
};
var BREAKER = {
  /** consecutive worker failures that open the breaker */
  failuresToOpen: 2,
  openMs: 6e4,
  /** 401 / 426 / 413 are configuration errors, not outages */
  configErrorMs: 6e5,
  /** default snapshot TTL on the prompt path; RELAY_SNAPSHOT_TTL_MS overrides */
  snapshotTtlMs: 6e4,
  /** pre-edit spawns `bg refresh` when the cache is older than this */
  preEditRefreshMs: 12e4,
  /** ...unless a refresh-wanted marker younger than this exists */
  refreshWantedDebounceMs: 1e4,
  /** the prompt path uses the longer budget when the cache is older than this */
  pauseMs: 3e5
};
var STALENESS = {
  /** full policy (deny/ask/context) while the snapshot is at most this old */
  fullPolicyMs: 3e5,
  /** deny -> ask, ask -> context between fullPolicyMs and this */
  degradedMs: 9e5,
  /** a HOT verdict needs an edit heat entry at most this old */
  heatHotMs: 9e5,
  /** an implicit file claim needs the other session seen within this window */
  implicitClaimSeenMs: 18e5,
  /** warm heat window */
  warmMs: 864e5,
  /** SAME_DEV note window */
  sameDevMs: 6e5,
  /** an `asked` mark with no landing edit expires after this */
  askedExpiryMs: 12e4,
  /** a landing edit turns `asked` into a snooze of this length */
  snoozeMs: 18e5
};
var LIMITS = {
  hookStdoutChars: 9e3,
  preToolUseContextChars: 4e3,
  promptInboxChars: 1500,
  digestChars: 6e3,
  deltaDigestChars: 2e3,
  compactReinjectChars: 1500,
  hunkChars: 1500,
  turnTextChars: 3e3,
  promptWireChars: 2e3,
  objectiveChars: 140,
  draftBytes: 8192,
  journalLineBytes: 4096,
  journalRotateBytes: 65536,
  outboxDrainPerRun: 200,
  outboxInFlightMs: 3e4,
  outboxEphemeralMaxAgeMs: 864e5,
  outboxMaxAgeMs: 6048e5,
  payloadMaxBytes: 262144,
  /** client-side cap: a body this large is split or shrunk locally instead of drawing a 413 (§10.4) */
  payloadClientMaxBytes: 245760,
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
  changeSetMergeWindowMs: 18e5,
  changeSetExpiryMs: 6048e5,
  digestChangeSets: 5,
  digestDiffBlocks: 3,
  digestMessages: 10,
  digestHandoffs: 3,
  digestDecisions: 5,
  jitChangeSetsPerHook: 2,
  turnsPerSession: 40,
  turnsInPacket: 12,
  claimMaxTtlMs: 864e5,
  claimDefaultTtlMs: 144e5,
  tokenGraceMs: 12096e5
};
var PLACEHOLDER_PREFIX = "unknown-";
var DEFAULT_CONTRACT_GLOBS = [
  "**/contracts/**",
  "**/shared/**",
  "packages/*/src/index.ts",
  "**/*.contract.{ts,js}",
  "**/types/**",
  "**/*.d.ts",
  "**/schema.prisma",
  "**/*.prisma",
  "**/migrations/**",
  "**/openapi*.{json,yaml,yml}",
  "**/swagger*.{json,yaml,yml}",
  "**/*.graphql",
  "**/*.proto",
  "**/*.schema.{ts,json}",
  "**/api/**/route.ts",
  "**/routes/**",
  "**/zod/**",
  "**/*.env.example"
];
var GENERIC_BASENAMES = [
  "index",
  "types",
  "schema",
  "route",
  "routes",
  "client",
  "api",
  "utils",
  "constants"
];
var RELAY_CONFIG_DEFAULTS = {
  contracts: {
    globs: DEFAULT_CONTRACT_GLOBS,
    packages: [],
    export_scan: true,
    consumers: {}
  },
  impacts: { debounce_minutes: 3 },
  collision: { hot: "ask", claimed: "ask", warm: "context", same_dev: "note" },
  privacy: {
    send_prompts: false,
    send_turns: "prose",
    send_diffs: "contracts",
    objective_from_prompts: true
  },
  handoff: { llm: true, idle_minutes: 20 }
};
var LOCAL_PATHS = {
  identity: "identity.json",
  nodePath: "node-path",
  downUntil: "down-until",
  downCount: "down-count",
  configError: "config-error.json",
  refreshWanted: "refresh-wanted",
  pluginRemote: "plugin-remote.json",
  statusline: "statusline.sh",
  statuslineChain: "statusline-chain",
  lastError: "last-error",
  currentDir: "current",
  cacheDir: "cache",
  sessionsDir: "sessions",
  muteDir: "mute",
  outboxDir: "outbox",
  bgDir: "bg",
  logDir: "log",
  log: "log/relay.log",
  stats: "log/stats.jsonl"
};
var CACHE_FILES = {
  snapshot: "snapshot.json",
  digest: "digest.md",
  statusline: "statusline.txt",
  ancestry: "ancestry.json",
  state: "state.json"
};
var SESSION_FILES = {
  meta: "meta.json",
  events: "events.jsonl",
  fold: "fold.json",
  marksDir: "marks",
  pending: "pending",
  draft: "draft.json",
  lockDir: ".lock"
};
var JOURNAL_KINDS = [
  "edit",
  "prompt",
  "objective",
  "contract",
  "commit",
  "task",
  "turn",
  "cwd",
  "branch",
  "end"
];
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isString(x) {
  return typeof x === "string";
}
function isStringArray(x) {
  return Array.isArray(x) && x.every(isString);
}
function isSnapshot(x) {
  if (!isRecord(x) || x["v"] !== PROTOCOL_VERSION || !isString(x["serverTime"])) return false;
  const repo = x["repo"];
  const me = x["me"];
  return isRecord(repo) && isString(repo["slug"]) && isRecord(me) && isString(me["dev"]) && Array.isArray(x["sessions"]) && Array.isArray(x["heat"]) && Array.isArray(x["claims"]) && Array.isArray(x["changeSets"]) && Array.isArray(x["inbox"]);
}
function isCachedSnapshot(x) {
  return isSnapshot(x) && isString(x["fetchedAt"]);
}
function isSessionMeta(x) {
  return isRecord(x) && x["v"] === 1 && isString(x["sessionId"]) && isString(x["dev"]) && isString(x["repo"]) && isString(x["repoKey"]) && isString(x["repoRoot"]) && isString(x["branch"]) && isString(x["startedAt"]);
}
function isJournalEntry(x) {
  return isRecord(x) && isString(x["at"]) && isString(x["t"]) && JOURNAL_KINDS.includes(x["t"]);
}
function isOutboxEntry(x) {
  return isRecord(x) && x["v"] === 1 && isString(x["id"]) && isString(x["sessionId"]) && isString(x["at"]) && isString(x["kind"]) && isString(x["endpoint"]) && typeof x["ephemeral"] === "boolean" && isRecord(x["body"]);
}
function isCurrentFile(x) {
  return isRecord(x) && x["v"] === 1 && isString(x["sessionId"]) && isString(x["cwd"]) && isString(x["repoKey"]) && isString(x["dev"]) && isString(x["at"]) && typeof x["pid"] === "number";
}
function isHookInput(x) {
  return isRecord(x) && isString(x["session_id"]) && isString(x["hook_event_name"]) && isString(x["cwd"]);
}
function isRelayConfig(x) {
  if (!isRecord(x)) return false;
  if ("project" in x && x["project"] !== void 0 && !isString(x["project"])) return false;
  if ("repo" in x && x["repo"] !== void 0 && !isString(x["repo"])) return false;
  if ("areas" in x && x["areas"] !== void 0) {
    const areas = x["areas"];
    if (!isRecord(areas)) return false;
    for (const area of Object.values(areas)) {
      if (!isRecord(area) || !isStringArray(area["paths"])) return false;
    }
  }
  return true;
}
function isTeamConfig(x) {
  return isRecord(x) && isString(x["hub"]) && isString(x["team"]) && isString(x["token"]) && isRecord(x["members"]);
}
function editToolPath(input) {
  if (!isRecord(input)) return null;
  const p = input["file_path"] ?? input["notebook_path"];
  return isString(p) && p.length > 0 ? p : null;
}

// ../core/src/util.ts
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  promises as fsp
} from "node:fs";
import { dirname, join } from "node:path";
function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}
function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}
function parseIso(iso) {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
function shortTime(iso) {
  const t = typeof iso === "number" ? iso : parseIso(iso);
  if (t === null) return "??:??Z";
  return new Date(t).toISOString().slice(11, 19) + "Z";
}
function hhmm(iso) {
  const t = typeof iso === "number" ? iso : parseIso(iso);
  if (t === null) return "??:??Z";
  return new Date(t).toISOString().slice(11, 16) + "Z";
}
function dateTimeZ(iso) {
  const t = typeof iso === "number" ? iso : parseIso(iso);
  if (t === null) return "unknown";
  return new Date(t).toISOString().slice(0, 16) + "Z";
}
function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.round(ms / 6e4);
  if (m < 1) return `${Math.round(ms / 1e3)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function truncateWords(text, max) {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return head.trimEnd() + "\u2026";
}
function inlineText(text, max = 500) {
  if (!text) return "";
  return truncateWords(neutralizeRelayTags(text.replace(/\s+/g, " ").trim()), max);
}
function neutralizeRelayTags(text) {
  return text.replace(/<\s*(\/?)\s*relay-/gi, "\u2039$1relay-");
}
function truncateLines(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return (nl > max * 0.5 ? cut.slice(0, nl) : cut).trimEnd();
}
function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    ensureDir(dirname(path));
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
    }
    return false;
  }
}
function writeJsonAtomic(path, value, pretty = false) {
  return writeAtomic(path, pretty ? JSON.stringify(value, null, 2) + "\n" : JSON.stringify(value));
}
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
function removeFile(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

// ../core/src/ulid.ts
import { randomBytes } from "node:crypto";
var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var TIME_LEN = 10;
var RANDOM_LEN = 16;
var lastTime = -1;
var lastRandom = [];
function encodeTime(time) {
  let out = "";
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod] + out;
    t = (t - mod) / 32;
  }
  return out;
}
function freshRandom() {
  const bytes = randomBytes(RANDOM_LEN);
  const out = [];
  for (let i = 0; i < RANDOM_LEN; i++) out.push((bytes[i] ?? 0) % 32);
  return out;
}
function increment(digits) {
  const out = digits.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = (out[i] ?? 0) + 1;
    if (v < 32) {
      out[i] = v;
      return out;
    }
    out[i] = 0;
  }
  return out;
}
function ulid(now) {
  const explicit = now !== void 0;
  const time = Math.max(0, Math.floor(now ?? Date.now()));
  if (time === lastTime) {
    lastRandom = increment(lastRandom);
  } else if (time > lastTime) {
    lastTime = time;
    lastRandom = freshRandom();
  } else if (explicit) {
    return encodeTime(time) + freshRandom().map((d) => ENCODING[d] ?? "0").join("");
  } else {
    lastRandom = increment(lastRandom);
  }
  const rand = lastRandom.map((d) => ENCODING[d] ?? "0").join("");
  return encodeTime(lastTime) + rand;
}
function ulidTime(id) {
  if (!isUlid(id)) return null;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id.charAt(i).toUpperCase());
    if (idx < 0) return null;
    t = t * 32 + idx;
  }
  return t;
}
function isUlid(id) {
  return typeof id === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(id);
}

// ../core/src/glob.ts
var cache = /* @__PURE__ */ new Map();
function globToRegExp(glob) {
  const cached = cache.get(glob);
  if (cached) return cached;
  let src = "";
  let i = 0;
  const matchBase = !glob.includes("/");
  const g = glob.replace(/^\.\//, "");
  while (i < g.length) {
    const c = g[i] ?? "";
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          src += "(?:.*/)?";
          i += 3;
        } else {
          src += ".*";
          i += 2;
        }
      } else {
        src += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      src += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) {
        src += "\\{";
        i += 1;
      } else {
        const alts = g.slice(i + 1, end).split(",").map((a) => globToRegExp(a).source.replace(/^\^(?:\(\?:\.\*\/\)\?)?/, "").replace(/\$$/, ""));
        src += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end < 0) {
        src += "\\[";
        i += 1;
      } else {
        src += g.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      src += c.replace(/[.+^$()|\\]/g, "\\$&");
      i += 1;
    }
  }
  const re = new RegExp(`^${matchBase ? "(?:.*/)?" : ""}${src}$`);
  cache.set(glob, re);
  return re;
}
function matchGlob(glob, path) {
  const p = path.replace(/^\.\//, "");
  if (globToRegExp(glob).test(p)) return true;
  if (!/[*?{[]/.test(glob)) {
    const prefix = glob.replace(/\/+$/, "");
    return p === prefix || p.startsWith(prefix + "/");
  }
  return false;
}
function matchAny(globs, path) {
  for (const g of globs) if (matchGlob(g, path)) return g;
  return null;
}
function isGlobPattern(s) {
  return /[*?{[]/.test(s);
}

// ../core/src/repo.ts
import { realpathSync } from "node:fs";
import { basename, dirname as dirname2, isAbsolute, join as join2, posix, relative, resolve, sep } from "node:path";
function normalizeOriginUrl(url) {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;
  if (/^file:\/\//i.test(u)) return localSlug(u.replace(/^file:\/\//i, ""));
  if (u.startsWith("/") || u.startsWith(".") || /^[A-Za-z]:[\\/]/.test(u)) return localSlug(u);
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  let host;
  let path;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
    if (!m) return null;
    host = m[1] ?? "";
    path = m[2] ?? "";
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!host || !path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}
function localSlug(rootOrUrl) {
  const cleaned = rootOrUrl.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const base = basename(cleaned) || "repo";
  return `local/${base.toLowerCase()}`;
}
function repoKey(slug) {
  return sha1(slug).slice(0, 12);
}
function defaultProject(slug) {
  const parts = slug.split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] ?? "").includes(".")) return parts.slice(1).join("/");
  return slug;
}
function realpathBestEffort(path) {
  let current = resolve(path);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join2(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname2(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
  return resolve(path);
}
function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join(posix.sep);
}
function isPathUnder(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function toRepoRelative(filePath, repoRoot, cwd) {
  if (!filePath) return null;
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd ?? repoRoot, filePath);
  const candidates = [
    [abs, resolve(repoRoot)],
    [realpathBestEffort(abs), realpathBestEffort(repoRoot)]
  ];
  for (const [file, root] of candidates) {
    const rel = relative(root, file);
    if (rel === "") return null;
    if (!rel.startsWith("..") && !isAbsolute(rel)) return toPosix(rel);
  }
  return null;
}
function worktreeName(toplevel, gitDir, commonDir, baseDir = toplevel) {
  if (!gitDir || !commonDir) return null;
  const a = realpathBestEffort(resolve(baseDir, gitDir));
  const b = realpathBestEffort(resolve(baseDir, commonDir));
  if (a === b) return null;
  return basename(toplevel) || null;
}
function inferAreaFromPath(path) {
  const parts = path.replace(/^\.\//, "").split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  if (parts.length === 2) return parts[0] ?? "root";
  return `${parts[0]}/${parts[1]}`;
}

// ../core/src/config.ts
import { homedir, hostname } from "node:os";
import { join as join3 } from "node:path";
function relayHome(env = process.env) {
  const h = env["RELAY_HOME"];
  return h && h.trim() ? h : join3(homedir(), ".relay");
}
function readEnv(env = process.env) {
  const str = (k) => {
    const v = env[k];
    return v && v.trim() ? v.trim() : null;
  };
  const ttl = str("RELAY_SNAPSHOT_TTL_MS");
  const pid = str("CLAUDE_PID");
  return {
    home: relayHome(env),
    dev: str("RELAY_DEV"),
    hub: str("RELAY_HUB"),
    token: str("RELAY_TOKEN"),
    node: str("RELAY_NODE"),
    debug: str("RELAY_DEBUG") === "1",
    disable: str("RELAY_DISABLE") === "1",
    interactive: str("RELAY_INTERACTIVE") !== "0",
    snapshotTtlMs: ttl && /^\d+$/.test(ttl) ? Number(ttl) : null,
    bg: str("RELAY_BG") === "1",
    project: str("RELAY_PROJECT"),
    pluginRoot: str("CLAUDE_PLUGIN_ROOT"),
    envFile: str("CLAUDE_ENV_FILE"),
    entrypoint: str("CLAUDE_CODE_ENTRYPOINT"),
    pid: pid && /^\d+$/.test(pid) ? Number(pid) : null,
    sessionId: str("CLAUDE_CODE_SESSION_ID"),
    user: str("USER") ?? str("LOGNAME"),
    hostname: safeHostname()
  };
}
function safeHostname() {
  try {
    return hostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}
function resolveContractGlobs(configured) {
  if (!configured || configured.length === 0) return [...DEFAULT_CONTRACT_GLOBS];
  const plus = configured.filter((g) => g.startsWith("+")).map((g) => g.slice(1).trim()).filter(Boolean);
  const plain = configured.filter((g) => !g.startsWith("+")).map((g) => g.trim()).filter(Boolean);
  const base = plain.length > 0 ? plain : [...DEFAULT_CONTRACT_GLOBS];
  return [...plus, ...base];
}
function configHash(raw) {
  return raw ? sha1(canonicalJson(raw)) : null;
}
function resolveRelayConfig(raw, ctx) {
  const cfg = raw ?? {};
  const areas = {};
  for (const [name, area] of Object.entries(cfg.areas ?? {})) {
    if (!isRecord(area) || !Array.isArray(area.paths)) continue;
    areas[name] = {
      paths: area.paths.filter((x) => typeof x === "string"),
      ...Array.isArray(area.owners) ? { owners: area.owners.filter((x) => typeof x === "string") } : {},
      ...area.shared ? { shared: true } : {}
    };
  }
  const d = RELAY_CONFIG_DEFAULTS;
  const c = cfg.contracts ?? {};
  return {
    project: cfg.project?.trim() || ctx.project || defaultProject(cfg.repo ?? ctx.slug),
    repo: cfg.repo?.trim() || ctx.slug,
    areas,
    contracts: {
      globs: resolveContractGlobs(c.globs),
      packages: (c.packages ?? d.contracts.packages).filter((x) => typeof x === "string"),
      export_scan: c.export_scan ?? d.contracts.export_scan,
      consumers: isRecord(c.consumers) ? c.consumers : { ...d.contracts.consumers }
    },
    depends: isRecord(cfg.depends) ? cfg.depends : {},
    impacts: { debounce_minutes: numberOr(cfg.impacts?.debounce_minutes, d.impacts.debounce_minutes) },
    collision: {
      hot: cfg.collision?.hot ?? d.collision.hot,
      claimed: cfg.collision?.claimed ?? d.collision.claimed,
      warm: cfg.collision?.warm ?? d.collision.warm,
      same_dev: cfg.collision?.same_dev ?? d.collision.same_dev
    },
    privacy: {
      send_prompts: cfg.privacy?.send_prompts ?? d.privacy.send_prompts,
      send_turns: cfg.privacy?.send_turns ?? d.privacy.send_turns,
      send_diffs: cfg.privacy?.send_diffs ?? d.privacy.send_diffs,
      objective_from_prompts: cfg.privacy?.objective_from_prompts ?? d.privacy.objective_from_prompts
    },
    handoff: {
      llm: cfg.handoff?.llm ?? d.handoff.llm,
      idle_minutes: numberOr(cfg.handoff?.idle_minutes, d.handoff.idle_minutes)
    }
  };
}
function numberOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}
function loadRelayConfig(repoRoot, ctx) {
  const path = join3(repoRoot, ".relay.json");
  const text = readText(path);
  let raw = null;
  let invalid = false;
  if (text !== null) {
    try {
      const parsed = JSON.parse(stripJsonComments(text));
      if (isRelayConfig(parsed)) raw = parsed;
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  return { raw, resolved: resolveRelayConfig(raw, ctx), hash: configHash(raw), path, invalid };
}
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i] ?? "";
    const n = text[i + 1] ?? "";
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function loadTeamConfig(env) {
  let team = null;
  if (env.pluginRoot) {
    const parsed = readJson(join3(env.pluginRoot, "team.json"));
    if (isTeamConfig(parsed)) team = parsed;
  }
  if (!team && env.hub && env.token) {
    team = { hub: env.hub, team: "env", token: env.token, members: {} };
  }
  if (!team) return null;
  return {
    ...team,
    hub: (env.hub ?? team.hub).replace(/\/+$/, ""),
    token: env.token ?? team.token
  };
}
function resolvePluginSha(env, claudeHome = join3(homedir(), ".claude")) {
  const installed = readJson(join3(claudeHome, "plugins", "installed_plugins.json"));
  if (isRecord(installed) && isRecord(installed["plugins"])) {
    const entry = installed["plugins"]["relay@relay"];
    const list = Array.isArray(entry) ? entry : isRecord(entry) ? [entry] : [];
    for (const item of list) {
      if (isRecord(item) && typeof item["gitCommitSha"] === "string" && item["gitCommitSha"]) {
        return item["gitCommitSha"];
      }
    }
  }
  if (env.pluginRoot) {
    const manifest = readJson(join3(env.pluginRoot, ".claude-plugin", "plugin.json"));
    if (isRecord(manifest) && typeof manifest["version"] === "string" && manifest["version"]) {
      return manifest["version"];
    }
    const base = env.pluginRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return base || null;
  }
  return null;
}

// ../core/src/identity.ts
import { join as join4 } from "node:path";
var CACHE_MS = 24 * 60 * 60 * 1e3;
function placeholderHandle(hostname2, user) {
  return PLACEHOLDER_PREFIX + sha1(`${hostname2}${user ?? ""}`).slice(0, 6);
}
function isPlaceholderHandle(dev) {
  return dev.startsWith(PLACEHOLDER_PREFIX);
}
function memberByEmail(team, email) {
  if (!team || !email) return null;
  const needle = email.trim().toLowerCase();
  for (const [handle, member] of Object.entries(team.members)) {
    if (Array.isArray(member.emails) && member.emails.some((e) => e.toLowerCase() === needle)) return handle;
  }
  return null;
}
function authorEmails(team, dev, gitEmail) {
  const set = /* @__PURE__ */ new Set();
  const member = team?.members[dev];
  for (const e of member?.emails ?? []) if (e) set.add(e.toLowerCase());
  if (gitEmail) set.add(gitEmail.toLowerCase());
  return [...set];
}
function resolveIdentityFrom(input) {
  const now = input.now ?? Date.now();
  const team = input.team;
  const finish = (dev, source) => ({
    dev,
    source,
    placeholder: isPlaceholderHandle(dev),
    emails: authorEmails(team, dev, input.gitEmail)
  });
  if (input.envDev) return finish(input.envDev, "env");
  const file = input.file;
  if (file && file.source === "identity-file" && file.dev) return finish(file.dev, "identity-file");
  if (file && file.dev && file.source !== "placeholder") {
    const at = parseIso(file.at) ?? 0;
    const sameEmail = (file.gitEmail ?? null) === (input.gitEmail ?? null);
    if (sameEmail && now - at < CACHE_MS && now >= at) return finish(file.dev, file.source);
  }
  const byEmail = memberByEmail(team, input.gitEmail);
  if (byEmail) return finish(byEmail, "git-email");
  const noreply = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(input.gitEmail ?? "");
  if (noreply && team) {
    const login = (noreply[1] ?? "").toLowerCase();
    for (const [handle, member] of Object.entries(team.members)) {
      if (member.github && member.github.toLowerCase() === login) return finish(handle, "github-noreply");
    }
  }
  const local = (input.gitEmail ?? "").split("@")[0]?.toLowerCase() ?? "";
  if (local && team && Object.keys(team.members).some((h) => h.toLowerCase() === local)) {
    return finish(matchHandle(team, local), "email-local");
  }
  const user = (input.user ?? "").toLowerCase();
  if (user && team && Object.keys(team.members).some((h) => h.toLowerCase() === user)) {
    return finish(matchHandle(team, user), "user");
  }
  return finish(placeholderHandle(input.hostname, input.user), "placeholder");
}
function matchHandle(team, lower) {
  return Object.keys(team.members).find((h) => h.toLowerCase() === lower) ?? lower;
}
function isIdentityFile(x) {
  return isRecord(x) && typeof x["dev"] === "string" && typeof x["source"] === "string" && typeof x["at"] === "string";
}
function identityPath(home) {
  return join4(home, LOCAL_PATHS.identity);
}
function readIdentityFile(home) {
  const v = readJson(identityPath(home));
  return isIdentityFile(v) ? v : null;
}
function writeIdentityFile(home, file) {
  return writeJsonAtomic(identityPath(home), file, true);
}
function resolveIdentity(home, input) {
  const file = input.file === void 0 ? readIdentityFile(home) : input.file;
  const result = resolveIdentityFrom({ ...input, file });
  const now = input.now ?? Date.now();
  const cacheable = result.source !== "env" && result.source !== "placeholder";
  const unchanged = file && file.dev === result.dev && file.source === result.source && (file.gitEmail ?? null) === (input.gitEmail ?? null) && now - (parseIso(file.at) ?? 0) < CACHE_MS;
  if (cacheable && !unchanged) {
    writeIdentityFile(home, { dev: result.dev, source: result.source, at: nowIso(now), gitEmail: input.gitEmail ?? null });
  }
  return result;
}

// ../core/src/git.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
var GIT_ENV_OVERRIDES = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
function gitBudgetMs() {
  const raw = Number.parseInt(process.env["RELAY_GIT_BUDGET_MS"] ?? "", 10);
  if (!Number.isFinite(raw)) return BUDGET_MS.gitRevParse;
  return Math.min(2500, Math.max(100, raw));
}
function runGit(cwd, args2, opts = {}) {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? gitBudgetMs();
  return new Promise((resolve2) => {
    if (opts.signal?.aborted) {
      resolve2({ ok: false, code: null, stdout: "", stderr: "aborted", timedOut: true, ms: 0 });
      return;
    }
    let child;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      resolve2(r);
    };
    const onAbort = () => {
      try {
        child?.kill("SIGKILL");
      } catch {
      }
      finish({ ok: false, code: null, stdout: "", stderr: "aborted", timedOut: true, ms: Date.now() - started });
    };
    try {
      child = execFile(
        "git",
        ["-C", cwd, ...args2],
        {
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
          env: { ...opts.env ?? process.env, ...GIT_ENV_OVERRIDES },
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const ms = Date.now() - started;
          if (error) {
            const e = error;
            const timedOut = Boolean(e.killed) || e.signal === "SIGKILL" || e.signal === "SIGTERM";
            finish({
              ok: false,
              code: typeof e.code === "number" ? e.code : null,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? e.message ?? ""),
              timedOut,
              ms
            });
            return;
          }
          finish({ ok: true, code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: false, ms });
        }
      );
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (child.stdin) {
        child.stdin.on("error", () => void 0);
        if (opts.input !== void 0) child.stdin.end(opts.input);
        else child.stdin.end();
      }
    } catch (err) {
      finish({ ok: false, code: null, stdout: "", stderr: String(err), timedOut: false, ms: Date.now() - started });
    }
  });
}
function firstLine(r) {
  if (!r.ok) return null;
  const first = r.stdout.split("\n")[0]?.trim() ?? "";
  return first.length ? first : null;
}
async function line(cwd, args2, opts) {
  return firstLine(await runGit(cwd, args2, opts));
}
var REV_PARSE_ARGS = [
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--git-dir"],
  ["rev-parse", "--git-common-dir"],
  ["rev-parse", "HEAD"],
  ["rev-parse", "--abbrev-ref", "HEAD"],
  ["remote", "get-url", "origin"],
  ["config", "user.email"]
];
async function revParseSet(cwd, opts) {
  const o = { timeoutMs: gitBudgetMs(), ...opts };
  const first = await Promise.all(REV_PARSE_ARGS.map((args2) => runGit(cwd, [...args2], o)));
  const values = first.map((r) => firstLine(r));
  const timedOut = first.map((r) => r.timedOut);
  const retry = first.map((r, i) => r.timedOut && !opts?.signal?.aborted ? i : -1).filter((i) => i >= 0);
  if (retry.length > 0) {
    const again = await Promise.all(retry.map((i) => runGit(cwd, [...REV_PARSE_ARGS[i]], o)));
    again.forEach((r, k) => {
      const i = retry[k];
      values[i] = firstLine(r);
      timedOut[i] = r.timedOut;
    });
  }
  const [toplevel, gitDir, commonDir, head, abbrev, originUrl, userEmail] = values;
  const incomplete = timedOut.some(Boolean) || opts?.signal?.aborted === true;
  return { toplevel, gitDir, commonDir, head, branch: branchName(abbrev, head), originUrl, userEmail, incomplete };
}
async function gitHeadBefore(cwd, iso, opts) {
  const v = await line(cwd, ["rev-list", "-1", `--before=${iso}`, "HEAD"], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  return v && /^[0-9a-f]{40}$/.test(v) ? v : null;
}
function branchName(abbrev, head) {
  if (!abbrev) return head ? `detached@${head.slice(0, 7)}` : null;
  if (abbrev === "HEAD") return head ? `detached@${head.slice(0, 7)}` : "detached";
  return abbrev;
}
async function gitHead(cwd, opts) {
  return line(cwd, ["rev-parse", "HEAD"], opts);
}
async function gitBranch(cwd, opts) {
  const [abbrev, head] = await Promise.all([line(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], opts), gitHead(cwd, opts)]);
  return branchName(abbrev, head);
}
async function gitBlobAt(cwd, rev, path, opts) {
  return line(cwd, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], opts);
}
async function gitRecentShas(cwd, n = LIMITS.recentShas, opts) {
  const r = await runGit(cwd, ["log", "--format=%H", `-n${n}`], opts);
  if (!r.ok) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s));
}
var GENERATED_PATH_PATTERNS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|__pycache__|target|\.venv|venv)\//,
  /\.(min\.js|min\.css|map|log|tsbuildinfo)$/,
  /(^|\/)\.DS_Store$/
];
function isGeneratedPath(path) {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(path));
}
function parsePorcelain(stdout) {
  const out = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length < 4) continue;
    let rest = raw.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (rest) out.push(rest.replace(/\/$/, ""));
  }
  return out;
}
async function gitDirtyPaths(cwd, opts = {}) {
  const r = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all", "--no-renames"], {
    timeoutMs: BUDGET_MS.gitDiff,
    ...opts
  });
  if (!r.ok) return null;
  const cap = opts.cap ?? LIMITS.dirtyPathsCap;
  return parsePorcelain(r.stdout).filter((p) => !isGeneratedPath(p)).slice(0, cap);
}
function authorRegex(emails) {
  const parts = emails.map((e) => e.trim()).filter(Boolean).map(escapeRegExp);
  return parts.length ? `<(${parts.join("|")})>` : null;
}
async function gitOwnCommits(cwd, params, opts) {
  const author = authorRegex(params.emails);
  if (!author) return [];
  const cap = params.cap ?? LIMITS.commitBackfillCap;
  const range = params.from ? `${params.from}..${params.to ?? "HEAD"}` : params.to ?? "HEAD";
  const r = await runGit(
    cwd,
    ["log", "--no-merges", "--extended-regexp", "--regexp-ignore-case", `--author=${author}`, "--format=%H%x09%ae%x09%s", `-n${cap}`, range],
    { timeoutMs: BUDGET_MS.gitDiff, ...opts }
  );
  if (!r.ok) return null;
  const out = [];
  for (const l of r.stdout.split("\n")) {
    const [sha, authorEmail, ...subject] = l.split("	");
    if (sha && /^[0-9a-f]{40}$/.test(sha)) out.push({ sha, authorEmail: authorEmail ?? "", subject: subject.join("	") });
  }
  return out;
}
async function gitCommitFiles(cwd, sha, opts) {
  const r = await runGit(cwd, ["diff-tree", "-r", "--no-commit-id", "--name-only", sha], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (!r.ok) return null;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
async function gitIsTracked(cwd, path, opts) {
  const r = await runGit(cwd, ["ls-files", "--error-unmatch", "--", path], opts);
  return r.ok;
}
async function gitDiffU0(cwd, path, opts = {}) {
  const maxBytes = opts.maxBytes ?? 4096;
  const r = await runGit(cwd, ["diff", "-U0", "-w", "--no-color", "--no-ext-diff", "HEAD", "--", path], {
    timeoutMs: BUDGET_MS.gitDiff,
    ...opts
  });
  if (r.ok) {
    if (r.stdout.trim().length > 0) return truncateLines(r.stdout, maxBytes);
    const tracked = await gitIsTracked(cwd, path, opts);
    if (tracked) return "";
    return syntheticAddedDiff(cwd, path, maxBytes);
  }
  if (/bad revision|ambiguous argument 'HEAD'|unknown revision/i.test(r.stderr)) return syntheticAddedDiff(cwd, path, maxBytes);
  return null;
}
async function syntheticAddedDiff(cwd, path, maxBytes) {
  try {
    const text = await readFile(`${cwd}/${path}`, "utf8");
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const body = lines.map((l) => `+${l}`).join("\n");
    return truncateLines(`--- /dev/null
+++ b/${path}
@@ -0,0 +1,${lines.length} @@
${body}`, maxBytes);
  } catch {
    return null;
  }
}
async function gitShowU0(cwd, sha, files, opts = {}) {
  if (!files.length) return "";
  const r = await runGit(cwd, ["show", "-U0", "-w", "--no-color", "--format=", sha, "--", ...files], {
    timeoutMs: BUDGET_MS.gitDiff,
    ...opts
  });
  return r.ok ? truncateLines(r.stdout, opts.maxBytes ?? 8192) : null;
}
async function gitShowFile(cwd, rev, path, opts = {}) {
  const r = await runGit(cwd, ["show", `${rev}:${path}`], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  return r.ok ? r.stdout.slice(0, opts.maxBytes ?? 256 * 1024) : null;
}
async function gitHashObject(cwd, path, opts) {
  return line(cwd, ["hash-object", "--", path], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
}
async function gitPatchId(cwd, sha, opts) {
  const diff = await runGit(cwd, ["diff-tree", "-p", "--no-color", sha], { timeoutMs: BUDGET_MS.gitDiff, maxBuffer: 16 * 1024 * 1024, ...opts });
  if (!diff.ok || !diff.stdout) return null;
  const pid = await runGit(cwd, ["patch-id", "--stable"], { timeoutMs: BUDGET_MS.gitDiff, ...opts, input: diff.stdout });
  if (!pid.ok) return null;
  const first = pid.stdout.split("\n")[0]?.trim().split(" ")[0] ?? "";
  return /^[0-9a-f]{40}$/.test(first) ? first : null;
}
async function gitMergeBase(cwd, a, b, opts) {
  return line(cwd, ["merge-base", a, b], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
}
async function gitIsAncestor(cwd, sha, of = "HEAD", opts) {
  const r = await runGit(cwd, ["merge-base", "--is-ancestor", sha, of], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (r.ok) return true;
  if (r.timedOut) return null;
  if (r.code === 1) return false;
  return null;
}
async function gitHeadOnRemote(cwd, opts) {
  const r = await runGit(cwd, ["branch", "-r", "--contains", "HEAD"], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (!r.ok) return null;
  return r.stdout.trim().length > 0;
}
async function gitGrep(cwd, pattern, opts = {}) {
  const mode = opts.mode ?? "files";
  const args2 = ["grep", "-I", "-E", "--no-color", mode === "files" ? "-l" : "-n", "-e", pattern, "--", ...opts.pathspecs ?? []];
  const r = await runGit(cwd, args2, { timeoutMs: BUDGET_MS.gitGrep, maxBuffer: 32 * 1024 * 1024, ...opts });
  if (r.ok) {
    const lines = r.stdout.split("\n").filter(Boolean);
    return opts.cap ? lines.slice(0, opts.cap) : lines;
  }
  if (r.code === 1 && !r.timedOut) return [];
  return null;
}
async function gitLsRemoteHead(dir, remote = "origin", opts) {
  const r = await runGit(dir, ["ls-remote", remote, "HEAD"], { timeoutMs: 1e3, ...opts });
  if (!r.ok) return null;
  const sha = r.stdout.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// ../core/src/area.ts
function areasOfPath(path, areas) {
  const names = Object.keys(areas);
  if (names.length === 0) return [inferAreaFromPath(path)];
  const out = [];
  for (const name of names) {
    const area = areas[name];
    if (area && matchAny(area.paths, path)) out.push(name);
  }
  return out;
}
function areaOfPath(path, areas) {
  const all = areasOfPath(path, areas);
  const nonShared = all.find((n) => !areas[n]?.shared);
  return nonShared ?? all[0] ?? null;
}
function recencyWeight(atMs, now) {
  const minutes = Math.max(0, now - atMs) / 6e4;
  return 3 / (1 + minutes / 10);
}
function areaFromBranch(branch, areaNames) {
  if (!branch) return null;
  const tokens = new Set(branch.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const name of areaNames) if (tokens.has(name.toLowerCase())) return name;
  return null;
}
function voteArea(input) {
  const now = input.now ?? Date.now();
  const areas = input.areas;
  const names = Object.keys(areas);
  const scores = {};
  for (const edit of input.recentEdits.slice(0, 20)) {
    const at = parseIso(edit.at) ?? now;
    const w = recencyWeight(at, now);
    for (const name of areasOfPath(edit.path, areas)) scores[name] = (scores[name] ?? 0) + w;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shared = ranked.filter(([n]) => areas[n]?.shared).map(([n]) => n);
  const primaryRanked = ranked.filter(([n]) => !areas[n]?.shared);
  const top = primaryRanked[0];
  const second = primaryRanked[1];
  const tie = top && second && Math.abs(top[1] - second[1]) < 1e-9;
  const finish = (area, source) => ({
    area,
    display: shared.length && !shared.includes(area) ? `${area} (+${shared.join(", +")})` : area,
    shared,
    scores,
    source
  });
  if (top && !tie) return finish(top[0], "edits");
  const candidates = tie ? primaryRanked.filter(([, s]) => Math.abs(s - top[1]) < 1e-9).map(([n]) => n) : names;
  const byBranch = areaFromBranch(input.branch, candidates);
  if (byBranch) return finish(byBranch, "branch");
  if (input.dev) {
    const owned = candidates.find((n) => areas[n]?.owners?.includes(input.dev));
    if (owned) return finish(owned, "owner");
  }
  if (tie && top) return finish(top[0], "edits");
  if (input.cwdRel && input.cwdRel !== "." && input.cwdRel !== "") {
    const seg = input.cwdRel.split("/").filter(Boolean);
    const first = seg[0] ?? "";
    const covering = areaOfPath(`${input.cwdRel}/.`, areas);
    if (covering && names.length) return finish(covering, "cwd");
    const guess = seg.length >= 2 && /^(apps|packages|libs|services|modules)$/.test(first) ? seg[1] ?? first : first;
    if (guess) return finish(guess, "cwd");
  }
  if (shared.length) return { area: shared[0], display: shared[0], shared, scores, source: "edits" };
  return finish("unknown", "unknown");
}

// ../core/src/redact.ts
var REDACTED = "[redacted]";
var PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\brt_[A-Za-z0-9]{32,}\b/g,
  // Relay team token (§11.1)
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // JWT
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/g
  // Slack incoming webhook (the path is the secret)
];
var AUTH_HEADER = /(\bauthorization\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?(['"]?)([^\s'",;]+)\3/gi;
var KEY_VALUE = /\b([\w-]*?(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|refresh[_-]?token|session[_-]?token|apikey)\b[\w.-]*)(\s*[:=]\s*)(['"`]?)([^\s'"`,;&)]{4,})\3/gi;
var URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:)([^\s@\/]+)(@)/gi;
var AWS_SECRET = /(aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})/gi;
var PLACEHOLDER_VALUE = /^(\$\{?[\w.]+\}?|<[^>]+>|[xX]+|\*+|\.{3}|process\.env\.[\w.]+|env\.[\w.]+|[A-Z_]{4,}|null|undefined|true|false|none|None|NULL|redacted|\[redacted\])$/;
function shannonEntropy(s) {
  const counts = /* @__PURE__ */ new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
function looksLikeSecretToken(token) {
  if (token.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false;
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(token)) return false;
  return shannonEntropy(token) >= 4.2;
}
var BASE64ISH = /[A-Za-z0-9+/=_-]{32,}/g;
function redact(text) {
  if (!text) return "";
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_HEADER, (_m, pre, scheme) => `${pre}${scheme ? scheme + " " : ""}${REDACTED}`);
  out = out.replace(AWS_SECRET, (_m, pre) => `${pre}${REDACTED}`);
  out = out.replace(KEY_VALUE, (m, key, sep2, q, value) => {
    if (PLACEHOLDER_VALUE.test(value)) return m;
    return `${key}${sep2}${q}${REDACTED}${q}`;
  });
  out = out.replace(URL_USERINFO, (_m, pre, _pw, at) => `${pre}${REDACTED}${at}`);
  out = out.replace(BASE64ISH, (tok) => looksLikeSecretToken(tok) ? REDACTED : tok);
  return out;
}

// ../core/src/objective.ts
var STOPLIST = /^(y|yes|no|ok|okay|sure|go ahead|continue|proceed|thanks|thank you|do it|next|k|nope|yep|yeah|please)\b/i;
var IMPERATIVE = /^(add|fix|implement|refactor|update|remove|rename|migrate|write|build|create|change|make|move|wire|investigate|debug|test|convert|extract|split|merge|document|deploy)\b/i;
var PIVOT = /\b(now|next|instead|switch to)\b/i;
var OBJECTIVE_REPLACE_AFTER_MS = 10 * 6e4;
var OBJECTIVE_REPLACE_AFTER_TOOL_CALLS = 15;
function cleanPromptLine(prompt) {
  let text = prompt.replace(/\r/g, "");
  text = text.replace(/```[\s\S]*?```/g, " ").replace(/```[\s\S]*$/g, " ");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !/^\s*at\s+\S/.test(l) && !/^(Traceback|File ".*", line \d+)/.test(l));
  let first = lines[0] ?? "";
  first = first.replace(/https?:\/\/\S+/g, " ").replace(/(?:^|\s)@[\w./-]+/g, " ").replace(/(?:^|\s)(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g, " ").replace(/`[^`]*`/g, (m) => m.length > 40 ? " " : m).replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim();
  return first;
}
function nonAlphaRatio(text) {
  if (!text.length) return 1;
  const alpha = (text.match(/[A-Za-z]/g) ?? []).length;
  return 1 - alpha / text.length;
}
function candidateFromPrompt(prompt, opts = {}) {
  const raw = prompt.trimStart();
  if (raw.startsWith("/") || /^\[private\]/i.test(raw)) return null;
  const line2 = cleanPromptLine(prompt);
  if (line2.length < 25) return null;
  if (STOPLIST.test(line2)) return null;
  if (nonAlphaRatio(line2) >= 0.4) return null;
  if (opts.lastTurnWasQuestion && line2.length < 60) return null;
  return truncateWords(redact(line2), LIMITS.objectiveChars);
}
function humanizeBranch(branch) {
  if (!branch) return null;
  if (/^(main|master|develop|dev|trunk|head)$/i.test(branch) || branch.startsWith("detached@")) return null;
  const segments = branch.split("/").filter(Boolean);
  while (segments.length > 1 && /^[a-z]{1,12}$/i.test(segments[0] ?? "")) segments.shift();
  const s = segments.join(" ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length ? truncateWords(s, LIMITS.objectiveChars) : null;
}
function objectiveFromBranch(branch, repoSlug) {
  const h = humanizeBranch(branch);
  if (h) return h;
  const name = repoSlug.split("/").pop() || repoSlug;
  return `working in ${name}`;
}
function nextPromptObjective(current, candidate, now = Date.now()) {
  if (!candidate) return null;
  if (!current.text || current.source === "branch" || current.source === null) return candidate;
  if (candidate === current.text) return null;
  if (IMPERATIVE.test(candidate) || PIVOT.test(candidate)) return candidate;
  const setAt = parseIso(current.at);
  if (setAt !== null && now - setAt >= OBJECTIVE_REPLACE_AFTER_MS) return candidate;
  if (current.toolCallsSince >= OBJECTIVE_REPLACE_AFTER_TOOL_CALLS) return candidate;
  return null;
}
function deriveObjective(fold, ctx) {
  const openTask = fold.tasks.open[fold.tasks.open.length - 1];
  if (openTask && openTask.subject.trim()) return { text: truncateWords(redact(openTask.subject.trim()), LIMITS.objectiveChars), source: "task" };
  if (ctx.objectiveFromPrompts !== false && fold.objective.text && fold.objective.source !== "branch") {
    return { text: fold.objective.text, source: fold.objective.source ?? "prompt" };
  }
  return { text: objectiveFromBranch(ctx.branch, ctx.repoSlug), source: "branch" };
}

// ../core/src/symbols.ts
import { basename as basename2, extname } from "node:path";
function fileLang(path) {
  const base = basename2(path).toLowerCase();
  const ext = extname(base);
  if (/^(openapi|swagger)[^/]*\.(json|ya?ml)$/.test(base)) return "openapi";
  if (ext === ".prisma") return "prisma";
  if (ext === ".graphql" || ext === ".gql") return "graphql";
  if (ext === ".proto") return "proto";
  if (ext === ".sql" || /(^|\/)migrations\//.test(path.toLowerCase())) return ext === ".sql" || ext === "" ? "sql" : langByExt(ext);
  return langByExt(ext);
}
function langByExt(ext) {
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "ts";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".py":
      return "py";
    case ".go":
      return "go";
    default:
      return "other";
  }
}
var SUMMARY_MAX = 240;
var SIG_MAX = 100;
function sigOf(text) {
  let s = text.trim().replace(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?/, "");
  s = s.replace(/\s*(=>|\{|=)\s*$/, "");
  const cut = s.search(/\s*(\{|=>|=)(?![^(]*\))/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/\s+/g, " ").trim().replace(/[;,]$/, "");
  return s.length > SIG_MAX ? s.slice(0, SIG_MAX - 1) + "\u2026" : s;
}
function memberName(text) {
  const m = /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\??\s*[:(<]/.exec(text);
  return m ? m[1] ?? null : null;
}
function describeChanges(minus, plus) {
  const removed = minus.filter((n) => !plus.includes(n));
  const added = plus.filter((n) => !minus.includes(n));
  const changed = minus.filter((n) => plus.includes(n));
  const out = [];
  if (removed.length && removed.length === added.length) {
    removed.forEach((r, i) => out.push(`${r} \u2192 ${added[i]}`));
  } else {
    for (const r of removed) out.push(`-${r}`);
    for (const a of added) out.push(`+${a}`);
  }
  for (const c of changed) out.push(`~${c}`);
  return out;
}
function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}
function joinSummary(parts, fallback) {
  const s = parts.filter(Boolean).join("; ");
  if (!s) return fallback;
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1) + "\u2026" : s;
}
var TS_TOP_RE = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(type|interface|enum|class|function\*?|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/;
var TS_BLOCK_RE = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type|enum|class)\s+([A-Za-z_$][\w$]*)/;
var ZOD_RE = /\bz\.object\(/;
var TRPC_RE = /\b(router\(|\.procedure\b)/;
function extractTs(hunks) {
  const symbols = [];
  const kinds = [];
  const sigs = /* @__PURE__ */ new Map();
  const members = /* @__PURE__ */ new Map();
  for (const h of hunks) {
    const headerParent = TS_BLOCK_RE.exec(h.header)?.[1] ?? null;
    let parent = headerParent;
    let depth = headerParent ? 1 : 0;
    for (const l of h.lines) {
      const t = l.text;
      const top = TS_TOP_RE.exec(t);
      if (top) {
        const kind = top[1] ?? "";
        const name = top[2] ?? "";
        pushUnique(symbols, name);
        pushUnique(kinds, "export");
        if (l.sign !== " ") {
          const sc = sigs.get(name) ?? { minus: [], plus: [] };
          (l.sign === "-" ? sc.minus : sc.plus).push(sigOf(t));
          sigs.set(name, sc);
        }
        if (/^(interface|type|enum|class)$/.test(kind) && /\{\s*$/.test(t)) {
          parent = name;
          depth = 1;
        } else {
          parent = null;
          depth = 0;
        }
        if (ZOD_RE.test(t)) pushUnique(kinds, "zod");
        if (TRPC_RE.test(t)) pushUnique(kinds, "trpc");
        continue;
      }
      if (ZOD_RE.test(t)) pushUnique(kinds, "zod");
      if (TRPC_RE.test(t)) pushUnique(kinds, "trpc");
      if (parent) {
        const name = memberName(t);
        if (name && l.sign !== " ") {
          pushUnique(symbols, parent);
          pushUnique(kinds, "member");
          const mc = members.get(parent) ?? { minus: [], plus: [] };
          (l.sign === "-" ? mc.minus : mc.plus).push(name);
          members.set(parent, mc);
        }
        for (const c of t) {
          if (c === "{") depth += 1;
          else if (c === "}") depth -= 1;
        }
        if (depth <= 0) parent = null;
      }
    }
  }
  const parts = [];
  for (const [name, sc] of sigs) {
    const before = sc.minus[sc.minus.length - 1];
    const after = sc.plus[sc.plus.length - 1];
    const memberPart = members.get(name);
    if (before && after && before !== after) parts.push(`${before} \u2192 ${after}`);
    else if (after && !before) parts.push(`+${after}`);
    else if (before && !after) parts.push(`-${name}`);
    else if (!memberPart) parts.push(`~${name}`);
  }
  for (const [parent, mc] of members) {
    const desc = describeChanges(mc.minus, mc.plus);
    if (desc.length) parts.push(`${parent}: ${desc.join(", ")}`);
  }
  if (!kinds.length) kinds.push("file");
  return { symbols, kinds, summary: joinSummary(parts, symbols.length ? symbols.join(", ") : "") };
}
function extractPy(hunks) {
  const symbols = [];
  const minus = [];
  const plus = [];
  for (const h of hunks) {
    const headerName = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(h.header)?.[1];
    for (const l of h.lines) {
      const m = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(l.text);
      const name = m?.[1] ?? (l.sign !== " " ? headerName : void 0);
      if (!name) continue;
      pushUnique(symbols, name);
      if (m && l.sign === "-") minus.push(name);
      if (m && l.sign === "+") plus.push(name);
    }
  }
  const desc = describeChanges(minus, plus);
  return { symbols, kinds: symbols.length ? ["python"] : ["file"], summary: joinSummary(desc.length ? desc : symbols, "") };
}
function extractGo(hunks) {
  const symbols = [];
  const sigs = /* @__PURE__ */ new Map();
  for (const h of hunks) {
    const headerName = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/.exec(h.header);
    const parent = headerName?.[1] ?? headerName?.[2] ?? null;
    for (const l of h.lines) {
      const m = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/.exec(l.text);
      const name = m?.[1] ?? m?.[2] ?? (l.sign !== " " ? parent : null);
      if (!name) continue;
      pushUnique(symbols, name);
      if (m && l.sign !== " ") {
        const sc = sigs.get(name) ?? { minus: [], plus: [] };
        (l.sign === "-" ? sc.minus : sc.plus).push(sigOf(l.text));
        sigs.set(name, sc);
      }
    }
  }
  const parts = [];
  for (const [name, sc] of sigs) {
    const b = sc.minus[sc.minus.length - 1];
    const a = sc.plus[sc.plus.length - 1];
    if (b && a && b !== a) parts.push(`${b} \u2192 ${a}`);
    else if (a && !b) parts.push(`+${a}`);
    else if (b && !a) parts.push(`-${name}`);
  }
  return { symbols, kinds: symbols.length ? ["go"] : ["file"], summary: joinSummary(parts.length ? parts : symbols, "") };
}
function extractPrisma(hunks) {
  const symbols = [];
  const members = /* @__PURE__ */ new Map();
  for (const h of hunks) {
    let model = /^(?:model|enum|type)\s+(\w+)/.exec(h.header)?.[1] ?? null;
    for (const l of h.lines) {
      const m = /^\s*(?:model|enum|type)\s+(\w+)/.exec(l.text);
      if (m) {
        model = m[1] ?? null;
        pushUnique(symbols, model);
        continue;
      }
      if (/^\s*}/.test(l.text)) {
        model = null;
        continue;
      }
      if (model && l.sign !== " ") {
        const field = /^\s*(\w+)\s+\S/.exec(l.text)?.[1];
        if (!field || field.startsWith("@")) continue;
        pushUnique(symbols, model);
        const mc = members.get(model) ?? { minus: [], plus: [] };
        (l.sign === "-" ? mc.minus : mc.plus).push(field);
        members.set(model, mc);
      }
    }
  }
  const parts = [];
  for (const [model, mc] of members) {
    const desc = describeChanges(mc.minus, mc.plus);
    parts.push(desc.length ? `model ${model} ${desc.join(", ")}` : `model ${model}`);
  }
  for (const s of symbols) if (!members.has(s)) parts.push(`model ${s}`);
  return { symbols, kinds: symbols.length ? ["prisma"] : ["file"], summary: joinSummary(parts, "") };
}
function extractGraphql(hunks) {
  const symbols = [];
  const re = /^\s*(?:extend\s+)?(?:type|input|enum|interface|union|scalar)\s+(\w+)/;
  for (const h of hunks) {
    const parent = re.exec(h.header)?.[1] ?? null;
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) pushUnique(symbols, m[1]);
      else if (l.sign !== " " && parent) pushUnique(symbols, parent);
    }
  }
  return { symbols, kinds: symbols.length ? ["graphql"] : ["file"], summary: joinSummary(symbols, "") };
}
function extractProto(hunks) {
  const symbols = [];
  const re = /^\s*(?:message|service|enum|rpc)\s+(\w+)/;
  for (const h of hunks) {
    const parent = re.exec(h.header)?.[1] ?? null;
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) pushUnique(symbols, m[1]);
      else if (l.sign !== " " && parent) pushUnique(symbols, parent);
    }
  }
  return { symbols, kinds: symbols.length ? ["proto"] : ["file"], summary: joinSummary(symbols, "") };
}
function extractSql(hunks) {
  const symbols = [];
  const re = /\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?["'`]?([\w.]+)/i;
  for (const h of hunks) {
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) pushUnique(symbols, m[1]);
    }
  }
  return { symbols, kinds: symbols.length ? ["sql"] : ["file"], summary: joinSummary(symbols.map((s) => `table ${s}`), "") };
}
function extractOpenapi(hunks) {
  const symbols = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === " ") continue;
      const t = l.text;
      const yamlPath = /^\s*(\/[^\s:"']*)\s*:/.exec(t)?.[1];
      const jsonPath = /^\s*"(\/[^"]*)"\s*:/.exec(t)?.[1];
      const method = /^\s*"?(get|post|put|patch|delete|options|head)"?\s*:/i.exec(t)?.[1];
      const schema = /^\s{4,}"?([A-Z]\w*)"?\s*:\s*(\{|$)/.exec(t)?.[1];
      pushUnique(symbols, yamlPath ?? jsonPath);
      if (method) pushUnique(symbols, method.toUpperCase());
      pushUnique(symbols, schema);
    }
    const headerPath = /(\/[\w/{}.-]+)/.exec(h.header)?.[1];
    if (headerPath && h.lines.some((l) => l.sign !== " ")) pushUnique(symbols, headerPath);
  }
  return { symbols, kinds: symbols.length ? ["openapi"] : ["file"], summary: joinSummary(symbols, "") };
}
function extractSymbols(path, hunks) {
  const lang = fileLang(path);
  let out;
  switch (lang) {
    case "ts":
    case "js":
      out = extractTs(hunks);
      break;
    case "py":
      out = extractPy(hunks);
      break;
    case "go":
      out = extractGo(hunks);
      break;
    case "prisma":
      out = extractPrisma(hunks);
      break;
    case "graphql":
      out = extractGraphql(hunks);
      break;
    case "proto":
      out = extractProto(hunks);
      break;
    case "sql":
      out = extractSql(hunks);
      break;
    case "openapi":
      out = extractOpenapi(hunks);
      break;
    default:
      out = { symbols: [], kinds: ["file"], summary: "" };
  }
  if (!out.summary) out.summary = `edited ${path}`;
  else out.summary = `${basename2(path)}: ${out.summary}`.slice(0, SUMMARY_MAX);
  return out;
}

// ../core/src/contracts.ts
var HUNK_RE = /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)? ?(.*)$/;
function parseUnifiedDiff(text) {
  if (!text) return [];
  const hunks = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\r$/, "");
    const m = HUNK_RE.exec(l);
    if (m) {
      current = {
        oldStart: m[1] === void 0 ? 0 : Number(m[1]),
        oldCount: m[2] === void 0 ? 1 : Number(m[2]),
        newStart: m[3] === void 0 ? 0 : Number(m[3]),
        newCount: m[4] === void 0 ? 1 : Number(m[4]),
        header: (m[5] ?? "").trim(),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (l.startsWith("diff --git") || l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ")) {
      current = null;
      continue;
    }
    if (l.startsWith("\\")) continue;
    const sign = l[0];
    if (sign === "+" || sign === "-" || sign === " ") current.lines.push({ sign, text: l.slice(1) });
  }
  return hunks;
}
function isCommentLine(text, lang) {
  const t = text.trim();
  if (!t) return true;
  switch (lang) {
    case "ts":
    case "js":
    case "go":
    case "proto":
      return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
    case "py":
    case "prisma":
    case "graphql":
    case "openapi":
      return t.startsWith("#") || t.startsWith('"""') || t.startsWith("//");
    case "sql":
      return t.startsWith("--") || t.startsWith("/*");
    default:
      return false;
  }
}
function meaningfulLines(hunks, lang) {
  const out = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === " ") continue;
      if (!l.text.trim() || isCommentLine(l.text, lang)) continue;
      out.push(l);
    }
  }
  return out;
}
function normalizeHunks(hunks) {
  const parts = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === " ") continue;
      const t = l.text.replace(/\s+/g, "");
      if (t) parts.push(l.sign + t);
    }
  }
  return parts.join("\n");
}
function hunkHash(hunksOrText) {
  const hunks = typeof hunksOrText === "string" ? parseUnifiedDiff(hunksOrText) : hunksOrText;
  return sha1(normalizeHunks(hunks));
}
function renderHunk(hunks, max = LIMITS.hunkChars) {
  const lines = [];
  for (const h of hunks) {
    const changed = h.lines.filter((l) => l.sign !== " ");
    if (!changed.length) continue;
    lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.header ? " " + h.header : ""}`);
    for (const l of changed) lines.push(l.sign + l.text);
  }
  return truncateLines(lines.join("\n"), max);
}
function plusLines(hunks) {
  const out = [];
  for (const h of hunks) for (const l of h.lines) if (l.sign === "+" && l.text.trim()) out.push(l.text);
  return out;
}
function hunkContainedIn(hunk, content) {
  const plus = plusLines(parseUnifiedDiff(hunk));
  if (!plus.length) return false;
  const haystack = content.replace(/\s+/g, "");
  return plus.every((l) => haystack.includes(l.replace(/\s+/g, "")));
}
function diffIsEmpty(text) {
  if (!text || !text.trim()) return true;
  return parseUnifiedDiff(text).every((h) => h.lines.every((l) => l.sign === " "));
}
function isContractPath(path, cfg) {
  if (matchAny(cfg.globs, path)) return true;
  for (const area of Object.values(cfg.areas ?? {})) {
    if (area.shared && matchAny(area.paths, path)) return true;
  }
  return false;
}
var TS_EXPORT_RE = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:type|interface|enum|class|function\*?|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/;
var TS_EXPORT_BLOCK_HEADER_RE = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type|enum|class)\s+([A-Za-z_$][\w$]*)/;
var TS_MEMBER_RE = /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\??\s*[:(<]/;
var PY_DEF_RE = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
var GO_FUNC_RE = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/;
var GO_TYPE_RE = /^\s*type\s+([A-Z]\w*)/;
var ZOD_TRPC_RE = /\b(z\.object\(|router\(|\.procedure\b)/;
function exportScanHit(hunks, lang) {
  if (lang !== "ts" && lang !== "js" && lang !== "py" && lang !== "go") return false;
  for (const h of hunks) {
    let inExportBlock = TS_EXPORT_BLOCK_HEADER_RE.test(h.header) && braceDepth(h.header) > 0;
    let depth = inExportBlock ? 1 : 0;
    for (const l of h.lines) {
      const t = l.text;
      if (isCommentLine(t, lang)) continue;
      if (lang === "ts" || lang === "js") {
        if (l.sign !== " " && (TS_EXPORT_RE.test(t) || ZOD_TRPC_RE.test(t))) return true;
        if (TS_EXPORT_BLOCK_HEADER_RE.test(t)) {
          inExportBlock = true;
          depth = braceDepth(t) > 0 ? 1 : 0;
          if (depth === 0) inExportBlock = false;
          continue;
        }
        if (inExportBlock) {
          if (l.sign !== " " && TS_MEMBER_RE.test(t)) return true;
          depth += braceDepth(t);
          if (depth <= 0) inExportBlock = false;
        }
      } else if (lang === "py") {
        if (l.sign !== " " && PY_DEF_RE.test(t)) return true;
      } else if (lang === "go") {
        if (l.sign !== " " && (GO_FUNC_RE.test(t) || GO_TYPE_RE.test(t))) return true;
      }
    }
  }
  return false;
}
function braceDepth(text) {
  let d = 0;
  for (const c of text) {
    if (c === "{") d += 1;
    else if (c === "}") d -= 1;
  }
  return d;
}
function detectContract(input) {
  if (diffIsEmpty(input.diffText)) return null;
  const hunks = parseUnifiedDiff(input.diffText);
  const lang = fileLang(input.path);
  if (!meaningfulLines(hunks, lang).length) return null;
  const viaGlob = isContractPath(input.path, { globs: input.config.contracts.globs, areas: input.config.areas });
  const viaExport = !viaGlob && input.config.contracts.export_scan && exportScanHit(hunks, lang);
  if (!viaGlob && !viaExport) return null;
  const extraction = extractSymbols(input.path, hunks);
  return {
    ...extraction,
    path: input.path,
    lang,
    viaGlob,
    viaExport,
    hunk: renderHunk(hunks),
    hash: hunkHash(hunks),
    hunks
  };
}

// ../core/src/depindex.ts
import { basename as basename3, dirname as dirname3, extname as extname2, posix as posix2 } from "node:path";
var SOURCE_PATHSPECS = [
  ":!node_modules",
  ":!**/node_modules/**",
  ":!**/dist/**",
  ":!**/build/**",
  ":!**/*.min.js",
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.py",
  "*.go",
  "*.graphql",
  "*.gql"
];
var NW = "[^A-Za-z0-9_]";
var DEPINDEX_GREP_PATTERN = `^[[:space:]]*(import|export)${NW}.*${NW}from[[:space:]]*['"]|^[[:space:]]*import[[:space:]]*['"]|require\\(['"]|${NW}prisma\\.[a-zA-Z_]+|['"]/api/[A-Za-z0-9_./{}:-]*['"]`;
function parseImportLine(text, lang = "ts") {
  const t = text.trim();
  if (lang === "py") {
    const from = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(t);
    if (from) {
      const ids = (from[2] ?? "").replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "").filter((s) => /^\w+$/.test(s));
      return { specifier: from[1] ?? "", identifiers: ids };
    }
    const imp = /^import\s+([\w.]+)/.exec(t);
    return imp ? { specifier: imp[1] ?? "", identifiers: [] } : null;
  }
  if (lang === "go") {
    const m = /^(?:import\s+)?(?:\w+\s+)?"([^"]+)"/.exec(t);
    return m ? { specifier: m[1] ?? "", identifiers: [] } : null;
  }
  const es = /^(?:import|export)\s+(?:type\s+)?(.*?)\s*from\s*['"]([^'"]+)['"]/.exec(t);
  if (es) {
    const clause = es[1] ?? "";
    return { specifier: es[2] ?? "", identifiers: identifiersFromClause(clause) };
  }
  const side = /^import\s*['"]([^'"]+)['"]/.exec(t);
  if (side) return { specifier: side[1] ?? "", identifiers: [] };
  const req = /(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(t);
  if (req) return { specifier: req[2] ?? "", identifiers: identifiersFromClause(req[1] ?? "") };
  const bareReq = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(t);
  if (bareReq) return { specifier: bareReq[1] ?? "", identifiers: [] };
  return null;
}
function identifiersFromClause(clause) {
  const ids = [];
  const star = /\*\s+as\s+(\w+)/.exec(clause);
  if (star) ids.push(star[1] ?? "");
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of (braces[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(name)) ids.push(name);
    }
  }
  const def = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, "").trim());
  if (def && def[1] && def[1] !== "type") ids.push(def[1]);
  return [...new Set(ids.filter(Boolean))];
}
function normalizeSpecifier(specifier, fromFile) {
  const spec = specifier.trim();
  if (spec.startsWith(".")) {
    const resolved = posix2.normalize(posix2.join(posix2.dirname(fromFile), spec));
    return { kind: "relative", key: stripExt(resolved) };
  }
  if (spec.startsWith("/")) return { kind: "relative", key: stripExt(spec.replace(/^\/+/, "")) };
  if (/^node:/.test(spec)) return { kind: "builtin", key: spec };
  if (/^[@~#$]\//.test(spec) && !spec.startsWith("@")) return { kind: "alias", key: spec };
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? spec;
  const deep = parts.length > (spec.startsWith("@") ? 2 : 1) ? stripExt(spec) : void 0;
  return deep ? { kind: "package", key: name, deepKey: deep } : { kind: "package", key: name };
}
function stripExt(p) {
  const ext = extname2(p);
  const base = ext && /^\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|d)$/.test(ext) ? p.slice(0, -ext.length) : p;
  return base.replace(/\/index$/, "").replace(/\.d$/, "");
}
function parseGrepLines(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (m) out.push({ file: m[1] ?? "", text: m[3] ?? "" });
  }
  return out;
}
var MAX_KEYS = 2e4;
var MAX_FILES_PER_KEY = 200;
function add(map, key, file) {
  if (!key) return;
  const list = map[key];
  if (list) {
    if (list.length < MAX_FILES_PER_KEY && !list.includes(file)) list.push(file);
  } else if (Object.keys(map).length < MAX_KEYS) {
    map[key] = [file];
  }
}
function langOfFile(file) {
  const ext = extname2(file);
  if (ext === ".py") return "py";
  if (ext === ".go") return "go";
  if (/^\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ext)) return "ts";
  return "other";
}
function buildDepIndexFromLines(lines, ctx) {
  const imports = {};
  const symbols = {};
  const contractPaths = {};
  for (const { file, text } of lines) {
    const lang = langOfFile(file);
    const parsed = parseImportLine(text, lang);
    if (parsed) {
      const n = normalizeSpecifier(parsed.specifier, file);
      if (n.kind !== "builtin") {
        add(imports, n.key, file);
        if (n.deepKey) add(imports, n.deepKey, file);
        if (n.kind === "relative") {
          add(contractPaths, n.key, file);
          const base = basename3(n.key);
          if (!GENERIC_BASENAMES.includes(base)) add(contractPaths, base, file);
        }
      }
      for (const id of parsed.identifiers) add(symbols, id, file);
    }
    for (const m of text.matchAll(/\bprisma\.([a-zA-Z_]\w*)\b/g)) {
      const model = m[1] ?? "";
      if (model && !/^(\$|_)/.test(model)) add(symbols, `prisma.${model}`, file);
    }
    for (const m of text.matchAll(/['"](\/api\/[A-Za-z0-9_./{}:-]*)['"]/g)) add(imports, m[1] ?? "", file);
  }
  return { repo: ctx.repo, head: ctx.head, builtAt: ctx.builtAt ?? nowIso(), imports, symbols, contractPaths };
}
async function buildDepIndex(cwd, ctx, opts) {
  const head = ctx.head ?? await gitHead(cwd, opts);
  if (!head) return null;
  const raw = await gitGrep(cwd, DEPINDEX_GREP_PATTERN, { ...opts, mode: "lines", pathspecs: SOURCE_PATHSPECS, timeoutMs: opts?.timeoutMs ?? 1e4 });
  if (raw === null) return null;
  return buildDepIndexFromLines(parseGrepLines(raw), { repo: ctx.repo, head });
}
function trimLists(map, cap, keepKeys) {
  const entries = Object.entries(map);
  if (keepKeys !== void 0 && entries.length > keepKeys) entries.sort((a, b) => b[1].length - a[1].length).length = keepKeys;
  const out = {};
  for (const [k, files] of entries) out[k] = files.length > cap ? files.slice(0, cap) : files;
  return out;
}
function shrinkDepIndex(idx, maxBytes = LIMITS.payloadClientMaxBytes) {
  const size = (d) => byteLength(JSON.stringify(d));
  if (size(idx) <= maxBytes) return idx;
  let cur = { ...idx, symbols: {} };
  let cap = MAX_FILES_PER_KEY;
  while (size(cur) > maxBytes && cap > 4) {
    cap = Math.floor(cap / 2);
    cur = { ...cur, imports: trimLists(cur.imports, cap), contractPaths: trimLists(cur.contractPaths, cap) };
  }
  let keys = Math.max(Object.keys(cur.imports).length, Object.keys(cur.contractPaths).length);
  while (size(cur) > maxBytes && keys > 16) {
    keys = Math.floor(keys / 2);
    cur = { ...cur, imports: trimLists(cur.imports, cap, keys), contractPaths: trimLists(cur.contractPaths, cap, keys) };
  }
  return cur;
}
function nearestPackageName(repoRoot, relPath) {
  let dir = posix2.dirname(relPath);
  for (let i = 0; i < 32; i++) {
    const pkg = readJson(posix2.join(repoRoot, dir, "package.json"));
    if (isRecord(pkg) && typeof pkg["name"] === "string" && pkg["name"]) return pkg["name"];
    if (dir === "." || dir === "" || dir === "/") break;
    dir = posix2.dirname(dir);
  }
  return null;
}
function dependentSpecifiers(input) {
  const specs = /* @__PURE__ */ new Set();
  const noExt = stripExt(input.path);
  const base = basename3(noExt);
  if (input.packageName) {
    specs.add(`['"]${escapeRegExp(input.packageName)}['"]`);
    const srcIdx = noExt.indexOf("/src/");
    const deep = srcIdx >= 0 ? noExt.slice(srcIdx + 5) : base;
    specs.add(`['"]${escapeRegExp(`${input.packageName}/${deep}`)}(\\.js)?['"]`);
  }
  if (!GENERIC_BASENAMES.includes(base)) {
    specs.add(`/${escapeRegExp(base)}(\\.js|\\.ts)?['"]`);
  }
  specs.add(`['"]${escapeRegExp(noExt)}(\\.js|\\.ts)?['"]`);
  const dir = basename3(dirname3(noExt));
  if (dir && dir !== "." && !GENERIC_BASENAMES.includes(base)) specs.add(`${escapeRegExp(dir)}/${escapeRegExp(base)}(\\.js|\\.ts)?['"]`);
  if (input.kind === "prisma") {
    for (const model of input.symbols ?? []) {
      if (!/^[A-Z]/.test(model)) continue;
      const camel = model.charAt(0).toLowerCase() + model.slice(1);
      specs.add(`prisma\\.${escapeRegExp(camel)}(${NW}|$)`);
      specs.add(`(^|${NW})${escapeRegExp(model)}(${NW}|$)`);
    }
  } else if (input.kind === "openapi") {
    for (const p of input.symbols ?? []) if (p.startsWith("/")) specs.add(`['"]${escapeRegExp(p)}['"]`);
  } else if (input.kind === "graphql") {
    for (const t of input.symbols ?? []) if (/^[A-Z]\w*$/.test(t)) specs.add(`(^|${NW})${escapeRegExp(t)}(${NW}|$)`);
  }
  return [...specs];
}
async function findDependents(cwd, input, opts) {
  const specs = dependentSpecifiers(input);
  if (!specs.length) return [];
  const pattern = specs.join("|");
  const files = await gitGrep(cwd, pattern, {
    ...opts,
    mode: "files",
    pathspecs: [`:!${input.path}`, ...SOURCE_PATHSPECS],
    cap: (opts?.cap ?? LIMITS.dependentsCap) + 1
  });
  if (files === null) return null;
  return files.filter((f) => f !== input.path).slice(0, opts?.cap ?? LIMITS.dependentsCap);
}

// ../core/src/prose.ts
var DIFF_LINE = /^(?:diff --git |index [0-9a-f]{6,}\.\.[0-9a-f]{6,}|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|@@ -\d+|[+-](?![+-])(?:\s{2,}|\S))/;
var STACK_LINE = /^(?:\s+at\s+\S.*|\s*at\s+.*\(.*:\d+:\d+\)|Traceback \(most recent call last\):|\s+File ".*", line \d+.*|\s*\w*(?:Error|Exception)(?::\s|$).*|goroutine \d+ \[.*\]:|\s+\S+\.\S+\(.*\)\s*$|\s+\/\S+\.go:\d+.*)$/;
var INLINE_CODE = /`([^`\n]*)`/g;
function isDiffLine(line2) {
  if (/^[-+] /.test(line2) && !/^[-+] {2,}/.test(line2)) return false;
  return DIFF_LINE.test(line2);
}
function isStackTraceLine(line2) {
  return STACK_LINE.test(line2);
}
function isIndentedCodeLine(line2) {
  if (!/^(?: {4,}|\t)\S/.test(line2)) return false;
  return !/^\s+(?:[-*+•]|\d+[.)])\s/.test(line2);
}
function prose(text, opts = {}) {
  if (!text) return "";
  const max = opts.max ?? LIMITS.turnTextChars;
  const inlineMax = opts.inlineCodeMax ?? 80;
  let t = text.replace(/\r\n?/g, "\n");
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "$1");
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*$/g, "$1");
  t = t.replace(INLINE_CODE, (m, inner) => inner.length > inlineMax ? "" : m);
  const lines = [];
  let prevKept = null;
  for (const l of t.split("\n")) {
    if (isDiffLine(l) || isStackTraceLine(l)) continue;
    if (isIndentedCodeLine(l) && (prevKept === null || prevKept.trim() === "" || prevKept.trimEnd().endsWith(":"))) continue;
    lines.push(l);
    prevKept = l;
  }
  const joined = lines.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return truncateWords(joined, max);
}

// ../core/src/journal.ts
import { closeSync, mkdirSync as mkdirSync2, openSync, readdirSync, renameSync as renameSync2, rmdirSync, statSync as statSync2, writeFileSync as writeFileSync2, writeSync } from "node:fs";
import { join as join5 } from "node:path";
function sessionsDir(home) {
  return join5(home, LOCAL_PATHS.sessionsDir);
}
function sessionDir(home, sessionId) {
  return join5(sessionsDir(home), sessionId);
}
function ensureSessionDir(home, sessionId) {
  const dir = sessionDir(home, sessionId);
  ensureDir(join5(dir, SESSION_FILES.marksDir));
  return dir;
}
function readMeta(dir) {
  const v = readJson(join5(dir, SESSION_FILES.meta));
  return isSessionMeta(v) ? v : null;
}
function writeMeta(dir, meta) {
  ensureDir(join5(dir, SESSION_FILES.marksDir));
  return writeJsonAtomic(join5(dir, SESSION_FILES.meta), meta, true);
}
function serializeJournalEntry(entry) {
  let line2 = JSON.stringify(entry);
  if (byteLength(line2) <= LIMITS.journalLineBytes) return line2;
  const copy = { ...entry };
  for (const key of ["text", "subject", "files", "contracts", "symbols"]) {
    if (typeof copy[key] === "string") {
      const over = byteLength(line2) - LIMITS.journalLineBytes + 16;
      copy[key] = copy[key].slice(0, Math.max(0, copy[key].length - over));
      line2 = JSON.stringify(copy);
      if (byteLength(line2) <= LIMITS.journalLineBytes) return line2;
    } else if (Array.isArray(copy[key])) {
      copy[key] = copy[key].slice(0, 20);
      line2 = JSON.stringify(copy);
      if (byteLength(line2) <= LIMITS.journalLineBytes) return line2;
    }
  }
  return line2.length > LIMITS.journalLineBytes ? JSON.stringify({ t: entry.t, at: entry.at, truncated: true }) : line2;
}
function appendJournal(dir, entry) {
  const path = join5(dir, SESSION_FILES.events);
  const line2 = serializeJournalEntry(entry) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "a");
      try {
        writeSync(fd, line2);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err.code === "ENOENT" && attempt === 0) {
        ensureDir(dir);
        continue;
      }
      return false;
    }
  }
  return false;
}
function parseJournalText(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      if (isJournalEntry(v)) out.push(v);
    } catch {
    }
  }
  return out;
}
function readJournalEntries(dir) {
  return parseJournalText(readText(join5(dir, SESSION_FILES.events)));
}
function emptyFold() {
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
    ended: null
  };
}
var RECENT_PATHS_CAP = 100;
var COMMITS_CAP = 100;
var DONE_TASKS_CAP = 20;
var TRAIL_CAP = 5;
function foldEntries(entries, base = emptyFold()) {
  const f = structuredClone(base);
  for (const e of entries) {
    f.foldedLines += 1;
    switch (e.t) {
      case "edit": {
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
      case "prompt":
        f.prompts.count += 1;
        f.prompts.lastAt = e.at;
        f.prompts.lastPromptId = e.promptId;
        break;
      case "objective": {
        f.objective.text = e.objective;
        f.objective.source = e.source;
        f.objective.at = e.at;
        f.objective.toolCallsSince = 0;
        f.objective.trail = [e, ...f.objective.trail].slice(0, TRAIL_CAP);
        break;
      }
      case "contract":
        f.contracts[e.path] = e;
        break;
      case "commit":
        if (!f.commits.some((c) => c.sha === e.sha)) f.commits = [...f.commits, e].slice(-COMMITS_CAP);
        else f.commits = f.commits.map((c) => c.sha === e.sha ? { ...c, ...e } : c);
        break;
      case "task":
        if (e.status === "created") {
          if (!f.tasks.open.some((t) => t.id === e.id)) f.tasks.open.push({ id: e.id, subject: e.subject, at: e.at });
        } else {
          f.tasks.open = f.tasks.open.filter((t) => t.id !== e.id);
          if (!f.tasks.done.some((t) => t.id === e.id)) f.tasks.done = [...f.tasks.done, { id: e.id, subject: e.subject, at: e.at }].slice(-DONE_TASKS_CAP);
        }
        break;
      case "turn":
        f.turns = [...f.turns.filter((t) => !(e.promptId && t.promptId === e.promptId)), e].slice(-LIMITS.turnsInPacket);
        f.lastTurnAt = e.at;
        f.lastTurnWasQuestion = e.text.trim().endsWith("?");
        break;
      case "end":
        f.ended = { at: e.at, reason: e.reason };
        break;
      case "cwd":
      case "branch":
        break;
    }
  }
  return f;
}
function isJournalFold(x) {
  return isRecord(x) && x["v"] === 1 && isRecord(x["edits"]) && Array.isArray(x["recentPaths"]) && isRecord(x["objective"]);
}
function loadFold(dir) {
  const stored = readJson(join5(dir, SESSION_FILES.fold));
  const base = isJournalFold(stored) ? stored : emptyFold();
  return foldEntries(readJournalEntries(dir), base);
}
async function rotateJournalIfLarge(dir, threshold = LIMITS.journalRotateBytes) {
  const live = join5(dir, SESSION_FILES.events);
  const size = fileSize(live);
  if (size === null || size < threshold) return false;
  return withSessionLock(dir, async ({ locked }) => {
    if (!locked) return false;
    const rotated = join5(dir, `events.${Date.now()}.jsonl`);
    try {
      renameSync2(live, rotated);
    } catch {
      return false;
    }
    const stored = readJson(join5(dir, SESSION_FILES.fold));
    const base = isJournalFold(stored) ? stored : emptyFold();
    const folded = foldEntries(parseJournalText(readText(rotated)), base);
    if (!writeJsonAtomic(join5(dir, SESSION_FILES.fold), folded)) return false;
    removeFile(rotated);
    return true;
  });
}
function markKey(path, dev) {
  return sha1(`${path}|${dev}`);
}
function markPath(dir, kind, key) {
  return join5(dir, SESSION_FILES.marksDir, key ? `${kind}.${key}` : kind);
}
function createMark(dir, kind, key, content = "") {
  const path = markPath(dir, kind, key);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        if (content) writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return "created";
    } catch (err) {
      const code = err.code;
      if (code === "EEXIST") return "exists";
      if (code === "ENOENT" && attempt === 0) {
        ensureDir(join5(dir, SESSION_FILES.marksDir));
        continue;
      }
      return "error";
    }
  }
  return "error";
}
function hasMark(dir, kind, key) {
  return exists(markPath(dir, kind, key));
}
function readMark(dir, kind, key) {
  return readText(markPath(dir, kind, key));
}
function markAgeMs(dir, kind, key, now = Date.now()) {
  const m = mtimeMs(markPath(dir, kind, key));
  return m === null ? null : Math.max(0, now - m);
}
function removeMark(dir, kind, key) {
  return removeFile(markPath(dir, kind, key));
}
function renewMark(dir, kind, key, content, maxAgeMs, now = Date.now()) {
  const first = createMark(dir, kind, key, content);
  if (first !== "exists") return first;
  const age = markAgeMs(dir, kind, key, now);
  if (age === null) return createMark(dir, kind, key, content);
  if (age < maxAgeMs) return "exists";
  removeMark(dir, kind, key);
  return createMark(dir, kind, key, content);
}
function setMark(dir, kind, key, content) {
  try {
    ensureDir(join5(dir, SESSION_FILES.marksDir));
    writeFileSync2(markPath(dir, kind, key), content);
    return true;
  } catch {
    return false;
  }
}
function readAskedMark(dir, key) {
  const text = readMark(dir, "asked", key);
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return isRecord(v) && typeof v["at"] === "string" ? v : null;
  } catch {
    return null;
  }
}
function snoozeUntil(dir, key, now = Date.now()) {
  const text = readMark(dir, "snooze", key);
  const until = parseIso(text?.trim());
  if (until === null) return null;
  return until > now ? until : null;
}
function promoteAskedToSnooze(dir, key, now = Date.now(), snoozeMs = 18e5) {
  if (!hasMark(dir, "asked", key)) return false;
  const ok = setMark(dir, "snooze", key, nowIso(now + snoozeMs));
  removeMark(dir, "asked", key);
  return ok;
}
function listMarks(dir, kind) {
  try {
    return readdirSync(join5(dir, SESSION_FILES.marksDir)).filter((f) => f === kind || f.startsWith(`${kind}.`)).map((f) => f.slice(kind.length + 1));
  } catch {
    return [];
  }
}
async function withSessionLock(dir, fn, opts = {}) {
  const spinMs = opts.spinMs ?? 50;
  const giveUpMs = opts.giveUpMs ?? 300;
  const staleMs = opts.staleMs ?? 1e4;
  const lock = join5(dir, SESSION_FILES.lockDir);
  const started = Date.now();
  let locked = false;
  ensureDir(dir);
  while (!locked) {
    try {
      mkdirSync2(lock);
      locked = true;
    } catch (err) {
      if (err.code !== "EEXIST") break;
      const age = Date.now() - (mtimeMs(lock) ?? Date.now());
      if (age > staleMs) {
        try {
          rmdirSync(lock);
        } catch {
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
      }
    }
  }
}
function acquireBgLock(home, job, repoKey2, opts = {}) {
  const dir = join5(home, LOCAL_PATHS.bgDir);
  const lock = join5(dir, `${job}.${repoKey2}.lock`);
  const staleMs = opts.staleMs ?? 3e4;
  ensureDir(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync2(lock);
      return () => {
        try {
          rmdirSync(lock);
        } catch {
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") return null;
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
function readPending(dir) {
  const text = readText(join5(dir, SESSION_FILES.pending));
  return text ? text.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}
function writePending(dir, ids) {
  const path = join5(dir, SESSION_FILES.pending);
  const unique2 = [...new Set(ids.filter(Boolean))];
  if (!unique2.length) {
    removeFile(path);
    return true;
  }
  try {
    ensureDir(dir);
    writeFileSync2(path, unique2.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}
function readDraft(dir) {
  const v = readJson(join5(dir, SESSION_FILES.draft));
  return isRecord(v) && v["quality"] === "heuristic" && Array.isArray(v["done"]) ? v : null;
}
function writeDraft(dir, draft) {
  let text = JSON.stringify(draft);
  if (byteLength(text) > LIMITS.draftBytes) {
    const slim = { ...draft, changed: draft.changed.slice(0, 40), done: draft.done.slice(0, 10), next: draft.next.slice(0, 10) };
    text = JSON.stringify(slim);
  }
  return writeJsonAtomic(join5(dir, SESSION_FILES.draft), JSON.parse(text));
}
async function ensureSessionMeta(input) {
  const dir = ensureSessionDir(input.home, input.sessionId);
  const existing = readMeta(dir);
  const cwdReal = realpathBestEffort(input.cwd);
  if (existing && !existing.provisional && !input.force && (isPathUnder(input.cwd, existing.repoRoot) || isPathUnder(cwdReal, realpathBestEffort(existing.repoRoot)))) {
    return { meta: existing, healed: false, config: null, gitOk: true, provisional: false };
  }
  const now = input.now ?? Date.now();
  const rp = await revParseSet(input.cwd, input.signal ? { signal: input.signal } : void 0);
  const gitOk = rp.toplevel !== null;
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
    now
  });
  const sameRepoAndBranch = existing && existing.repo === slug && existing.branch === (rp.branch ?? existing.branch);
  const meta = {
    v: 1,
    sessionId: input.sessionId,
    dev: identity.dev,
    identitySource: identity.source,
    repo: slug,
    project: config.resolved.project,
    repoKey: repoKey(slug),
    repoRoot,
    cwd: input.cwd,
    branch: rp.branch ?? existing?.branch ?? "unknown",
    worktree: rp.toplevel ? worktreeName(rp.toplevel, rp.gitDir, rp.commonDir, input.cwd) : null,
    startSha: sameRepoAndBranch && existing?.startSha ? existing.startSha : rp.head,
    lastStopSha: sameRepoAndBranch ? existing?.lastStopSha ?? null : null,
    lastStopAt: existing?.lastStopAt ?? null,
    client: input.env.entrypoint === "claude-desktop" ? "desktop" : "cli",
    host: input.env.hostname,
    pid: input.pid ?? input.env.pid ?? null,
    startedAt: existing?.startedAt ?? nowIso(now),
    source: input.source ?? existing?.source ?? null,
    gitEmail: rp.userEmail,
    gitEmails: identity.emails,
    configHash: config.hash,
    model: input.model ?? existing?.model ?? null,
    pluginSha: input.pluginSha ?? existing?.pluginSha ?? null
  };
  if (provisional) {
    if (existing) return { meta: existing, healed: false, config: null, gitOk: false, provisional: true };
    return { meta: { ...meta, provisional: true }, healed: false, config, gitOk: false, provisional: true };
  }
  await withSessionLock(dir, () => writeMeta(dir, meta));
  return { meta, healed: true, config, gitOk, provisional: false };
}
function isMetaIncomplete(meta) {
  return meta.branch === "unknown" || meta.startSha === null || meta.gitEmail === null && meta.gitEmails.length === 0;
}
async function repairSessionMeta(input) {
  const dir = sessionDir(input.home, input.sessionId);
  const existing = readMeta(dir);
  if (!existing) return { meta: null, repaired: false };
  if (!isMetaIncomplete(existing)) return { meta: existing, repaired: false };
  const o = { timeoutMs: BUDGET_MS.gitDiff, ...input.signal ? { signal: input.signal } : {} };
  const rp = await revParseSet(input.cwd, o);
  if (!rp.toplevel) return { meta: existing, repaired: false };
  const patch = {};
  if (existing.branch === "unknown" && rp.branch) {
    patch.branch = rp.branch;
    patch.worktree = worktreeName(rp.toplevel, rp.gitDir, rp.commonDir, input.cwd);
  }
  const email = existing.gitEmail ?? rp.userEmail;
  if (existing.gitEmail === null && rp.userEmail) patch.gitEmail = rp.userEmail;
  if (existing.gitEmails.length === 0 && email) patch.gitEmails = authorEmails(input.team, existing.dev, email);
  if (existing.startSha === null && rp.head) {
    patch.startSha = await gitHeadBefore(input.cwd, existing.startedAt, o) ?? rp.head;
  }
  if (Object.keys(patch).length === 0) return { meta: existing, repaired: false };
  const next = await withSessionLock(dir, () => {
    const cur = readMeta(dir) ?? existing;
    const merged = { ...cur, ...patch };
    return writeMeta(dir, merged) ? merged : null;
  });
  return { meta: next ?? existing, repaired: next !== null };
}
async function updateMetaBranch(dir, patch) {
  return withSessionLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta) return null;
    const next = { ...meta, ...patch };
    return writeMeta(dir, next) ? next : null;
  });
}
function configForMeta(meta) {
  return loadRelayConfig(meta.repoRoot, { slug: meta.repo, project: meta.project });
}
function openContracts(fold) {
  const out = {};
  for (const [path, c] of Object.entries(fold.contracts)) if (!c.retracted) out[path] = c;
  return out;
}

// ../core/src/breaker.ts
import { join as join6 } from "node:path";
import { writeFileSync as writeFileSync3 } from "node:fs";
function downUntilPath(home) {
  return join6(home, LOCAL_PATHS.downUntil);
}
function downCountPath(home) {
  return join6(home, LOCAL_PATHS.downCount);
}
function configErrorPath(home) {
  return join6(home, LOCAL_PATHS.configError);
}
function isConfigErrorFile(x) {
  return isRecord(x) && typeof x["status"] === "number" && typeof x["message"] === "string" && typeof x["at"] === "string";
}
function readBreaker(home, now = Date.now()) {
  const untilText = readText(downUntilPath(home));
  const untilMs = untilText && /^\d+$/.test(untilText.trim()) ? Number(untilText.trim()) : null;
  const countText = readText(downCountPath(home));
  const count = countText && /^\d+$/.test(countText.trim()) ? Number(countText.trim()) : 0;
  const cfg = readJson(configErrorPath(home));
  const configError = isConfigErrorFile(cfg) ? cfg : null;
  const open = untilMs !== null && untilMs > now;
  return {
    open,
    untilMs: open ? untilMs : null,
    until: open ? nowIso(untilMs) : null,
    sinceMs: open ? mtimeMs(downUntilPath(home)) : null,
    count,
    configError
  };
}
function breakerOpen(home, now = Date.now()) {
  return readBreaker(home, now).open;
}
function recordWorkerFailure(home, now = Date.now()) {
  ensureDir(home);
  const count = readBreaker(home, now).count + 1;
  writeAtomic(downCountPath(home), String(count));
  if (count >= BREAKER.failuresToOpen) writeAtomic(downUntilPath(home), String(now + BREAKER.openMs));
  return readBreaker(home, now);
}
function recordSuccess(home) {
  removeFile(downCountPath(home));
  removeFile(downUntilPath(home));
  removeFile(configErrorPath(home));
}
function recordConfigError(home, status, message, now = Date.now()) {
  ensureDir(home);
  writeAtomic(downUntilPath(home), String(now + BREAKER.configErrorMs));
  writeJsonAtomic(configErrorPath(home), { status, message: message.slice(0, 500), at: nowIso(now) });
  return readBreaker(home, now);
}
function writeRefreshWanted(home) {
  try {
    ensureDir(home);
    writeFileSync3(join6(home, LOCAL_PATHS.refreshWanted), String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
function refreshWantedAgeMs(home, now = Date.now()) {
  const m = mtimeMs(join6(home, LOCAL_PATHS.refreshWanted));
  return m === null ? null : Math.max(0, now - m);
}
function clearRefreshWanted(home) {
  removeFile(join6(home, LOCAL_PATHS.refreshWanted));
}
function shouldSpawnRefresh(home, cacheAgeMs, now = Date.now()) {
  if (cacheAgeMs !== null && cacheAgeMs < BREAKER.preEditRefreshMs) return false;
  if (breakerOpen(home, now)) return false;
  const wanted = refreshWantedAgeMs(home, now);
  return wanted === null || wanted >= BREAKER.refreshWantedDebounceMs;
}

// ../core/src/cache.ts
import { readdirSync as readdirSync2 } from "node:fs";
import { join as join7 } from "node:path";

// ../core/src/notes.ts
function relayAt(now = Date.now()) {
  return `Relay at ${shortTime(now)}:`;
}
function branchOf(v) {
  const b = v.other?.branch ?? "unknown branch";
  return v.other?.worktree ? `${b}, wt:${v.other.worktree}` : b;
}
function stateOf(v) {
  switch (v.other?.state) {
    case "working":
      return "is active";
    case "idle":
      return "is idle";
    case "away":
      return "is away";
    case "gone":
      return "has ended the session";
    default:
      return "was seen recently";
  }
}
function renderCollisionContext(v, now = Date.now()) {
  const who = v.other?.dev ?? "a teammate";
  const suffix = v.label ? ` ${v.label}` : "";
  const edits = v.other?.editCount ?? v.editCount ?? 0;
  const since = v.other?.lastEditAt ? ` at ${shortTime(v.other.lastEditAt)}` : "";
  const record = v.other?.impactId ? `; the change record is ${v.other.impactId} (contract)` : "";
  const objective = v.other?.objective ? `, objective "${inlineText(v.other.objective, 80)}"` : "";
  switch (v.severity) {
    case "CLAIMED": {
      const c = v.claim;
      const until = c ? ` until ${dateTimeZ(c.expiresAt)}` : "";
      const note = c?.note ? ` ("${inlineText(c.note, 80)}")` : "";
      return `${relayAt(now)} ${v.path} is under ${who}'s ${c?.hard ? "hard " : ""}claim ${c?.id ?? ""}${until}${note}; the claim/release tools and the user can lift it${suffix}.`;
    }
    case "HOT":
      return `${relayAt(now)} ${who} (${branchOf(v)}) has ${edits} edit${edits === 1 ? "" : "s"} on ${v.path}, last${since}, and ${stateOf(v)}${objective}; the notify tool reaches ${who} at their next prompt${record}${suffix}.`;
    case "WARM":
      return `${relayAt(now)} ${who} (${branchOf(v)}) changed ${v.path}${since} and that change is not in this branch yet${record}${suffix}.`;
    case "SEQUENTIAL":
      return `${relayAt(now)} ${who}'s change to ${v.path}${since} is already in this branch${suffix}.`;
    case "SAME_DEV":
      return `${relayAt(now)} another session of ${who} on this machine edited ${v.path}${since}${suffix}.`;
    default:
      return "";
  }
}
function renderAskReason(v) {
  const who = v.other?.dev ?? "a teammate";
  const last = v.other?.lastEditAt ? `, last edit ${shortTime(v.other.lastEditAt)}` : "";
  const objective = v.other?.objective ? `, objective "${inlineText(v.other.objective, 80)}"` : "";
  if (v.severity === "CLAIMED" && v.claim) {
    return `Relay: ${v.path} is claimed by ${who} until ${dateTimeZ(v.claim.expiresAt)}${v.claim.note ? ` ("${inlineText(v.claim.note, 60)}")` : ""}${v.label ? " " + v.label : ""}. Allow this edit?`;
  }
  return `Relay: ${who} is editing ${v.path} (branch ${branchOf(v)}${last}${objective})${v.label ? " " + v.label : ""}. Allow this edit?`;
}
function renderDenyReason(v, now = Date.now()) {
  const who = v.other?.dev ?? "a teammate";
  if (v.severity === "CLAIMED" && v.claim) {
    return `Relay: ${v.path} is under ${who}'s hard claim until ${dateTimeZ(v.claim.expiresAt)} (claim ${v.claim.id}${v.claim.note ? `, "${inlineText(v.claim.note, 60)}"` : ""}). The claim/release tools and the user can lift it.`;
  }
  return `${renderCollisionContext(v, now)} This edit is blocked by the repo's collision policy (collision.hot: deny).`;
}
function changeSetStatus(cs, merged) {
  if (merged) return "already in your branch";
  const sha = cs.impacts.find((i) => i.commitSha)?.commitSha;
  switch (cs.status) {
    case "uncommitted":
      return "uncommitted, in progress";
    case "committed":
      return `committed ${sha ? sha.slice(0, 7) : ""}, not in your branch`.replace(/\s+,/, ",");
    case "pushed":
      return `pushed ${sha ? sha.slice(0, 7) : ""}, not in your branch`.replace(/\s+,/, ",");
    case "merged":
      return "already in your branch";
    case "withdrawn":
      return "withdrawn";
  }
}
function renderChangeSetNote(cs, opts = {}) {
  const files = cs.impacts.map((i) => `${i.path.split("/").pop()} (${i.symbols.length ? i.symbols.join(", ") : i.summary})`);
  const n = cs.impacts.length;
  const deps = cs.dependents.map((d) => d.path);
  const head = `IMPACT ${cs.id}${cs.impacts[0] ? ` (${cs.impacts[0].id})` : ""}: ${cs.by} changed ${n === 1 ? cs.impacts[0]?.path ?? "a contract file" : `${n} contract files`} at ${shortTime(cs.at)} (${cs.branch}, ${changeSetStatus(cs, opts.merged)}): ${n === 1 ? cs.impacts[0]?.summary ?? "" : files.join("; ")}.`;
  const depLine = deps.length ? ` Dependents in your repo: ${deps.slice(0, 8).join(", ")}${deps.length > 8 ? ` (+${deps.length - 8} more)` : ""}.` : "";
  let text = inlineText(head + depLine, 3e3);
  if (opts.withHunk) {
    const hunk = cs.impacts.find((i) => i.hunk)?.hunk;
    if (hunk) text += `
\`\`\`diff
${neutralizeRelayTags(truncateLines(hunk, LIMITS.hunkChars))}
\`\`\``;
  }
  return opts.maxChars ? truncateLines(text, opts.maxChars) : text;
}
var INBOX_ITEM_CHARS = 500;
function renderInboxItem(item) {
  const from = inlineText(item.from ?? "relay", 64);
  const kind = item.noteKind ? ` (${inlineText(item.noteKind, 16)})` : "";
  const body = inlineText(item.body, INBOX_ITEM_CHARS);
  const ref = item.ref ? inlineText(item.ref, 120) : "";
  switch (item.kind) {
    case "note":
      return `NOTE from ${from} at ${shortTime(item.at)}${kind}: ${body}${ref ? ` [ref ${ref}]` : ""}`;
    case "collision":
      return `COLLISION note from ${from} at ${shortTime(item.at)}: ${body}`;
    case "handoff":
      return `HANDOFF note from ${from} at ${shortTime(item.at)}: ${body}${ref ? ` [${ref}]` : ""}`;
    case "impact":
      return `IMPACT ${ref} from ${from} at ${shortTime(item.at)}: ${body}`.replace(/\s{2,}/g, " ");
  }
}
function inboxLineFits(body, line2, maxChars, at) {
  const open = `<relay-inbox at="${at}">
`;
  const close = `
</relay-inbox>`;
  const candidate = body ? `${body}
- ${line2}` : `- ${line2}`;
  return open.length + candidate.length + close.length <= maxChars;
}
function renderInbox(lines, opts = {}) {
  if (!lines.length) return null;
  const at = nowIso(opts.now ?? Date.now());
  const max = opts.maxChars ?? LIMITS.promptInboxChars;
  const open = `<relay-inbox at="${at}">
`;
  const close = `
</relay-inbox>`;
  let body = "";
  for (const l of lines) {
    if (!inboxLineFits(body, l, max, at)) {
      if (!body) body = truncateLines(`- ${l}`, max - open.length - close.length);
      break;
    }
    body = body ? `${body}
- ${l}` : `- ${l}`;
  }
  return open + body + close;
}
function renderOfflineDigest(now = Date.now()) {
  const at = nowIso(now);
  return `<relay-digest offline="true" at="${at}">Relay hub unreachable at ${shortTime(now)}; presence and impact notes are unavailable until it returns; the status/handoffs tools still answer from cache.</relay-digest>`;
}
function renderConfigErrorDigest(status, message, now = Date.now()) {
  const at = nowIso(now);
  return `<relay-digest offline="true" config-error="${status ?? "unknown"}" at="${at}">${renderPluginUpdateLine(status, message)} Presence and impact notes are unavailable until this is fixed; the status/handoffs tools still answer from cache.</relay-digest>`;
}
function wrapCachedDigest(digest, ageMs) {
  const label = `cached ${humanAge(ageMs)}`;
  if (/freshness="[^"]*"/.test(digest)) return digest.replace(/freshness="[^"]*"/, `freshness="${label}"`);
  return digest.replace(/^<relay-digest\b/, `<relay-digest freshness="${label}"`);
}
function renderPluginUpdateLine(status, message) {
  const cmds = "`claude plugin marketplace update relay && claude plugin update relay@relay`";
  if (status === 401) return `Relay plugin needs an update (hub answered 401): ${cmds}`;
  if (status === 426) return `Relay plugin is older than the hub requires (426${message ? `: ${message}` : ""}): ${cmds}`;
  if (status === 413) return `Relay dropped a payload larger than the hub accepts (413${message ? `: ${message}` : ""}).`;
  return `Relay plugin is behind the marketplace${message ? ` (${message})` : ""}; ${cmds} updates it`;
}
function renderIdentityUnknownLine(gitEmail) {
  const why = gitEmail ? `git email ${gitEmail} is not in the team list` : "no git email is configured";
  return `Relay identity for this session is unknown (${why}). The whoami tool accepts iam=<handle>; /relay:iam <handle> sets it for this machine.`;
}
function renderSessionLine(s, meDev) {
  const who = s.dev === meDev ? "(you)" : s.dev;
  const where = [s.area ?? "unknown", s.branch, s.worktree ? `wt:${s.worktree}` : null].filter(Boolean).join(" \xB7 ");
  const state = s.state === "working" ? `working, last event ${shortTime(s.lastSeenAt)}` : `${s.state} since ${shortTime(s.lastSeenAt)}`;
  const objective = s.objective ? ` \xB7 "${inlineText(s.objective, 80)}"` : "";
  return inlineText(`- ${who} \xB7 ${where}${objective} \xB7 ${state}`, 400);
}
function renderCompactReinjection(snapshot, ctx) {
  const now = ctx.now ?? Date.now();
  const lines = [];
  lines.push(`<relay-digest mode="compact" at="${nowIso(now)}"${snapshot ? ` freshness="cached ${humanAge(now - (parseIso(snapshot.fetchedAt) ?? now))}"` : ' offline="true"'}>`);
  if (snapshot) {
    const live = snapshot.sessions.filter((s) => s.state !== "gone");
    lines.push(`## Team now (as of ${shortTime(snapshot.serverTime)})`);
    if (live.length) for (const s of live.slice(0, 8)) lines.push(renderSessionLine(s, ctx.meDev));
    else lines.push("- nobody else is live in this project");
    const sets = snapshot.changeSets.filter((cs) => !ctx.ancestryMerged?.[cs.id]);
    if (sets.length) {
      lines.push(`## Contract changes affecting you (${sets.length})`);
      for (const cs of sets.slice(0, 5)) lines.push(`- ${renderChangeSetNote(cs, { now })}`);
    }
  } else {
    lines.push("- Relay hub unreachable and no cached snapshot; presence unavailable.");
  }
  if (ctx.objective) lines.push(`Objective: ${inlineText(ctx.objective, LIMITS.objectiveChars)}`);
  lines.push("## Relay");
  lines.push("Tools (mcp relay): status, who_is_on, recent_changes, decisions, notify, claim, release, impacts, impact_of, handoffs, handoff, decide, whoami. This digest is context for the session and is not itself a request.");
  lines.push("</relay-digest>");
  const text = lines.join("\n");
  if (text.length <= LIMITS.compactReinjectChars) return text;
  const closing = "\n</relay-digest>";
  return truncateLines(text.slice(0, -closing.length), LIMITS.compactReinjectChars - closing.length) + closing;
}
function renderStatusline(snapshot, opts = {}) {
  const me = opts.myDev ?? snapshot.me.dev;
  const parts = [];
  const live = snapshot.sessions.filter((s) => s.state !== "gone");
  const mine = live.filter((s) => s.dev === me);
  const others = live.filter((s) => s.dev !== me);
  const seen = /* @__PURE__ */ new Set();
  for (const s of [...mine.slice(0, 1), ...others]) {
    if (seen.has(s.dev) && s.dev !== me) continue;
    seen.add(s.dev);
    const bits = [s.dev, s.area ?? "?", s.branch];
    if (s.state === "working") bits.push(hhmm(s.lastSeenAt));
    else bits.push(`${s.state} ${hhmm(s.lastSeenAt)}`);
    parts.push(bits.join(" "));
    if (parts.length >= 4) break;
  }
  const impacts = snapshot.changeSets.length;
  const notes = snapshot.inbox.length;
  if (impacts) parts.push(`${impacts} impact${impacts === 1 ? "" : "s"}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  const dot = "\u25CF";
  const body = parts.length ? ` ${parts.join(" \xB7 ")}` : ` ${me} ${hhmm(snapshot.serverTime)}`;
  return `relay ${dot}${body}`;
}

// ../core/src/cache.ts
function cacheDir(home, key) {
  return join7(home, LOCAL_PATHS.cacheDir, key);
}
function snapshotPath(home, key) {
  return join7(cacheDir(home, key), CACHE_FILES.snapshot);
}
function statuslinePath(home, key) {
  return join7(cacheDir(home, key), CACHE_FILES.statusline);
}
function readSnapshot(home, key) {
  const v = readJson(snapshotPath(home, key));
  return isCachedSnapshot(v) ? v : null;
}
function writeSnapshot(home, key, snapshot, opts = {}) {
  const now = opts.now ?? Date.now();
  const cached = readSnapshot(home, key);
  const incoming = parseIso(snapshot.serverTime);
  const current = cached ? parseIso(cached.serverTime) : null;
  if (incoming === null) return { written: false, stale: false };
  if (current !== null && incoming < current) return { written: false, stale: true };
  const doc = { ...snapshot, fetchedAt: nowIso(now) };
  ensureDir(cacheDir(home, key));
  const written = writeJsonAtomic(snapshotPath(home, key), doc);
  if (written) writeAtomic(statuslinePath(home, key), renderStatusline(doc, { now, myDev: opts.myDev ?? doc.me.dev }) + "\n");
  return { written, stale: false };
}
function snapshotAgeMs(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  const f = parseIso(snapshot.fetchedAt);
  return f === null ? null : Math.max(0, now - f);
}
function itemAgeMs(snapshot, serverAt, now = Date.now()) {
  const st = parseIso(snapshot.serverTime);
  const at = parseIso(serverAt);
  const f = parseIso(snapshot.fetchedAt);
  if (st === null || at === null || f === null) return null;
  return Math.max(0, st - at) + Math.max(0, now - f);
}
function hubNowMs(snapshot, now = Date.now()) {
  const st = parseIso(snapshot.serverTime);
  const f = parseIso(snapshot.fetchedAt);
  if (st === null || f === null) return null;
  return st + Math.max(0, now - f);
}
function stalenessTier(ageMs, breakerOpen2) {
  if (breakerOpen2) return "offline";
  if (ageMs === null) return "stale";
  if (ageMs <= STALENESS.fullPolicyMs) return "fresh";
  if (ageMs <= STALENESS.degradedMs) return "degraded";
  return "stale";
}
function stalenessLabel(tier, snapshot, breakerSinceMs) {
  const asOf = snapshot ? hhmm(snapshot.serverTime) : "??:??Z";
  switch (tier) {
    case "fresh":
      return null;
    case "degraded":
      return `(presence as of ${asOf})`;
    case "stale":
      return `(presence as of ${asOf}; not refreshed)`;
    case "offline":
      return `(Relay hub unreachable since ${breakerSinceMs !== null ? hhmm(breakerSinceMs) : asOf})`;
  }
}
function freshnessOf(home, snapshot, now = Date.now()) {
  const breaker = readBreaker(home, now);
  const ageMs = snapshotAgeMs(snapshot, now);
  const tier = stalenessTier(ageMs, breaker.open);
  return { tier, label: stalenessLabel(tier, snapshot, breaker.sinceMs), ageMs, breaker };
}
function writeDigest(home, key, digest) {
  return writeAtomic(join7(cacheDir(home, key), CACHE_FILES.digest), digest);
}
function readDigest(home, key, now = Date.now()) {
  const path = join7(cacheDir(home, key), CACHE_FILES.digest);
  const digest = readText(path);
  if (digest === null) return null;
  const ageMs = Math.max(0, now - (mtimeMs(path) ?? now));
  return { digest, ageMs, ageLabel: humanAge(ageMs) };
}
function isAncestryFile(x) {
  return isRecord(x) && typeof x["headSha"] === "string" && isRecord(x["contains"]) && isRecord(x["merged"]);
}
function readAncestry(home, key) {
  const v = readJson(join7(cacheDir(home, key), CACHE_FILES.ancestry));
  return isAncestryFile(v) ? v : null;
}
function writeAncestry(home, key, file) {
  return writeJsonAtomic(join7(cacheDir(home, key), CACHE_FILES.ancestry), file);
}
function isRepoStateFile(x) {
  return isRecord(x) && x["v"] === 1 && isRecord(x["lastReportedSha"]);
}
function readRepoState(home, key) {
  const v = readJson(join7(cacheDir(home, key), CACHE_FILES.state));
  return isRepoStateFile(v) ? v : { v: 1, lastReportedSha: {}, depindexHead: null, depindexAt: null };
}
function writeRepoState(home, key, state) {
  return writeJsonAtomic(join7(cacheDir(home, key), CACHE_FILES.state), state);
}
function pendingChangeSets(snapshot, sessionDirPath) {
  return snapshot.changeSets.filter((cs) => cs.dependents.length > 0 && !hasMark(sessionDirPath, "jit", cs.id) && !hasMark(sessionDirPath, "seen", cs.id));
}
function derivePending(home, sessionId, snapshot) {
  const dir = sessionDir(home, sessionId);
  const ids = pendingChangeSets(snapshot, dir).map((cs) => cs.id);
  writePending(dir, ids);
  return ids;
}
function applySnapshot(home, key, snapshot, opts = {}) {
  const result = writeSnapshot(home, key, snapshot, opts);
  let pending = [];
  if (opts.sessionId) {
    const effective = result.written ? snapshot : readSnapshot(home, key) ?? snapshot;
    pending = derivePending(home, opts.sessionId, effective);
  }
  return { ...result, pending };
}
function currentDir(home) {
  return join7(home, LOCAL_PATHS.currentDir);
}
function currentPath(home, pid) {
  return join7(currentDir(home), `${pid}.json`);
}
function writeCurrentFile(home, file) {
  return writeJsonAtomic(currentPath(home, file.pid), file);
}
function listCurrentFiles(home) {
  let names;
  try {
    names = readdirSync2(currentDir(home)).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const v = readJson(join7(currentDir(home), n));
    if (isCurrentFile(v)) out.push(v);
  }
  return out.sort((a, b) => (parseIso(b.at) ?? 0) - (parseIso(a.at) ?? 0));
}
function removeCurrentFile(home, pid) {
  return removeFile(currentPath(home, pid));
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function makeCurrentFile(input) {
  return {
    v: 1,
    sessionId: input.sessionId,
    cwd: input.cwd,
    repoKey: input.repoKey,
    dev: input.dev,
    at: nowIso(input.now ?? Date.now()),
    statusline: statuslinePath(input.home, input.repoKey),
    pid: input.pid
  };
}

// ../core/src/outbox.ts
import { readdirSync as readdirSync3 } from "node:fs";
import { join as join8 } from "node:path";
function outboxDir(home) {
  return join8(home, LOCAL_PATHS.outboxDir);
}
function outboxPath(home, id) {
  return join8(outboxDir(home), `${id}.json`);
}
var EPHEMERAL_EVENT_TYPES = /* @__PURE__ */ new Set(["prompt", "edit", "turn_end", "cwd"]);
function isEphemeralEvents(events) {
  return events.every((e) => EPHEMERAL_EVENT_TYPES.has(e.type));
}
function defaultEphemeral(kind, body) {
  if (kind === "events") return isEphemeralEvents(body.events ?? []);
  if (kind === "session_start") return true;
  return false;
}
function writeOutbox(home, input) {
  const now = input.now ?? Date.now();
  const entry = {
    v: 1,
    id: ulid(now),
    sessionId: input.sessionId,
    at: input.at ?? nowIso(now),
    kind: input.kind,
    endpoint: input.endpoint,
    ephemeral: input.ephemeral ?? defaultEphemeral(input.kind, input.body),
    body: input.body
  };
  return writeJsonAtomic(outboxPath(home, entry.id), entry) ? entry : null;
}
function deleteOutbox(home, id) {
  return removeFile(outboxPath(home, id));
}
function listOutbox(home) {
  let names;
  try {
    names = readdirSync3(outboxDir(home)).filter((n) => /^[0-9A-Z]{26}\.json$/i.test(n)).sort();
  } catch {
    return { entries: [], broken: [] };
  }
  const entries = [];
  const broken = [];
  for (const n of names) {
    const v = readJson(join8(outboxDir(home), n));
    if (isOutboxEntry(v)) entries.push(v);
    else broken.push(n.slice(0, -5));
  }
  return { entries, broken };
}
function planDrain(entries, now = Date.now(), cap = LIMITS.outboxDrainPerRun) {
  const plan = { send: [], drop: [], skip: [] };
  const createdAt = (e) => parseIso(e.at) ?? ulidTime(e.id) ?? now;
  const sorted = [...entries].sort((a, b) => createdAt(a) - createdAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of sorted) {
    const created = createdAt(e);
    const age = now - created;
    if (age < LIMITS.outboxInFlightMs) {
      plan.skip.push(e.id);
      continue;
    }
    if (age > LIMITS.outboxMaxAgeMs || e.ephemeral && age > LIMITS.outboxEphemeralMaxAgeMs) {
      plan.drop.push(e.id);
      continue;
    }
    if (plan.send.length < cap) plan.send.push(e);
  }
  return plan;
}
function replayBody(entry) {
  if (entry.kind === "events" || entry.kind === "session_end") return { ...entry.body, replay: true };
  return entry.body;
}
function recordOutboxAttempt(home, entry, error) {
  const attempts = (entry.attempts ?? 0) + 1;
  const next = { ...entry, attempts, ...error ? { lastError: error.slice(0, 200) } : {} };
  writeJsonAtomic(outboxPath(home, entry.id), next);
  return attempts;
}
async function drainOutbox(home, send, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAttempts = opts.maxAttempts ?? LIMITS.outboxMaxAttempts;
  const deadline = opts.budgetMs === void 0 ? null : Date.now() + opts.budgetMs;
  const { entries, broken } = listOutbox(home);
  const plan = planDrain(entries, now, opts.cap);
  const result = { sent: [], dropped: [...broken], skipped: plan.skip, failedAt: null, outOfTime: false };
  for (const id of [...plan.drop, ...broken]) if (deleteOutbox(home, id)) result.dropped.push(id);
  result.dropped = [...new Set(result.dropped)];
  for (const entry of plan.send) {
    if (deadline !== null && Date.now() >= deadline) {
      result.outOfTime = true;
      break;
    }
    let outcome;
    let error;
    try {
      outcome = await send(entry, replayBody(entry));
    } catch (err) {
      outcome = false;
      error = String(err?.message ?? err);
    }
    if (outcome === true) {
      deleteOutbox(home, entry.id);
      result.sent.push(entry.id);
    } else if (outcome === "discard") {
      deleteOutbox(home, entry.id);
      result.dropped.push(entry.id);
    } else {
      const attempts = recordOutboxAttempt(home, entry, error);
      if (attempts >= maxAttempts) {
        deleteOutbox(home, entry.id);
        result.dropped.push(entry.id);
        continue;
      }
      result.failedAt = entry.id;
      break;
    }
  }
  return result;
}

// ../core/src/http.ts
function budgetSignal(budgetMs, outer) {
  const timer = AbortSignal.timeout(budgetMs);
  if (!outer) return timer;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  timer.addEventListener("abort", abort, { once: true });
  outer.addEventListener("abort", abort, { once: true });
  if (outer.aborted) ctrl.abort();
  return ctrl.signal;
}
var HubClient = class {
  hub;
  role;
  opts;
  fetchImpl;
  constructor(opts) {
    this.opts = opts;
    this.hub = opts.hub.replace(/\/+$/, "");
    this.role = opts.role ?? "sync";
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }
  /** Headers of §10.4. */
  headers(extra = {}) {
    const h = {
      authorization: `Bearer ${this.opts.token}`,
      "content-type": "application/json",
      accept: "application/json",
      [RELAY_HEADERS.dev]: this.opts.dev,
      [RELAY_HEADERS.client]: this.opts.client,
      [RELAY_HEADERS.proto]: String(PROTOCOL_VERSION),
      ...extra
    };
    if (this.opts.sessionId) h[RELAY_HEADERS.session] = this.opts.sessionId;
    if (this.opts.pluginSha) h[RELAY_HEADERS.plugin] = this.opts.pluginSha;
    return h;
  }
  get(path, query = {}, opts = {}) {
    const qs = Object.entries(query).filter((kv) => typeof kv[1] === "string").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return this.request("GET", qs ? `${path}?${qs}` : path, void 0, opts);
  }
  post(path, body, opts = {}) {
    return this.request("POST", path, body, opts);
  }
  async request(method, path, body, opts) {
    const started = Date.now();
    const home = this.opts.home ?? null;
    if (!this.hub || !this.opts.token) {
      return { ok: false, status: null, kind: "unconfigured", message: "hub or token not configured", ms: 0, retryable: false };
    }
    if (home && !opts.ignoreBreaker && breakerOpen(home, started)) {
      return { ok: false, status: null, kind: "breaker", message: "breaker open", ms: 0, retryable: true };
    }
    const budgetMs = opts.budgetMs ?? (this.role === "worker" ? BUDGET_MS.workerPost : BUDGET_MS.promptRefresh);
    const payload = body === void 0 ? void 0 : JSON.stringify(body);
    if (payload !== void 0 && byteLength(payload) > LIMITS.payloadClientMaxBytes) {
      return { ok: false, status: HTTP_STATUS.payloadTooLarge, kind: "http", message: `payload ${byteLength(payload)} bytes exceeds the client cap`, ms: 0, retryable: false };
    }
    let res;
    try {
      res = await this.fetchImpl(`${this.hub}${path}`, {
        method,
        headers: this.headers(),
        body: payload,
        signal: budgetSignal(budgetMs, opts.signal)
      });
    } catch (err) {
      const ms2 = Date.now() - started;
      const name = isRecord(err) ? String(err["name"] ?? "") : "";
      const timeout = name === "TimeoutError" || name === "AbortError";
      this.noteFailure(home, timeout);
      return { ok: false, status: null, kind: timeout ? "timeout" : "network", message: String(err?.message ?? err), ms: ms2, retryable: true };
    }
    const ms = Date.now() - started;
    const text = await res.text().catch(() => "");
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (res.ok) {
      if (home) recordSuccess(home);
      const warnHeader = res.headers.get(RELAY_HEADERS.warn);
      const warn = [];
      if (warnHeader) warn.push(warnHeader);
      if (isRecord(parsed) && Array.isArray(parsed["warn"])) {
        for (const w of parsed["warn"]) if (typeof w === "string") warn.push(w);
      }
      let snapshot = null;
      if (isRecord(parsed)) {
        const cand = parsed["snapshot"] !== void 0 ? parsed["snapshot"] : parsed;
        if (isSnapshot(cand)) snapshot = cand;
      }
      if (snapshot && this.opts.onSnapshot) {
        try {
          this.opts.onSnapshot(snapshot);
        } catch {
        }
      }
      return { ok: true, status: res.status, data: parsed ?? text, warn, ms, snapshot };
    }
    const errBody = isRecord(parsed) && typeof parsed["error"] === "string" ? parsed : null;
    const message = errBody?.message ?? errBody?.error ?? `HTTP ${res.status}`;
    const status = res.status;
    if (status === HTTP_STATUS.badToken || status === HTTP_STATUS.clientTooOld) {
      if (home) recordConfigError(home, status, message, Date.now());
      return { ok: false, status, kind: "config", message, ms, body: errBody, retryable: false };
    }
    const retryable = status === HTTP_STATUS.rateLimited || status >= 500;
    if (retryable) this.noteFailure(home, false);
    return { ok: false, status, kind: "http", message, ms, body: errBody, retryable };
  }
  noteFailure(home, timeout) {
    if (!home) return;
    if (this.role === "worker") recordWorkerFailure(home);
    else if (timeout) writeRefreshWanted(home);
  }
};
function eventBase(now = Date.now()) {
  return { id: ulid(now), at: nowIso(now) };
}
function makeEvent(fields, now = Date.now()) {
  const base = eventBase(now);
  return { ...base, ...fields };
}
async function postWithWal(client, home, input, opts = {}) {
  const breaker = readBreaker(home);
  if (breaker.open && breaker.configError && !opts.ignoreBreaker) {
    return {
      entry: null,
      durable: false,
      result: { ok: false, status: breaker.configError.status, kind: "config", message: breaker.configError.message, ms: 0, retryable: false }
    };
  }
  const size = byteLength(JSON.stringify(input.body));
  if (size > LIMITS.payloadClientMaxBytes) {
    return {
      entry: null,
      durable: false,
      result: { ok: false, status: HTTP_STATUS.payloadTooLarge, kind: "http", message: `payload ${size} bytes exceeds the client cap`, ms: 0, retryable: false }
    };
  }
  const entry = writeOutbox(home, input);
  const result = await client.post(input.endpoint, input.body, opts);
  const discard = !result.ok && !result.retryable && result.kind !== "breaker" && result.kind !== "unconfigured";
  if (entry && (result.ok || discard)) deleteOutbox(home, entry.id);
  const durable = result.ok || entry !== null && !discard;
  if (durable) {
    try {
      await opts.onDurable?.(result.ok ? null : entry);
    } catch {
    }
  }
  return { entry, result, durable };
}
function walSender(client, opts = {}) {
  return async (entry, body) => {
    const r = await client.post(entry.endpoint, body, opts);
    if (r.ok) return true;
    if (r.kind === "config" || r.kind === "http" && !r.retryable) return "discard";
    return false;
  };
}

// ../core/src/collision.ts
var NONE = (path, tier, label) => ({
  path,
  severity: "NONE",
  decision: "none",
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
  session: null
});
function targetMatches(target, path, areas = {}) {
  const t = target.trim();
  if (!t) return false;
  if (t.startsWith("@")) return false;
  const area = areas[t];
  if (area) return area.paths.some((g) => matchGlob(g, path));
  return matchGlob(t, path);
}
function isMuted(mutes, path, otherDev, areas = {}) {
  if (!mutes?.length) return false;
  for (const m of mutes) {
    if (m.kind === "dev") {
      if (otherDev && m.target.replace(/^@/, "").toLowerCase() === otherDev.toLowerCase()) return true;
      continue;
    }
    if (targetMatches(m.target, path, areas)) return true;
  }
  return false;
}
function policyDecision(policy) {
  switch (policy) {
    case "ask":
      return "ask";
    case "deny":
      return "deny";
    case "context":
      return "context";
    case "note":
      return "note";
    case "off":
      return "none";
  }
}
function degradeForStaleness(decision, tier) {
  if (tier === "fresh") return decision;
  if (tier === "degraded") return decision === "deny" ? "ask" : decision === "ask" ? "context" : decision;
  return decision === "deny" || decision === "ask" ? "context" : decision;
}
function partyFrom(dev, heat, session, editCount, impactId) {
  return {
    dev,
    sessionId: heat?.sessionId ?? session?.id ?? null,
    branch: session?.branch ?? heat?.branch ?? null,
    worktree: session?.worktree ?? null,
    objective: session?.objective ?? heat?.objective ?? null,
    state: session?.state ?? null,
    lastEditAt: heat?.at ?? session?.lastEditAt ?? null,
    editCount,
    impactId
  };
}
function heatInMyBranch(heat, ancestry, myHeadBlob) {
  if (heat.blobId && myHeadBlob && heat.blobId === myHeadBlob) return true;
  if (!ancestry) return null;
  if (heat.headSha) {
    const c = ancestry.contains[heat.headSha];
    if (c === true) return true;
    if (c === false) return false;
  }
  return null;
}
function assessCollision(input) {
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
  const downgrades = [];
  const claims = snapshot.claims.filter((c) => c.dev !== me.dev && (hubNow === null || (parseIso(c.expiresAt) ?? 0) > hubNow));
  const claim = claims.find((c) => targetMatches(c.target, path, areas) || pathAreas.includes(c.target)) ?? null;
  const heatOnPath = snapshot.heat.filter((h) => h.path === path).sort((a, b) => (parseIso(b.at) ?? 0) - (parseIso(a.at) ?? 0));
  const others = heatOnPath.filter((h) => !h.mine && h.dev !== me.dev);
  const sessionOf = (dev, sessionId) => snapshot.sessions.find((s) => s.id === sessionId) ?? snapshot.sessions.find((s) => s.dev === dev && s.state !== "gone") ?? null;
  const editCountOf = (dev) => heatOnPath.filter((h) => h.dev === dev && h.kind === "edit").reduce((n, h) => n + (h.count ?? 1), 0);
  let hot = null;
  for (const h of others) {
    if (h.kind !== "edit") continue;
    const heatAge = itemAgeMs(snapshot, h.at, now);
    if (heatAge === null || heatAge > STALENESS.heatHotMs) continue;
    const s = sessionOf(h.dev, h.sessionId);
    const seenAge = s ? itemAgeMs(snapshot, s.lastSeenAt, now) : null;
    if (s && seenAge !== null && seenAge <= STALENESS.implicitClaimSeenMs && s.state !== "gone") {
      hot = h;
      break;
    }
  }
  let warm = null;
  let sequential = null;
  for (const h of others) {
    const heatAge = itemAgeMs(snapshot, h.at, now);
    if (heatAge === null || heatAge > STALENESS.warmMs) continue;
    const inBranch = heatInMyBranch(h, input.ancestry);
    if (inBranch === true) {
      if (!sequential) sequential = h;
    } else if (!warm) {
      warm = h;
    }
  }
  const sameDev = heatOnPath.find((h) => {
    if (!(h.mine || h.dev === me.dev) || h.kind !== "edit") return false;
    if (h.sessionId === me.sessionId) return false;
    const a = itemAgeMs(snapshot, h.at, now);
    return a !== null && a <= STALENESS.sameDevMs;
  }) ?? null;
  let severity = "NONE";
  let heat = null;
  let otherDev = null;
  if (claim) {
    severity = "CLAIMED";
    otherDev = claim.dev;
    heat = others.find((h) => h.dev === claim.dev) ?? null;
  } else if (hot) {
    severity = "HOT";
    heat = hot;
    otherDev = hot.dev;
  } else if (warm) {
    severity = "WARM";
    heat = warm;
    otherDev = warm.dev;
  } else if (sequential) {
    severity = "SEQUENTIAL";
    heat = sequential;
    otherDev = sequential.dev;
  } else if (sameDev) {
    severity = "SAME_DEV";
    heat = sameDev;
    otherDev = me.dev;
  }
  if (severity === "NONE") return NONE(path, tier, label);
  if (isMuted(input.mutes, path, otherDev, areas)) {
    const n = NONE(path, tier, label);
    n.downgrades.push("muted");
    return n;
  }
  const session = otherDev ? sessionOf(otherDev, heat?.sessionId ?? null) : null;
  const impactId = snapshot.changeSets.flatMap((cs) => cs.impacts).find((i) => i.path === path)?.id ?? null;
  const other = partyFrom(otherDev, heat, session, otherDev ? editCountOf(otherDev) : 0, impactId);
  let decision;
  let escalated = false;
  switch (severity) {
    case "CLAIMED":
      decision = claim?.hard ? "deny" : policyDecision(input.policy.claimed);
      break;
    case "HOT":
      decision = policyDecision(input.policy.hot);
      if (decision === "context" && other.branch && me.branch && other.branch === me.branch && (other.worktree ?? null) !== (me.worktree ?? null)) {
        decision = "ask";
        escalated = true;
      }
      break;
    case "WARM":
      decision = policyDecision(input.policy.warm);
      break;
    case "SEQUENTIAL":
      decision = "note";
      break;
    case "SAME_DEV":
      decision = policyDecision(input.policy.same_dev);
      break;
    default:
      decision = "none";
  }
  if (decision === "none") return { ...NONE(path, tier, label), severity, other, claim, heat, session, editCount: other.editCount };
  const degraded = degradeForStaleness(decision, tier);
  if (degraded !== decision) downgrades.push(`staleness:${tier}`);
  decision = degraded;
  if (decision === "ask" && input.interactive === false) {
    decision = "context";
    downgrades.push("non-interactive");
  }
  const marks = input.marks?.(otherDev) ?? {};
  let createAsked = false;
  let createNoted = false;
  if (decision === "ask") {
    const askedFresh = marks.askedAgeMs !== null && marks.askedAgeMs !== void 0 && marks.askedAgeMs < STALENESS.askedExpiryMs;
    const snoozed = marks.snoozeUntilMs !== null && marks.snoozeUntilMs !== void 0 && marks.snoozeUntilMs > now;
    if (askedFresh || snoozed) {
      decision = "context";
      downgrades.push(askedFresh ? "asked-recently" : "snoozed");
    } else {
      createAsked = true;
    }
  }
  if (decision === "note" || decision === "context") {
    if (severity !== "CLAIMED" && severity !== "HOT" && marks.noted) {
      return { ...NONE(path, tier, label), severity, other, claim, heat, session, editCount: other.editCount, downgrades: [...downgrades, "noted"] };
    }
    if (severity !== "CLAIMED" && severity !== "HOT") createNoted = true;
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
    session
  };
}

// ../core/src/mute.ts
import { join as join9 } from "node:path";
function mutePath(home, key) {
  return join9(home, LOCAL_PATHS.muteDir, `${key}.json`);
}
function isMuteFile(x) {
  return isRecord(x) && x["v"] === 1 && Array.isArray(x["targets"]);
}
function readMutes(home, key) {
  const v = readJson(mutePath(home, key));
  if (!isMuteFile(v)) return [];
  return v.targets.filter((t) => isRecord(t) && typeof t["target"] === "string" && typeof t["kind"] === "string");
}
function muteKind(target, areas = {}) {
  if (target.startsWith("@")) return "dev";
  if (areas[target]) return "area";
  if (isGlobPattern(target)) return "glob";
  return "path";
}
function addMute(home, key, target, areas = {}, now = Date.now()) {
  const t = target.trim();
  const current = readMutes(home, key).filter((m) => m.target !== t);
  const next = [...current, { target: t, kind: muteKind(t, areas), at: nowIso(now) }];
  writeJsonAtomic(mutePath(home, key), { v: 1, targets: next }, true);
  return next;
}
function removeMute(home, key, target) {
  const t = target.trim();
  const next = readMutes(home, key).filter((m) => m.target !== t);
  writeJsonAtomic(mutePath(home, key), { v: 1, targets: next }, true);
  return next;
}

// ../core/src/log.ts
import { appendFileSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join10 } from "node:path";
function debugLog(home, enabled, verb2, message, opts = {}) {
  if (!enabled) return;
  const line2 = `${nowIso(opts.now ?? Date.now())} [${process.pid}] ${verb2}: ${message}
`;
  try {
    ensureDir(join10(home, LOCAL_PATHS.logDir));
    appendFileSync(join10(home, LOCAL_PATHS.log), line2);
  } catch {
  }
  if (opts.stderr) {
    try {
      process.stderr.write(line2);
    } catch {
    }
  }
}
function appendStats(home, line2) {
  try {
    ensureDir(join10(home, LOCAL_PATHS.logDir));
    appendFileSync(join10(home, LOCAL_PATHS.stats), JSON.stringify(line2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ../core/src/ancestry.ts
function ancestryTargets(snapshot) {
  const shas = /* @__PURE__ */ new Set();
  for (const h of snapshot.heat) if (h.headSha) shas.add(h.headSha);
  const changeSets = [];
  for (const cs of snapshot.changeSets) {
    if (cs.repo && cs.repo !== snapshot.repo.slug) continue;
    const commitShas = cs.impacts.map((i) => i.commitSha).filter((s) => typeof s === "string" && s.length > 0);
    for (const s of commitShas) shas.add(s);
    changeSets.push({ id: cs.id, commitShas, impacts: cs.impacts.map((i) => ({ path: i.path, blobId: i.blobId, hunk: i.hunk })) });
  }
  return { shas: [...shas], changeSets };
}
async function computeAncestry(cwd, snapshot, opts = {}) {
  const head = await gitHead(cwd, opts);
  if (!head) return null;
  const targets = ancestryTargets(snapshot);
  const prev = opts.previous && opts.previous.headSha === head ? opts.previous : null;
  const contains = { ...prev?.contains ?? {} };
  let budget = opts.maxChecks ?? 60;
  for (const sha of targets.shas) {
    if (sha in contains || budget <= 0) continue;
    budget -= 1;
    const r = await gitIsAncestor(cwd, sha, head, opts);
    if (r !== null) contains[sha] = r;
  }
  const merged = { ...prev?.merged ?? {} };
  const blobCache = /* @__PURE__ */ new Map();
  const fileCache = /* @__PURE__ */ new Map();
  for (const cs of targets.changeSets) {
    if (merged[cs.id] === true) continue;
    if (cs.commitShas.length && cs.commitShas.every((s) => contains[s] === true)) {
      merged[cs.id] = true;
      continue;
    }
    let all = true;
    let undecidable = false;
    for (const imp of cs.impacts) {
      if (budget <= 0) {
        undecidable = true;
        break;
      }
      let inBranch = null;
      if (imp.blobId) {
        if (!blobCache.has(imp.path)) {
          budget -= 1;
          blobCache.set(imp.path, await gitBlobAt(cwd, head, imp.path, opts));
        }
        const mine = blobCache.get(imp.path) ?? null;
        if (mine && mine === imp.blobId) inBranch = true;
      }
      if (inBranch === null && imp.hunk) {
        if (!fileCache.has(imp.path)) {
          budget -= 1;
          fileCache.set(imp.path, await gitShowFile(cwd, head, imp.path, { ...opts, maxBytes: 512 * 1024 }));
        }
        const content = fileCache.get(imp.path) ?? null;
        if (content !== null) inBranch = hunkContainedIn(imp.hunk, content);
      }
      if (inBranch === null) {
        undecidable = true;
        break;
      }
      if (!inBranch) {
        all = false;
        break;
      }
    }
    if (!undecidable) merged[cs.id] = all;
  }
  return { headSha: head, at: nowIso(opts.now ?? Date.now()), contains, merged };
}
async function refreshAncestry(home, key, cwd, snapshot, opts = {}) {
  const previous = opts.previous === void 0 ? readAncestry(home, key) : opts.previous;
  const file = await computeAncestry(cwd, snapshot, { ...opts, previous });
  if (!file) return { file: null, newlyMerged: [] };
  const newlyMerged = Object.entries(file.merged).filter(([id, v]) => v && previous?.merged[id] !== true).map(([id]) => id);
  writeAncestry(home, key, file);
  return { file, newlyMerged };
}

// src/bg.ts
import { join as join12 } from "node:path";

// src/session.ts
import { appendFileSync as appendFileSync2 } from "node:fs";
import { relative as relative2 } from "node:path";
function isInteractive(rt, input) {
  if (!rt.env.interactive) return false;
  if (typeof input.agent_id === "string" && input.agent_id) return false;
  if (input.permission_mode === "dontAsk" || input.permission_mode === "bypassPermissions") return false;
  const entry = rt.env.entrypoint;
  if (entry && entry !== "cli" && entry !== "claude-desktop") return false;
  return true;
}
async function prepareSession(rt, input, opts = {}) {
  const cwd = opts.cwd ?? input.cwd;
  const sessionId = input.session_id;
  const res = await ensureSessionMeta({
    home: rt.home,
    sessionId,
    cwd,
    env: rt.env,
    team: rt.team,
    pid: rt.env.pid,
    source: opts.source ?? null,
    model: opts.model ?? null,
    pluginSha: rt.pluginSha,
    force: opts.force ?? false,
    now: rt.now(),
    signal: rt.signal
  });
  let meta = res.meta;
  if (opts.repair && !res.healed) {
    const rep = await repairSessionMeta({ home: rt.home, sessionId, cwd, team: rt.team, now: rt.now(), signal: rt.signal });
    if (rep.repaired && rep.meta) {
      meta = rep.meta;
      rt.log(`meta repaired for ${sessionId} (branch ${meta.branch}, startSha ${meta.startSha?.slice(0, 7) ?? "none"}, emails ${meta.gitEmails.length})`);
    }
  }
  const dir = sessionDir(rt.home, sessionId);
  const config = res.config ?? configForMeta(meta);
  if (rt.env.pid) {
    writeCurrentFile(rt.home, makeCurrentFile({ home: rt.home, pid: rt.env.pid, sessionId, cwd, repoKey: meta.repoKey, dev: meta.dev, now: rt.now() }));
  }
  if (res.healed) rt.log(`meta healed for ${sessionId} (repo ${meta.repo}, branch ${meta.branch})`);
  return {
    input,
    sessionId,
    cwd,
    dir,
    meta,
    healed: res.healed,
    config,
    key: meta.repoKey,
    interactive: isInteractive(rt, input),
    inSubagent: typeof input.agent_id === "string" && input.agent_id.length > 0
  };
}
function hubConfigured(rt) {
  return Boolean(rt.team?.hub && rt.team.token);
}
function hubClient(rt, ctx, role) {
  return new HubClient({
    hub: rt.team?.hub ?? "",
    token: rt.team?.token ?? "",
    dev: ctx.meta.dev,
    client: ctx.meta.client,
    sessionId: ctx.sessionId,
    pluginSha: rt.pluginSha,
    home: rt.home,
    role,
    fetch: rt.fetch,
    onSnapshot: (s) => {
      applySnapshot(rt.home, ctx.key, s, { sessionId: ctx.sessionId, now: rt.now(), myDev: ctx.meta.dev });
    }
  });
}
function buildPresence(rt, ctx, fold = loadFold(sessionDir(rt.home, ctx.sessionId))) {
  const meta = ctx.meta;
  const areas = ctx.config.resolved.areas;
  const objective = deriveObjective(fold, {
    branch: meta.branch,
    repoSlug: meta.repo,
    objectiveFromPrompts: ctx.config.resolved.privacy.objective_from_prompts
  });
  let cwdRel = null;
  try {
    cwdRel = toPosix(relative2(meta.repoRoot, ctx.cwd));
  } catch {
    cwdRel = null;
  }
  const area = voteArea({
    recentEdits: fold.recentPaths.slice(0, 20).map((p) => ({ path: p, at: fold.edits[p]?.lastAt ?? meta.startedAt })),
    areas,
    branch: meta.branch,
    dev: meta.dev,
    cwdRel,
    now: rt.now()
  });
  return {
    id: ctx.sessionId,
    repo: meta.repo,
    branch: meta.branch,
    worktree: meta.worktree,
    area: area.display,
    objective: objective.text,
    objectiveSource: objective.source,
    // repo-relative: the absolute path carries the OS user name and nothing on the hub reads it (§11.1)
    cwd: cwdRel ?? "",
    client: meta.client,
    host: meta.host,
    project: meta.project,
    startSha: meta.startSha,
    pluginSha: meta.pluginSha
  };
}
function areaFor(ctx, path) {
  return areaOfPath(path, ctx.config.resolved.areas);
}
function collectInbox(rt, ctx, snapshot, opts = {}) {
  const out = { lines: [], delivered: [] };
  if (!snapshot) return out;
  const maxChars = opts.maxChars ?? LIMITS.promptInboxChars;
  const at = nowIso(rt.now());
  let body = "";
  let full = false;
  const take = (kind, id, line2) => {
    if (full) return false;
    if (!inboxLineFits(body, line2, maxChars, at)) {
      if (body) {
        full = true;
        return false;
      }
      line2 = truncateLines(`- ${line2}`, maxChars - `<relay-inbox at="${at}">
`.length - "\n</relay-inbox>".length).replace(/^- /, "");
    }
    if (createMark(ctx.dir, kind, id) !== "created") return false;
    body = body ? `${body}
- ${line2}` : `- ${line2}`;
    out.lines.push(line2);
    out.delivered.push(id);
    return true;
  };
  for (const item of snapshot.inbox ?? []) {
    if (full) break;
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (hasMark(ctx.dir, "seen", item.id)) continue;
    take("seen", item.id, renderInboxItem(item));
  }
  const mode = opts.changeSets ?? "none";
  if (mode !== "none") {
    const merged = readAncestry(rt.home, ctx.key)?.merged ?? {};
    for (const cs of snapshot.changeSets ?? []) {
      if (full) break;
      if (mode === "high" && cs.priority !== "high") continue;
      if (merged[cs.id]) continue;
      if (hasMark(ctx.dir, "jit", cs.id) || hasMark(ctx.dir, "seen", cs.id)) continue;
      take("jit", cs.id, renderChangeSetNote(cs, { now: rt.now(), withHunk: opts.withHunk ?? false, merged: merged[cs.id] }));
    }
  }
  return out;
}
function inboxBlock(rt, delivery, maxChars = LIMITS.promptInboxChars) {
  return renderInbox(delivery.lines, { now: rt.now(), maxChars });
}
function appendEnvExports(rt, meta) {
  const file = rt.env.envFile;
  if (!file) return false;
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    appendFileSync2(file, `export RELAY_DEV=${q(meta.dev)}
export RELAY_PROJECT=${q(meta.project)}
`);
    return true;
  } catch (err) {
    rt.log(`env file append failed: ${String(err)}`);
    return false;
  }
}
function output(specific, extra = {}) {
  const out = { ...extra };
  if (specific) {
    const hasField = Object.entries(specific).some(([k, v]) => k !== "hookEventName" && v !== void 0 && v !== "");
    if (hasField) out.hookSpecificOutput = specific;
  }
  return Object.keys(out).length ? out : null;
}

// src/reconcile.ts
function exportScanEligible(path) {
  const lang = fileLang(path);
  return lang === "ts" || lang === "js" || lang === "py" || lang === "go";
}
function contractCandidatePaths(ctx, paths, cap = 20) {
  const cfg = ctx.config.resolved;
  const out = [];
  for (const p of paths) {
    if (isContractPath(p, { globs: cfg.contracts.globs, areas: cfg.areas })) out.push(p);
    else if (cfg.contracts.export_scan && exportScanEligible(p)) out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}
function splitDiffByFile(text) {
  const out = {};
  if (!text) return out;
  let current = null;
  let buf = [];
  const flush = () => {
    if (current && buf.length) out[current] = (out[current] ? out[current] + "\n" : "") + buf.join("\n");
    buf = [];
  };
  for (const line2 of text.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line2);
    if (m) {
      flush();
      current = m[2] ?? null;
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line2);
    if (plus && !current) current = plus[1] ?? null;
    if (current) buf.push(line2);
  }
  flush();
  return out;
}
function committedAfter(fold, rel, recordAt) {
  return fold.commits.some((c) => (c.contracts.includes(rel) || c.files.includes(rel)) && c.at >= recordAt);
}
async function workingTreeContract(rt, ctx, rel, diff, fold, now = rt.now()) {
  const none = { event: null, retract: null, journal: [] };
  if (diff === null) return none;
  const open = openContracts(fold)[rel];
  if (diffIsEmpty(diff)) {
    if (!open || committedAfter(fold, rel, open.at)) return none;
    const retract = makeEvent({ type: "retract", path: rel, impactId: null, hash: open.hash }, now);
    return { event: null, retract, journal: [{ ...open, at: nowIso(now), retracted: true, eventId: retract.id }] };
  }
  const cand = detectContract({ path: rel, diffText: diff, config: ctx.config.resolved });
  if (!cand) return none;
  if (fold.contracts[rel]?.hash === cand.hash && !fold.contracts[rel]?.retracted) return none;
  const blobId = await rt.git.gitHashObject(ctx.cwd, rel, { signal: rt.signal });
  const kind = cand.lang === "prisma" || cand.lang === "openapi" || cand.lang === "graphql" ? cand.lang : "ts";
  const deps = await rt.git.findDependents(
    ctx.cwd,
    { path: rel, packageName: nearestPackageName(ctx.meta.repoRoot, rel), symbols: cand.symbols, kind },
    { signal: rt.signal, timeoutMs: Math.min(2e3, Math.max(300, rt.remainingMs() - 500)) }
  );
  const event = makeEvent(
    {
      type: "contract",
      path: rel,
      symbols: cand.symbols,
      kinds: cand.kinds,
      ...ctx.config.resolved.privacy.send_diffs === "none" ? {} : { hunk: redact(cand.hunk).slice(0, LIMITS.hunkChars) },
      hash: cand.hash,
      blobId,
      dependents: deps,
      summary: cand.summary,
      branch: ctx.meta.branch
    },
    now
  );
  return { event, retract: null, journal: [{ t: "contract", at: nowIso(now), path: rel, hash: cand.hash, blobId, symbols: cand.symbols, kinds: cand.kinds, eventId: event.id }] };
}
async function commitContracts(rt, ctx, sha, files) {
  const candidates = contractCandidatePaths(ctx, files);
  if (!candidates.length) return [];
  const text = await rt.git.gitShowU0(ctx.cwd, sha, candidates, { signal: rt.signal });
  const byFile = splitDiffByFile(text);
  const out = [];
  for (const path of candidates) {
    const cand = detectContract({ path, diffText: byFile[path] ?? null, config: ctx.config.resolved });
    if (!cand) continue;
    const blobId = await rt.git.gitBlobAt(ctx.cwd, sha, path, { signal: rt.signal });
    out.push({
      path,
      symbols: cand.symbols,
      kinds: cand.kinds,
      ...ctx.config.resolved.privacy.send_diffs === "none" ? {} : { hunk: redact(cand.hunk).slice(0, LIMITS.hunkChars) },
      hash: cand.hash,
      blobId
    });
  }
  return out;
}
async function commitEvents(rt, ctx, commits, fold, now = rt.now()) {
  const known = new Set(fold.commits.map((c) => c.sha));
  const scan = { events: [], journal: [], complete: true, lastSha: null, files: [] };
  const seen = /* @__PURE__ */ new Set();
  for (const c of commits) {
    if (known.has(c.sha)) {
      scan.lastSha = c.sha;
      continue;
    }
    if (rt.signal.aborted) {
      scan.complete = false;
      break;
    }
    const files = await rt.git.gitCommitFiles(ctx.cwd, c.sha, { signal: rt.signal });
    if (files === null) {
      scan.complete = false;
      break;
    }
    const contracts = await commitContracts(rt, ctx, c.sha, files);
    const patchId = contracts.length ? await rt.git.gitPatchId(ctx.cwd, c.sha, { signal: rt.signal }) : null;
    if (rt.signal.aborted) {
      scan.complete = false;
      break;
    }
    const event = makeEvent(
      { type: "commit", sha: c.sha, patchId, authorEmail: c.authorEmail, subject: redact(c.subject).slice(0, 200), files: files.slice(0, LIMITS.commitFilesOnWire), contracts, branch: ctx.meta.branch },
      now
    );
    scan.journal.push({ t: "commit", at: nowIso(now), sha: c.sha, subject: event.subject, files: files.slice(0, 50), contracts: contracts.map((x) => x.path) });
    scan.events.push(event);
    scan.lastSha = c.sha;
    for (const f of files) if (!seen.has(f)) {
      seen.add(f);
      scan.files.push(f);
    }
  }
  return scan;
}
async function postEvents(rt, ctx, events, opts = {}) {
  const durable = async () => {
    for (const line2 of opts.journal ?? []) appendJournal(ctx.dir, line2);
    await opts.onDurable?.();
  };
  if (!hubConfigured(rt)) {
    await durable();
    rt.log(`hub not configured; ${events.length} event(s) dropped`);
    return { ok: false, durable: true, context: null };
  }
  const fold = opts.fold ?? loadFold(ctx.dir);
  const body = { session: buildPresence(rt, ctx, fold), events, ...opts.delivered?.length ? { delivered: opts.delivered } : {} };
  const client = hubClient(rt, ctx, opts.role ?? "worker");
  const budgetMs = opts.budgetMs ?? Math.min(3e3, Math.max(500, rt.remainingMs() - 100));
  const posted = await postWithWal(client, rt.home, { sessionId: ctx.sessionId, kind: "events", endpoint: "/v1/events", body, now: rt.now() }, { budgetMs, signal: rt.signal, onDurable: durable });
  const { result } = posted;
  rt.log(`POST /v1/events (${events.map((e) => e.type).join(",") || "presence"}) ${result.ok ? "ok" : result.kind} in ${result.ms} ms`);
  if (!result.ok) return { ok: false, durable: posted.durable, context: null };
  const data = result.data;
  const inbox = data && typeof data === "object" && Array.isArray(data.inbox) ? data.inbox : [];
  const delivery = collectInbox(rt, ctx, { inbox, changeSets: [] }, { changeSets: "none" });
  return { ok: true, durable: true, context: inboxBlock(rt, delivery) };
}
function postToolUseOutput(context) {
  return context ? output({ hookEventName: "PostToolUse", additionalContext: context }) : null;
}

// src/runtime.ts
import { spawn } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { join as join11 } from "node:path";
var realGit = {
  revParseSet,
  gitHead,
  gitBranch,
  gitRecentShas,
  gitBlobAt,
  gitDirtyPaths,
  gitOwnCommits,
  gitCommitFiles,
  gitDiffU0,
  gitShowU0,
  gitHashObject,
  gitPatchId,
  gitMergeBase,
  gitIsAncestor,
  gitHeadOnRemote,
  gitLsRemoteHead,
  findDependents,
  buildDepIndex,
  refreshAncestry
};
var SIGNAL_MARGIN_MS = 80;
function deadlineFor(verb2) {
  const known = DEADLINE_MS;
  return known[verb2] ?? DEADLINE_MS.prompt;
}
function createRuntime(opts) {
  const rawEnv = opts.env ?? process.env;
  const env = readEnv(rawEnv);
  const team = loadTeamConfig(env);
  const claudeHome = opts.claudeHome ?? join11(homedir2(), ".claude");
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let deadlineMs = opts.deadlineMs ?? deadlineFor(opts.verb);
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    const delay = Math.max(0, deadlineMs - SIGNAL_MARGIN_MS - (now() - startedAt));
    timer = setTimeout(() => controller.abort(), delay);
    timer.unref();
  };
  arm();
  const bundlePath = opts.bundlePath === void 0 ? process.argv[1] ?? null : opts.bundlePath;
  const log = (message) => debugLog(env.home, env.debug, opts.verb, message);
  const spawnBg = opts.spawnBg ?? ((job, args2) => {
    if (!bundlePath || rawEnv["RELAY_NO_BG"] === "1" || env.disable) return false;
    try {
      const child = spawn(process.execPath, ["--no-warnings", bundlePath, "bg", job, ...args2], {
        detached: true,
        stdio: "ignore",
        env: { ...rawEnv, RELAY_BG: "1" },
        windowsHide: true
      });
      child.on("error", () => void 0);
      child.unref();
      log(`spawned bg ${job} ${args2.join(" ")}`);
      return true;
    } catch (err) {
      log(`spawn bg ${job} failed: ${String(err)}`);
      return false;
    }
  });
  const rt = {
    verb: opts.verb,
    args: opts.args ?? [],
    env,
    home: env.home,
    team,
    pluginSha: resolvePluginSha(env, claudeHome),
    claudeHome,
    startedAt,
    get deadlineMs() {
      return deadlineMs;
    },
    signal: controller.signal,
    now,
    remainingMs() {
      return Math.max(0, deadlineMs - SIGNAL_MARGIN_MS - (now() - startedAt));
    },
    git: { ...realGit, ...opts.git ?? {} },
    fetch: opts.fetch,
    spawnBg,
    log,
    setDeadline(ms) {
      deadlineMs = ms;
      arm();
    }
  };
  return rt;
}
function parseFlags(args2) {
  const out = {};
  for (let i = 0; i < args2.length; i++) {
    const a = args2[i] ?? "";
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = args2[i + 1];
    if (next !== void 0 && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i += 1;
    } else out[a.slice(2)] = "1";
  }
  return out;
}

// src/verbs/session-end.ts
var REASONS = /* @__PURE__ */ new Set(["clear", "resume", "logout", "prompt_input_exit", "other"]);
function buildSessionEndBody(ctx, reason, fold, now) {
  return {
    sessionId: ctx.sessionId,
    reason,
    at: nowIso(now),
    files: Object.entries(fold.edits).map(([path, e]) => ({ path, area: areaFor(ctx, path), edits: e.count })),
    commits: fold.commits.map((c) => ({ sha: c.sha, subject: c.subject, pushed: c.pushed === true })),
    draft: readDraft(ctx.dir)
  };
}
async function runSessionEnd(rt, input) {
  const reason = REASONS.has(input.reason) ? input.reason : "other";
  const ctx = await prepareSession(rt, input);
  const now = rt.now();
  appendJournal(ctx.dir, { t: "end", at: nowIso(now), reason });
  createMark(ctx.dir, "ended");
  if (!hubConfigured(rt)) return null;
  const body = buildSessionEndBody(ctx, reason, loadFold(ctx.dir), now);
  const entry = writeOutbox(rt.home, { sessionId: ctx.sessionId, kind: "session_end", endpoint: "/v1/session/end", body, now });
  if (entry) rt.spawnBg("session-end", ["--entry", entry.id, "--session", ctx.sessionId, "--cwd", ctx.cwd]);
  else rt.log("session-end WAL write failed");
  return null;
}

// src/verbs/post-git.ts
function recordReportedSha(rt, ctx, branch, sha, opts = {}) {
  const release = acquireBgLock(rt.home, "state", ctx.key, { now: rt.now() });
  if (!release) return false;
  try {
    const state = readRepoState(rt.home, ctx.key);
    if (opts.onlyIfUnknown && state.lastReportedSha[branch]) return true;
    return writeRepoState(rt.home, ctx.key, { ...state, lastReportedSha: { ...state.lastReportedSha, [branch]: sha } });
  } finally {
    release();
  }
}
async function runPostGit(rt, input) {
  const command = isRecord(input.tool_input) && typeof input.tool_input["command"] === "string" ? input.tool_input["command"] : "";
  const ctx = await prepareSession(rt, input, { repair: true });
  const now = rt.now();
  const [branch, head] = await Promise.all([rt.git.gitBranch(ctx.cwd, { signal: rt.signal }), rt.git.gitHead(ctx.cwd, { signal: rt.signal })]);
  if (!head) return null;
  const events = [];
  const journal = [];
  const onDurable = [];
  const fold = loadFold(ctx.dir);
  const meta = ctx.meta;
  if (branch && branch !== meta.branch) {
    const startSha = (meta.startSha ? await rt.git.gitMergeBase(ctx.cwd, meta.startSha, "HEAD", { signal: rt.signal }) : null) ?? head;
    const updated = await updateMetaBranch(ctx.dir, { branch, startSha, lastStopSha: null });
    if (updated) ctx.meta = updated;
    appendJournal(ctx.dir, { t: "branch", at: nowIso(now), branch, worktree: meta.worktree, startSha });
    events.push(makeEvent({ type: "branch", branch, worktree: meta.worktree, startSha }, now));
    recordReportedSha(rt, ctx, branch, head, { onlyIfUnknown: true });
    rt.log(`branch ${meta.branch} -> ${branch}, startSha ${startSha.slice(0, 7)}`);
  } else {
    const state = readRepoState(rt.home, ctx.key);
    const from = state.lastReportedSha[meta.branch] ?? meta.lastStopSha ?? meta.startSha;
    if (from !== head) {
      const own = await rt.git.gitOwnCommits(ctx.cwd, { emails: meta.gitEmails, from }, { signal: rt.signal });
      if (own === null) {
        rt.log(`HEAD ${from?.slice(0, 7) ?? "none"} -> ${head.slice(0, 7)}: git log cut off, scan position kept`);
      } else {
        const scan = await commitEvents(rt, ctx, own.reverse(), fold, now);
        events.push(...scan.events);
        journal.push(...scan.journal);
        const next = scan.complete ? head : scan.lastSha;
        if (scan.events.length === 0) {
          if (next) recordReportedSha(rt, ctx, meta.branch, next);
        } else if (next) {
          const sha = next;
          onDurable.push(() => void recordReportedSha(rt, ctx, meta.branch, sha));
        }
        rt.log(`HEAD ${from?.slice(0, 7) ?? "none"} -> ${head.slice(0, 7)}: ${own.length} own commit(s), ${scan.events.length} new${scan.complete ? "" : " (cut off)"}`);
      }
    }
  }
  if (/\bgit\s+(?:[^\n;&|]*\s)?push\b/.test(command) && await rt.git.gitHeadOnRemote(ctx.cwd, { signal: rt.signal })) {
    const b = branch ?? meta.branch;
    events.push(makeEvent({ type: "push", branch: b, sha: head }, now));
    for (const c of loadFold(ctx.dir).commits.filter((c2) => !c2.pushed).slice(-50)) appendJournal(ctx.dir, { ...c, at: nowIso(now), pushed: true });
    for (const line2 of journal) if (line2.t === "commit") line2.pushed = true;
  }
  if (!events.length) return null;
  const posted = await postEvents(rt, ctx, events, {
    fold: loadFold(ctx.dir),
    journal,
    onDurable: () => {
      for (const fn of onDurable) fn();
    }
  });
  return postToolUseOutput(posted.context);
}

// src/bg.ts
var JOBS = /* @__PURE__ */ new Set(["session-start", "prompt", "refresh", "session-end"]);
var DEPINDEX_MAX_AGE_MS = 864e5;
var PLUGIN_REMOTE_MAX_AGE_MS = 864e5;
var AUTO_ACK_CAP = 20;
var DRAIN_BUDGET_MS = 8e3;
async function loadBgContext(rt, sessionId, cwd) {
  const dir = sessionDir(rt.home, sessionId);
  let meta = readMeta(dir);
  if (!meta) {
    const res = await ensureSessionMeta({ home: rt.home, sessionId, cwd, env: rt.env, team: rt.team, pid: rt.env.pid, pluginSha: rt.pluginSha, now: rt.now(), signal: rt.signal });
    meta = res.meta;
  } else {
    const rep = await repairSessionMeta({ home: rt.home, sessionId, cwd, team: rt.team, now: rt.now(), signal: rt.signal });
    if (rep.repaired && rep.meta) {
      meta = rep.meta;
      rt.log(`meta repaired for ${sessionId} (branch ${meta.branch}, startSha ${meta.startSha?.slice(0, 7) ?? "none"}, emails ${meta.gitEmails.length})`);
    }
  }
  if (!meta) return null;
  return {
    input: null,
    sessionId,
    cwd,
    dir,
    meta,
    healed: false,
    config: configForMeta(meta),
    key: meta.repoKey,
    interactive: isInteractive(rt, {}),
    inSubagent: false
  };
}
function readOutboxEntry(rt, id) {
  const v = readJson(outboxPath(rt.home, id));
  return isOutboxEntry(v) ? v : null;
}
async function sendEntry(rt, client, entry, budgetMs) {
  const send = walSender(client, { budgetMs, signal: rt.signal });
  let outcome;
  try {
    outcome = await send(entry, entry.body);
  } catch {
    outcome = false;
  }
  if (outcome === true || outcome === "discard") deleteOutbox(rt.home, entry.id);
  rt.log(`entry ${entry.id} (${entry.kind}) ${outcome === true ? "sent" : outcome === "discard" ? "discarded" : "kept"}`);
  return outcome === true;
}
async function postPromptEntry(rt, ctx, client, entryId) {
  const entry = readOutboxEntry(rt, entryId);
  if (!entry || entry.kind !== "events") return;
  const body = entry.body;
  const prompt = body.events.find((e) => e.type === "prompt");
  if (prompt) {
    const [dirty, branch] = await Promise.all([rt.git.gitDirtyPaths(ctx.cwd, { signal: rt.signal, cap: LIMITS.dirtyPathsCap }), rt.git.gitBranch(ctx.cwd, { signal: rt.signal })]);
    if (dirty) prompt.dirty = dirty;
    if (branch) {
      prompt.branch = branch;
      body.session.branch = branch;
    }
    writeJsonAtomic(outboxPath(rt.home, entry.id), entry);
  }
  await sendEntry(rt, client, entry, BUDGET_MS.workerPost);
}
async function livenessSweep(rt, ctx) {
  let ended = 0;
  const files = listCurrentFiles(rt.home);
  const liveSessions = new Set(files.filter((f) => isPidAlive(f.pid)).map((f) => f.sessionId));
  for (const f of files) {
    if (rt.signal.aborted) break;
    if (isPidAlive(f.pid)) continue;
    const dir = sessionDir(rt.home, f.sessionId);
    if (hasMark(dir, "ended") || liveSessions.has(f.sessionId)) {
      removeCurrentFile(rt.home, f.pid);
      continue;
    }
    const meta = readMeta(dir);
    const now = rt.now();
    const sctx = { ...ctx, sessionId: f.sessionId, dir, cwd: f.cwd, meta: meta ?? ctx.meta, key: meta?.repoKey ?? f.repoKey, config: meta ? configForMeta(meta) : ctx.config };
    const body = buildSessionEndBody(sctx, "crash", loadFold(dir), now);
    appendJournal(dir, { t: "end", at: nowIso(now), reason: "crash" });
    createMark(dir, "ended");
    const client = hubClient(rt, { meta: sctx.meta, sessionId: f.sessionId, key: sctx.key }, "worker");
    const { result } = await postWithWal(client, rt.home, { sessionId: f.sessionId, kind: "session_end", endpoint: "/v1/session/end", body, now }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
    rt.log(`liveness: ended ${f.sessionId} (pid ${f.pid} gone) ${result.ok ? "ok" : result.kind}`);
    removeCurrentFile(rt.home, f.pid);
    ended += 1;
  }
  return ended;
}
async function ancestryChore(rt, ctx, client) {
  const snapshot = readSnapshot(rt.home, ctx.key);
  if (!snapshot) return [];
  const { newlyMerged } = await rt.git.refreshAncestry(rt.home, ctx.key, ctx.cwd, snapshot, { signal: rt.signal, now: rt.now(), maxChecks: 40 });
  for (const id of newlyMerged.slice(0, AUTO_ACK_CAP)) {
    if (rt.signal.aborted) break;
    const r = await client.post("/v1/ack", { id, auto: true }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
    rt.log(`auto-ack ${id}: ${r.ok ? "ok" : r.kind}`);
  }
  derivePending(rt.home, ctx.sessionId, readSnapshot(rt.home, ctx.key) ?? snapshot);
  return newlyMerged;
}
async function depindexChore(rt, ctx, client) {
  const head = await rt.git.gitHead(ctx.cwd, { signal: rt.signal });
  if (!head) return false;
  const state = readRepoState(rt.home, ctx.key);
  const builtAt = parseIso(state.depindexAt);
  if (state.depindexHead === head && builtAt !== null && rt.now() - builtAt < DEPINDEX_MAX_AGE_MS) return false;
  const built = await rt.git.buildDepIndex(ctx.cwd, { repo: ctx.meta.repo, head }, { signal: rt.signal, timeoutMs: Math.min(8e3, Math.max(1e3, rt.remainingMs() - 3500)) });
  if (!built) return false;
  const idx = shrinkDepIndex(built);
  const { result } = await postWithWal(client, rt.home, { sessionId: ctx.sessionId, kind: "depindex", endpoint: "/v1/depindex", body: idx, now: rt.now() }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
  if (result.ok) writeRepoState(rt.home, ctx.key, { ...readRepoState(rt.home, ctx.key), depindexHead: head, depindexAt: nowIso(rt.now()) });
  rt.log(`depindex ${head.slice(0, 7)}: ${Object.keys(idx.imports).length} specifiers, upload ${result.ok ? "ok" : result.kind}`);
  return result.ok;
}
async function pluginBehindChore(rt) {
  const path = join12(rt.home, LOCAL_PATHS.pluginRemote);
  const cached = readJson(path);
  const checkedAt = cached && typeof cached.checkedAt === "string" ? parseIso(cached.checkedAt) : null;
  if (checkedAt !== null && rt.now() - checkedAt < PLUGIN_REMOTE_MAX_AGE_MS) return;
  const names = [rt.team?.marketplace, "relay"].filter((n) => typeof n === "string" && /^[\w.-]+$/.test(n));
  for (const name of names) {
    const sha = await rt.git.gitLsRemoteHead(join12(rt.claudeHome, "plugins", "marketplaces", name), "origin", { signal: rt.signal });
    if (sha) {
      writeJsonAtomic(path, { sha, checkedAt: nowIso(rt.now()) });
      return;
    }
  }
  writeJsonAtomic(path, { sha: cached?.sha ?? "", checkedAt: nowIso(rt.now()) });
}
async function backfillCommits(rt, ctx) {
  const head = await rt.git.gitHead(ctx.cwd, { signal: rt.signal });
  if (!head) return 0;
  const state = readRepoState(rt.home, ctx.key);
  const from = state.lastReportedSha[ctx.meta.branch] ?? ctx.meta.startSha;
  if (!from || from === head) {
    if (!state.lastReportedSha[ctx.meta.branch]) recordReportedSha(rt, ctx, ctx.meta.branch, head, { onlyIfUnknown: true });
    return 0;
  }
  const own = await rt.git.gitOwnCommits(ctx.cwd, { emails: ctx.meta.gitEmails, from, cap: LIMITS.commitBackfillCap }, { signal: rt.signal });
  if (own === null) return 0;
  const scan = await commitEvents(rt, ctx, own.reverse(), loadFold(ctx.dir), rt.now());
  let sent = 0;
  let allDurable = true;
  for (let i = 0; i < scan.events.length; i += LIMITS.commitsPerPost) {
    if (rt.signal.aborted) {
      allDurable = false;
      break;
    }
    const chunk = scan.events.slice(i, i + LIMITS.commitsPerPost);
    const shas = new Set(chunk.map((e) => e.sha));
    const last = chunk[chunk.length - 1]?.sha ?? null;
    const posted = await postEvents(rt, ctx, chunk, {
      role: "worker",
      budgetMs: BUDGET_MS.workerPost,
      journal: scan.journal.filter((l) => l.t === "commit" && shas.has(l.sha)),
      onDurable: () => {
        if (last) recordReportedSha(rt, ctx, ctx.meta.branch, last);
      }
    });
    if (!posted.durable) {
      allDurable = false;
      break;
    }
    sent += chunk.length;
  }
  if (allDurable && scan.complete && !rt.signal.aborted) recordReportedSha(rt, ctx, ctx.meta.branch, head);
  return sent;
}
async function runChores(rt, ctx, client, opts = {}) {
  const step = async (name, fn) => {
    if (rt.signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      rt.log(`chore ${name} failed: ${String(err)}`);
    }
  };
  await step("drain", async () => {
    const release = acquireBgLock(rt.home, "drain", "global", { now: rt.now() });
    if (!release) {
      rt.log("drain: another worker holds the outbox");
      return;
    }
    try {
      const budgetMs = Math.min(DRAIN_BUDGET_MS, Math.max(500, rt.remainingMs() - 4e3));
      const r = await drainOutbox(rt.home, walSender(client, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal }), { now: rt.now(), budgetMs });
      if (r.sent.length || r.dropped.length || r.failedAt || r.outOfTime) rt.log(`drain: sent ${r.sent.length}, dropped ${r.dropped.length}, skipped ${r.skipped.length}${r.failedAt ? `, stopped at ${r.failedAt}` : ""}${r.outOfTime ? ", out of time" : ""}`);
    } finally {
      release();
    }
  });
  await step("liveness", () => livenessSweep(rt, ctx));
  if (opts.ancestry !== false) await step("ancestry", () => ancestryChore(rt, ctx, client));
  if (opts.rotate !== false) await step("rotate", () => rotateJournalIfLarge(ctx.dir));
  if (opts.depindex) await step("depindex", () => depindexChore(rt, ctx, client));
  if (opts.plugin) await step("plugin", () => pluginBehindChore(rt));
}
async function runBg(rt) {
  const [job, ...rest] = rt.args;
  if (!job || !JOBS.has(job)) return;
  const flags = parseFlags(rest);
  const sessionId = flags["session"] ?? rt.env.sessionId ?? null;
  const cwd = flags["cwd"] ?? process.cwd();
  if (!sessionId) return;
  const ctx = await loadBgContext(rt, sessionId, cwd);
  if (!ctx) return;
  const client = hubClient(rt, ctx, "worker");
  rt.log(`bg ${job} for ${sessionId} (${ctx.meta.repo})`);
  const entryId = flags["entry"];
  if (job === "session-end" && entryId) {
    const entry = readOutboxEntry(rt, entryId);
    if (entry) await sendEntry(rt, client, entry, BUDGET_MS.sessionEndPost);
  } else if (job === "prompt" && entryId) {
    await postPromptEntry(rt, ctx, client, entryId);
  }
  const release = acquireBgLock(rt.home, job, ctx.key, { now: rt.now() });
  if (!release) {
    rt.log(`bg ${job}: another worker holds the lock`);
    return;
  }
  try {
    switch (job) {
      case "session-start": {
        await postEvents(rt, ctx, [], { role: "worker", budgetMs: BUDGET_MS.workerPost });
        await backfillCommits(rt, ctx);
        await runChores(rt, ctx, client, { depindex: true, plugin: true });
        break;
      }
      case "prompt":
        await runChores(rt, ctx, client, {});
        break;
      case "refresh": {
        const r = await client.get("/v1/snapshot", { repo: ctx.meta.repo }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
        if (r.ok) clearRefreshWanted(rt.home);
        rt.log(`refresh: ${r.ok ? "ok" : r.kind} in ${r.ms} ms`);
        await runChores(rt, ctx, client, {});
        break;
      }
      case "session-end":
        await runChores(rt, ctx, client, { ancestry: false, rotate: false });
        break;
    }
  } finally {
    release();
  }
}

// src/io.ts
import { writeSync as writeSync2 } from "node:fs";
var EMPTY_STDIN_WAIT_MS = 1500;
function readStdin(stream = process.stdin, idleMs = EMPTY_STDIN_WAIT_MS) {
  return new Promise((resolve2) => {
    let done = false;
    const chunks = [];
    const finish = () => {
      if (done) return;
      done = true;
      resolve2(Buffer.concat(chunks).toString("utf8"));
    };
    try {
      if (stream.isTTY) {
        finish();
        return;
      }
      let size = 0;
      const idle = setTimeout(finish, idleMs);
      idle.unref();
      stream.on("data", (c) => {
        if (size > 4 * 1024 * 1024) return;
        chunks.push(c);
        size += c.length;
      });
      stream.on("end", () => {
        clearTimeout(idle);
        finish();
      });
      stream.on("error", () => {
        clearTimeout(idle);
        finish();
      });
      stream.resume();
    } catch {
      finish();
    }
  });
}
function parseHookInput(text) {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return isHookInput(v) ? v : null;
  } catch {
    return null;
  }
}
function capOutput(out, max = LIMITS.hookStdoutChars) {
  const size = (o) => JSON.stringify(o).length;
  if (size(out) <= max) return out;
  const copy = JSON.parse(JSON.stringify(out));
  const hso = copy.hookSpecificOutput;
  for (const key of ["additionalContext", "systemMessage", "permissionDecisionReason"]) {
    const holder = key === "systemMessage" ? copy : hso;
    const value = holder?.[key];
    if (!holder || typeof value !== "string") continue;
    const over = size(copy) - max;
    if (over <= 0) break;
    holder[key] = value.slice(0, Math.max(0, value.length - over - 16)) + "\u2026";
  }
  return copy;
}
function writeStdout(text) {
  try {
    writeSync2(1, text);
  } catch {
    try {
      process.stdout.write(text);
    } catch {
    }
  }
}
function outcomeOf(out) {
  if (!out) return "none";
  const h = out.hookSpecificOutput;
  if (h?.["permissionDecision"] === "deny") return "deny";
  if (h?.["permissionDecision"] === "ask") return "ask";
  if (h?.["hookEventName"] === "SessionStart") return "digest";
  return "context";
}

// src/verbs/cwd.ts
import { relative as relative3 } from "node:path";
async function runCwd(rt, input) {
  const to = typeof input.new_cwd === "string" && input.new_cwd ? input.new_cwd : input.cwd;
  const from = typeof input.old_cwd === "string" ? input.old_cwd : input.cwd;
  const before = readMeta(sessionDir(rt.home, input.session_id));
  const ctx = await prepareSession(rt, input, { cwd: to });
  appendEnvExports(rt, ctx.meta);
  const now = rt.now();
  const movedRepo = !before || before.repoRoot !== ctx.meta.repoRoot || before.repo !== ctx.meta.repo;
  if (!movedRepo && !ctx.healed) {
    return null;
  }
  appendJournal(ctx.dir, { t: "cwd", at: nowIso(now), from, to });
  if (!hubConfigured(rt)) return null;
  const rel = (root, abs) => {
    try {
      return toPosix(relative3(root, abs));
    } catch {
      return "";
    }
  };
  const event = makeEvent({ type: "cwd", from: rel(before?.repoRoot ?? ctx.meta.repoRoot, from), to: rel(ctx.meta.repoRoot, to), repo: ctx.meta.repo, branch: ctx.meta.branch }, now);
  writeOutbox(rt.home, {
    sessionId: ctx.sessionId,
    kind: "events",
    endpoint: "/v1/events",
    body: { session: buildPresence(rt, ctx), events: [event] },
    now
  });
  rt.log(`cwd moved ${from} -> ${to} (repo ${ctx.meta.repo})`);
  return null;
}

// src/verbs/mute.ts
async function runMute(rt, cwd = process.cwd()) {
  const undo = rt.args.includes("--undo");
  const target = rt.args.find((a) => !a.startsWith("--"))?.trim();
  const rp = await rt.git.revParseSet(cwd, { signal: rt.signal });
  const root = rp.toplevel ?? cwd;
  const slug = normalizeOriginUrl(rp.originUrl) ?? localSlug(root);
  const config = loadRelayConfig(root, { slug, project: rt.env.project });
  const key = repoKey(config.resolved.repo);
  if (!target) {
    const list2 = readMutes(rt.home, key);
    return list2.length ? `Relay mutes for ${config.resolved.repo}: ${list2.map((m) => `${m.target} (${m.kind})`).join(", ")}` : `Relay: no mutes for ${config.resolved.repo}`;
  }
  if (undo) {
    removeMute(rt.home, key, target);
    return `Relay: unmuted ${target} for ${config.resolved.repo} on this machine`;
  }
  const list = addMute(rt.home, key, target, config.resolved.areas, rt.now());
  const kind = list.find((m) => m.target === target)?.kind ?? "path";
  return `Relay: muted ${target} (${kind}) for ${config.resolved.repo} on this machine; collision and impact notes for it are silenced until /relay:mute ${target} --undo`;
}

// src/verbs/post-edit.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
async function runPostEdit(rt, input) {
  const filePath = editToolPath(input.tool_input);
  if (!filePath) return null;
  const tool = EDIT_TOOLS.has(input.tool_name) ? input.tool_name : "Edit";
  const ctx = await prepareSession(rt, input, { repair: true });
  const rel = toRepoRelative(filePath, ctx.meta.repoRoot, ctx.cwd);
  if (!rel) return null;
  const now = rt.now();
  const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
  appendJournal(ctx.dir, { t: "edit", at: nowIso(now), path: rel, tool, toolUseId });
  for (const key of listMarks(ctx.dir, "asked")) {
    const mark = readAskedMark(ctx.dir, key);
    if (mark?.path === rel) promoteAskedToSnooze(ctx.dir, key, now);
  }
  const fold = loadFold(ctx.dir);
  const events = [makeEvent({ type: "edit", path: rel, tool, toolUseId, area: areaFor(ctx, rel) }, now)];
  const diff = await rt.git.gitDiffU0(ctx.cwd, rel, { signal: rt.signal });
  const contract = await workingTreeContract(rt, ctx, rel, diff, fold, now);
  if (contract.event) events.push(contract.event);
  if (contract.retract) events.push(contract.retract);
  const posted = await postEvents(rt, ctx, events, { fold: loadFold(ctx.dir), journal: contract.journal });
  return postToolUseOutput(posted.context);
}

// src/verbs/pre-edit.ts
function jitCandidates(snapshot, dir, rel, areas) {
  const pathAreas = new Set(areasOfPath(rel, areas));
  const rank = { high: 0, normal: 1, low: 2 };
  return snapshot.changeSets.filter((cs) => cs.dependents.length > 0 && !hasMark(dir, "jit", cs.id)).filter(
    (cs) => cs.dependents.some(
      (d) => d.path === rel || d.area !== null && pathAreas.has(d.area) || // a `depends`-derived dependent carries the area's first glob as its path (hub note)
      (d.via === "depends" || isGlobPattern(d.path)) && matchGlob(d.path, rel)
    )
  ).sort((a, b) => rank[a.priority] - rank[b.priority] || (b.at < a.at ? -1 : b.at > a.at ? 1 : 0)).slice(0, LIMITS.jitChangeSetsPerHook);
}
function renderJitNotes(rt, ctx, candidates, budget) {
  const merged = readAncestry(rt.home, ctx.key)?.merged ?? {};
  const notes = [];
  let used = 0;
  for (const cs of candidates) {
    if (used >= budget) break;
    if (createMark(ctx.dir, "jit", cs.id) !== "created") continue;
    const note = renderChangeSetNote(cs, { withHunk: true, merged: merged[cs.id], now: rt.now(), maxChars: Math.max(200, budget - used) });
    notes.push(note);
    used += note.length + 2;
  }
  return notes;
}
async function runPreEdit(rt, input) {
  const filePath = editToolPath(input.tool_input);
  if (!filePath) return null;
  const ctx = await prepareSession(rt, input);
  const rel = toRepoRelative(filePath, ctx.meta.repoRoot, ctx.cwd);
  if (!rel) return null;
  const mutes = readMutes(rt.home, ctx.key);
  const areas = ctx.config.resolved.areas;
  const snap = readSnapshot(rt.home, ctx.key);
  const fresh = freshnessOf(rt.home, snap, rt.now());
  if (shouldSpawnRefresh(rt.home, fresh.ageMs, rt.now())) {
    writeRefreshWanted(rt.home);
    rt.spawnBg("refresh", ["--session", ctx.sessionId, "--cwd", ctx.cwd]);
  }
  const now = rt.now();
  const verdict = assessCollision({
    path: rel,
    me: { dev: ctx.meta.dev, sessionId: ctx.sessionId, branch: ctx.meta.branch, worktree: ctx.meta.worktree },
    snapshot: snap,
    ancestry: readAncestry(rt.home, ctx.key),
    policy: ctx.config.resolved.collision,
    areas,
    breaker: fresh.breaker,
    interactive: ctx.interactive && !ctx.inSubagent,
    mutes,
    now,
    marks: (other) => {
      const k = markKey(rel, other);
      return { askedAgeMs: markAgeMs(ctx.dir, "asked", k, now), snoozeUntilMs: snoozeUntil(ctx.dir, k, now), noted: hasMark(ctx.dir, "noted", k) };
    }
  });
  if (verdict.downgrades.length) rt.log(`${rel}: ${verdict.severity} -> ${verdict.decision} (${verdict.downgrades.join(", ")})`);
  const pieces = [];
  let decision = null;
  let reason;
  const otherDev = verdict.other?.dev ?? null;
  if (verdict.decision === "deny") {
    decision = "deny";
    reason = renderDenyReason(verdict, now);
    pieces.push(renderCollisionContext(verdict, now));
  } else if (verdict.decision === "ask" && otherDev) {
    const key = markKey(rel, otherDev);
    const mark = { toolUseId: input.tool_use_id ?? null, at: new Date(now).toISOString(), path: rel, dev: otherDev };
    if (verdict.createAsked && renewMark(ctx.dir, "asked", key, JSON.stringify(mark), STALENESS.askedExpiryMs, now) === "created") {
      decision = "ask";
      reason = renderAskReason(verdict);
    }
    pieces.push(renderCollisionContext(verdict, now));
  } else if ((verdict.decision === "context" || verdict.decision === "note") && otherDev) {
    const key = markKey(rel, otherDev);
    if (!verdict.createNoted || createMark(ctx.dir, "noted", key) === "created") pieces.push(renderCollisionContext(verdict, now));
  }
  if (snap) {
    const budget = LIMITS.preToolUseContextChars - pieces.join("\n\n").length - 4;
    if (budget > 200) pieces.push(...renderJitNotes(rt, ctx, jitCandidates(snap, ctx.dir, rel, areas), budget));
  }
  const context = pieces.filter(Boolean).join("\n\n").slice(0, LIMITS.preToolUseContextChars);
  if (!decision && !context) return null;
  return output({
    hookEventName: "PreToolUse",
    ...decision ? { permissionDecision: decision, permissionDecisionReason: reason } : {},
    ...context ? { additionalContext: context } : {}
  });
}

// src/verbs/pre-read.ts
async function runPreRead(rt, input) {
  const filePath = editToolPath(input.tool_input);
  if (!filePath) return null;
  const ctx = await prepareSession(rt, input);
  if (!readPending(ctx.dir).length) return null;
  const rel = toRepoRelative(filePath, ctx.meta.repoRoot, ctx.cwd);
  if (!rel) return null;
  const snap = readSnapshot(rt.home, ctx.key);
  if (!snap) return null;
  const candidates = jitCandidates(snap, ctx.dir, rel, ctx.config.resolved.areas).filter((cs) => cs.dependents.some((d) => d.path === rel));
  if (!candidates.length) return null;
  const notes = renderJitNotes(rt, ctx, candidates, LIMITS.preToolUseContextChars - 4);
  derivePending(rt.home, ctx.sessionId, snap);
  if (!notes.length) return null;
  return output({ hookEventName: "PreToolUse", additionalContext: notes.join("\n\n").slice(0, LIMITS.preToolUseContextChars) });
}

// src/verbs/prompt.ts
var JOURNAL_PROMPT_CHARS = 300;
function systemMessageFor(lines) {
  if (!lines.length) return null;
  const impacts = lines.filter((l) => l.startsWith("IMPACT")).length;
  const notes = lines.length - impacts;
  const parts = [];
  if (impacts) parts.push(`${impacts} impact${impacts === 1 ? "" : "s"}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  return `Relay: ${parts.join(", ")} (in Claude's context)`;
}
async function runPrompt(rt, input) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const ctx = await prepareSession(rt, input);
  const now = rt.now();
  const privacy = ctx.config.resolved.privacy;
  const fold = loadFold(ctx.dir);
  const promptId = typeof input.prompt_id === "string" ? input.prompt_id : null;
  appendJournal(ctx.dir, {
    t: "prompt",
    at: nowIso(now),
    promptId,
    len: prompt.length,
    sha1: sha1(prompt),
    ...privacy.send_prompts ? { text: redact(prompt).slice(0, JOURNAL_PROMPT_CHARS) } : {}
  });
  let objectiveChanged = false;
  if (privacy.objective_from_prompts) {
    const cand = candidateFromPrompt(prompt, { lastTurnWasQuestion: fold.lastTurnWasQuestion });
    const next = nextPromptObjective(fold.objective, cand, now);
    if (next) {
      appendJournal(ctx.dir, { t: "objective", at: nowIso(now), objective: next, source: "prompt" });
      objectiveChanged = true;
    }
  }
  const foldNow = objectiveChanged ? loadFold(ctx.dir) : fold;
  let snap = readSnapshot(rt.home, ctx.key);
  const age = snapshotAgeMs(snap, now);
  const ttl = rt.env.snapshotTtlMs ?? BREAKER.snapshotTtlMs;
  if ((age === null || age > ttl) && !breakerOpen(rt.home, now) && rt.team) {
    const budgetMs = Math.min(age === null || age > BREAKER.pauseMs ? BUDGET_MS.promptRefreshAfterPause : BUDGET_MS.promptRefresh, Math.max(100, rt.remainingMs() - 150));
    const client = hubClient(rt, ctx, "sync");
    const r = await client.get("/v1/snapshot", { repo: ctx.meta.repo }, { budgetMs, signal: rt.signal });
    rt.log(`snapshot refresh ${r.ok ? "ok" : r.kind} in ${r.ms} ms`);
    if (r.ok) snap = readSnapshot(rt.home, ctx.key) ?? snap;
  }
  const delivery = collectInbox(rt, ctx, snap, { changeSets: "high" });
  const block = inboxBlock(rt, delivery, LIMITS.promptInboxChars);
  if (!hubConfigured(rt)) return block ? output({ hookEventName: "UserPromptSubmit", additionalContext: block }) : null;
  const event = makeEvent(
    {
      type: "prompt",
      promptId,
      objective: null,
      objectiveSource: null,
      dirty: [],
      branch: ctx.meta.branch,
      ...privacy.send_prompts ? { text: redact(prompt).slice(0, LIMITS.promptWireChars) } : {}
    },
    now
  );
  const presence = buildPresence(rt, ctx, foldNow);
  event.objective = presence.objective;
  event.objectiveSource = presence.objectiveSource;
  const entry = writeOutbox(rt.home, {
    sessionId: ctx.sessionId,
    kind: "events",
    endpoint: "/v1/events",
    body: { session: presence, events: [event], ...delivery.delivered.length ? { delivered: delivery.delivered } : {} },
    now
  });
  rt.spawnBg("prompt", ["--session", ctx.sessionId, "--cwd", ctx.cwd, ...entry ? ["--entry", entry.id] : []]);
  if (!block) return null;
  const systemMessage = systemMessageFor(delivery.lines);
  return output({ hookEventName: "UserPromptSubmit", additionalContext: block }, systemMessage ? { systemMessage } : {});
}

// src/verbs/session-start.ts
import { copyFileSync, readFileSync as readFileSync3 } from "node:fs";
import { join as join13 } from "node:path";
import { relative as relative4 } from "node:path";
var SOURCES = /* @__PURE__ */ new Set(["startup", "resume", "clear", "compact", "fork"]);
var DELTA_WINDOW_MS = 12 * 36e5;
function insertDigestLines(digest, lines) {
  const extra = lines.filter(Boolean);
  if (!extra.length) return digest;
  const close = digest.indexOf(">");
  if (!digest.startsWith("<relay-digest") || close < 0) return `${extra.join("\n")}
${digest}`;
  const head = digest.slice(0, close + 1);
  let tail = digest.slice(close + 1);
  if (tail.startsWith("\n")) tail = tail.slice(1);
  return `${head}
${extra.join("\n")}
${tail}`;
}
function installStatusline(rt) {
  if (rt.env.pluginRoot) {
    const src = join13(rt.env.pluginRoot, "scripts", "statusline.sh");
    const dst = join13(rt.home, LOCAL_PATHS.statusline);
    try {
      const a = readFileSync3(src, "utf8");
      let b = null;
      try {
        b = readFileSync3(dst, "utf8");
      } catch {
        b = null;
      }
      if (a !== b) copyFileSync(src, dst);
    } catch {
    }
  }
  const settings = readJson(join13(rt.claudeHome, "settings.json"));
  const statusLine = isRecord(settings) ? settings["statusLine"] : null;
  const command = isRecord(statusLine) && typeof statusLine["command"] === "string" ? statusLine["command"] : null;
  if (command && !/statusline\.sh|relay/i.test(command)) writeAtomic(join13(rt.home, LOCAL_PATHS.statuslineChain), command + "\n");
}
function clientDigestLines(rt, ctx, opts) {
  const lines = [];
  if (opts.offline && isPlaceholderHandle(ctx.meta.dev)) lines.push(renderIdentityUnknownLine(ctx.meta.gitEmail));
  const breaker = readBreaker(rt.home, rt.now());
  if (breaker.configError && opts.configLine !== false) lines.push(renderPluginUpdateLine(breaker.configError.status, breaker.configError.message));
  const remote = readJson(join13(rt.home, LOCAL_PATHS.pluginRemote));
  const local = rt.pluginSha;
  if (remote && typeof remote.sha === "string" && local && /^[0-9a-f]{40}$/.test(local) && /^[0-9a-f]{40}$/.test(remote.sha) && remote.sha !== local) {
    lines.push(renderPluginUpdateLine(null, `local ${local.slice(0, 7)}, marketplace ${remote.sha.slice(0, 7)}`));
  }
  return lines;
}
function markDigestChangeSetsSeen(dir, digest) {
  const ids = [...new Set(digest.match(/\bcs_[0-9A-Za-z]{10,32}\b/g) ?? [])];
  for (const id of ids) createMark(dir, "seen", id);
  return ids;
}
function mayReplaceTitle(existing) {
  if (typeof existing !== "string" || existing.trim() === "") return true;
  return /^[\w.\/@ -]{1,40}: .+$/.test(existing.trim());
}
function forgetPreviousEnd(rt, ctx) {
  removeMark(ctx.dir, "ended");
  for (const entry of listOutbox(rt.home).entries) {
    if (entry.kind === "session_end" && entry.sessionId === ctx.sessionId) deleteOutbox(rt.home, entry.id);
  }
  for (const f of listCurrentFiles(rt.home)) {
    if (f.sessionId === ctx.sessionId && f.pid !== rt.env.pid && !isPidAlive(f.pid)) removeCurrentFile(rt.home, f.pid);
  }
}
function sessionTitleFor(rt, ctx) {
  const fold = loadFold(ctx.dir);
  const objective = deriveObjective(fold, { branch: ctx.meta.branch, repoSlug: ctx.meta.repo, objectiveFromPrompts: ctx.config.resolved.privacy.objective_from_prompts });
  if (objective.source === "branch") return null;
  let cwdRel = null;
  try {
    cwdRel = toPosix(relative4(ctx.meta.repoRoot, ctx.cwd));
  } catch {
    cwdRel = null;
  }
  const area = voteArea({
    recentEdits: fold.recentPaths.slice(0, 20).map((p) => ({ path: p, at: fold.edits[p]?.lastAt ?? ctx.meta.startedAt })),
    areas: ctx.config.resolved.areas,
    branch: ctx.meta.branch,
    dev: ctx.meta.dev,
    cwdRel,
    now: rt.now()
  });
  return `${area.display}: ${objective.text}`.slice(0, 120);
}
async function runSessionStart(rt, input) {
  const source = SOURCES.has(input.source) ? input.source : "startup";
  const model = typeof input.model === "string" ? input.model : null;
  const before = readMeta(sessionDir(rt.home, input.session_id));
  if (source === "compact") {
    const ctx2 = await prepareSession(rt, input, { source });
    const fold = loadFold(ctx2.dir);
    const objective = deriveObjective(fold, { branch: ctx2.meta.branch, repoSlug: ctx2.meta.repo, objectiveFromPrompts: ctx2.config.resolved.privacy.objective_from_prompts });
    const text = renderCompactReinjection(readSnapshot(rt.home, ctx2.key), {
      meDev: ctx2.meta.dev,
      objective: objective.source === "branch" ? null : objective.text,
      now: rt.now(),
      ancestryMerged: readAncestry(rt.home, ctx2.key)?.merged
    });
    return output({ hookEventName: "SessionStart", additionalContext: text });
  }
  const ctx = await prepareSession(rt, input, { force: true, source, model });
  forgetPreviousEnd(rt, ctx);
  installStatusline(rt);
  appendEnvExports(rt, ctx.meta);
  const now = rt.now();
  const meta = ctx.meta;
  const lastStopAt = before?.lastStopAt ? parseIso(before.lastStopAt) : null;
  const delta = (source === "resume" || source === "fork") && lastStopAt !== null && now - lastStopAt < DELTA_WINDOW_MS;
  const placeholder = before && isPlaceholderHandle(before.dev) && !isPlaceholderHandle(meta.dev) ? before.dev : void 0;
  let digest = null;
  let failure = null;
  let configError = null;
  if (rt.team && !breakerOpen(rt.home, now)) {
    const recentShas = await rt.git.gitRecentShas(ctx.cwd, LIMITS.recentShas, { signal: rt.signal });
    let cwdRel = "";
    try {
      cwdRel = toPosix(relative4(meta.repoRoot, ctx.cwd));
    } catch {
      cwdRel = "";
    }
    const body = {
      v: PROTOCOL_VERSION,
      session: {
        id: ctx.sessionId,
        source,
        client: meta.client,
        host: meta.host,
        // repo-relative; the absolute checkout path (OS user name) stays on the machine (§11.1)
        cwd: cwdRel,
        repo: { slug: meta.repo, project: meta.project, config: ctx.config.raw, configHash: ctx.config.hash },
        branch: meta.branch,
        worktree: meta.worktree,
        startSha: meta.startSha,
        model: meta.model,
        pluginSha: meta.pluginSha
      },
      mode: delta ? "delta" : "full",
      ...delta && before?.lastStopAt ? { since: before.lastStopAt } : {},
      recentShas,
      identityHint: { gitEmail: meta.gitEmail, ...placeholder ? { placeholder } : {}, source: meta.identitySource }
    };
    const client = hubClient(rt, ctx, "sync");
    const budgetMs = Math.min(BUDGET_MS.sessionStartPost, Math.max(300, rt.remainingMs() - 150));
    const r = await client.post("/v1/session/start", body, { budgetMs, signal: rt.signal });
    if (r.ok && isRecord(r.data) && typeof r.data["digest"] === "string") {
      digest = r.data["digest"];
      writeDigest(rt.home, ctx.key, digest);
      markDigestChangeSetsSeen(ctx.dir, digest);
      rt.log(`session start ok in ${r.ms} ms (${digest.length} chars, mode ${body.mode})`);
    } else {
      failure = r.ok ? "no digest in response" : `${r.kind}${r.status ? ` ${r.status}` : ""}: ${r.message}`;
      if (!r.ok && r.kind === "config") configError = { status: r.status, message: r.message };
      rt.log(`session start failed: ${failure}`);
    }
  } else {
    failure = rt.team ? "breaker open" : "no team.json / RELAY_HUB";
    const breaker = readBreaker(rt.home, now);
    if (rt.team && breaker.configError) configError = { status: breaker.configError.status, message: breaker.configError.message };
    rt.log(`session start skipped: ${failure}`);
  }
  const offline = digest === null;
  let configDigest = false;
  if (digest === null) {
    const cached = readDigest(rt.home, ctx.key, now);
    if (cached) digest = wrapCachedDigest(cached.digest, cached.ageMs);
    else if (configError) {
      digest = renderConfigErrorDigest(configError.status, configError.message, now);
      configDigest = true;
    } else digest = renderOfflineDigest(now);
  }
  digest = insertDigestLines(digest, clientDigestLines(rt, ctx, { offline, configLine: !configDigest }));
  if (digest.length > LIMITS.digestChars + 600) digest = digest.slice(0, LIMITS.digestChars + 600);
  rt.spawnBg("session-start", ["--session", ctx.sessionId, "--cwd", ctx.cwd]);
  const title = !ctx.inSubagent && (source === "startup" || source === "resume" || source === "fork") && mayReplaceTitle(input.session_title) ? sessionTitleFor(rt, ctx) : null;
  return output({ hookEventName: "SessionStart", additionalContext: digest, ...title ? { sessionTitle: title } : {} });
}

// src/handoff-draft.ts
import { basename as basename4 } from "node:path";
var DONE_RE = /^(Done|I've|I have|Added|Updated|Fixed|Implemented|Removed|Renamed|Migrated|Committed|Created|Wrote|Refactored|Moved|Deleted|Replaced|Extracted)\b/;
var DECISION_RE = /\b(decided|decision|we'll go with|going with|chose|settled on|instead of)\b/i;
var BLOCKER_RE = /\b(blocked|blocker|waiting on|can't proceed|cannot|need [^.]* from)\b/i;
var NEXT_HEADING_RE = /^\s*(?:#+\s*|\*\*)?(next(?: steps)?|todo|remaining)\b/i;
var HEADING_RE = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*:?\s*$)/;
var BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
var DONE_MAX = 6;
var NEXT_MAX = 5;
var LINE_MAX = 140;
function sentencesOf(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^[-*•\d.)\s]+/, "").trim()).filter((s) => s.length > 3);
}
function nextBullets(text, max = NEXT_MAX) {
  const out = [];
  let inNext = false;
  for (const raw of text.split("\n")) {
    const line2 = raw.trimEnd();
    if (NEXT_HEADING_RE.test(line2) && (HEADING_RE.test(line2) || /:\s*$/.test(line2) || /^\s*\*\*/.test(line2))) {
      inNext = true;
      continue;
    }
    if (!inNext) continue;
    if (HEADING_RE.test(line2)) break;
    const b = BULLET_RE.exec(line2);
    if (b?.[1]) {
      out.push(truncateWords(b[1].trim(), LINE_MAX));
      if (out.length >= max) break;
    } else if (line2.trim() === "" && out.length) break;
  }
  return out;
}
function isTrivialSession(fold) {
  return Object.keys(fold.edits).length === 0 && fold.commits.length === 0 && fold.prompts.count < 3;
}
function buildHandoffDraft(input) {
  const { fold, areas } = input;
  const now = input.now ?? Date.now();
  const objective = deriveObjective(fold, { branch: input.branch, repoSlug: input.repoSlug, objectiveFromPrompts: input.objectiveFromPrompts });
  const changed = Object.entries(fold.edits).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).map(([path, e]) => ({ path, area: areaOfPath(path, areas), edits: e.count }));
  for (const path of input.outsideFiles ?? []) if (!fold.edits[path]) changed.push({ path, area: areaOfPath(path, areas), edits: 0 });
  const areaSet = /* @__PURE__ */ new Set();
  for (const c of changed) if (c.area) areaSet.add(c.area);
  const commitByPath = /* @__PURE__ */ new Map();
  for (const c of fold.commits) for (const p of c.contracts) if (!commitByPath.has(p)) commitByPath.set(p, { sha: c.sha, pushed: c.pushed === true });
  const interfaces = Object.values(openContracts(fold)).map((c) => {
    const commit = commitByPath.get(c.path);
    return {
      changeSetId: null,
      impactId: null,
      path: c.path,
      symbols: c.symbols,
      summary: `${basename4(c.path)}: ${c.symbols.length ? c.symbols.join(", ") : "edited"}`,
      status: commit ? commit.pushed ? "pushed" : "committed" : "uncommitted",
      commitSha: commit?.sha ?? null
    };
  });
  const lastTurns = fold.turns.slice(-2).map((t) => t.text);
  const done = fold.tasks.done.map((t) => truncateWords(t.subject, LINE_MAX));
  const decisions = [];
  const blockers = [];
  for (const text of lastTurns) {
    for (const s of sentencesOf(text)) {
      if (done.length < DONE_MAX && DONE_RE.test(s)) done.push(truncateWords(s, LINE_MAX));
      if (DECISION_RE.test(s) && decisions.length < 5) decisions.push(truncateWords(s, LINE_MAX));
      if (BLOCKER_RE.test(s) && blockers.length < 5) blockers.push(truncateWords(s, LINE_MAX));
    }
  }
  const last = lastTurns[lastTurns.length - 1] ?? "";
  const draft = {
    at: nowIso(now),
    quality: "heuristic",
    objective: objective.text,
    areas: [...areaSet],
    done: unique(done).slice(0, DONE_MAX + fold.tasks.done.length),
    changed: changed.slice(0, 60),
    interfaces_changed: interfaces,
    decisions: unique(decisions),
    blockers: unique(blockers),
    next: nextBullets(last),
    commits: fold.commits.map((c) => ({ sha: c.sha, subject: c.subject, pushed: c.pushed === true })),
    notes_to: [],
    objectiveTrail: fold.objective.trail.map((o) => o.objective).slice(0, 5)
  };
  return shrinkDraft(draft);
}
function unique(list) {
  return [...new Set(list)];
}
function shrinkDraft(draft) {
  let d = draft;
  const size = () => Buffer.byteLength(JSON.stringify(d));
  if (size() <= LIMITS.draftBytes) return d;
  d = { ...d, changed: d.changed.slice(0, 30), commits: d.commits.slice(-20) };
  if (size() <= LIMITS.draftBytes) return d;
  d = { ...d, interfaces_changed: d.interfaces_changed.slice(0, 10), done: d.done.slice(0, 6), decisions: d.decisions.slice(0, 3), blockers: d.blockers.slice(0, 3) };
  if (size() <= LIMITS.draftBytes) return d;
  return { ...d, changed: d.changed.slice(0, 10), commits: d.commits.slice(-5), objectiveTrail: [] };
}

// src/verbs/stop.ts
var DIRTY_CONTRACT_CAP = 12;
async function runStop(rt, input) {
  const ctx = await prepareSession(rt, input, { repair: true });
  const now = rt.now();
  const privacy = ctx.config.resolved.privacy;
  const promptId = typeof input.prompt_id === "string" ? input.prompt_id : null;
  const raw = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const text = privacy.send_turns === false ? null : redact(privacy.send_turns === "full" ? raw.slice(0, LIMITS.turnTextChars) : prose(raw));
  appendJournal(ctx.dir, { t: "turn", at: nowIso(now), promptId, text: text ?? "" });
  const events = [];
  const journal = [];
  const meta = ctx.meta;
  const [branch, head] = await Promise.all([rt.git.gitBranch(ctx.cwd, { signal: rt.signal }), rt.git.gitHead(ctx.cwd, { signal: rt.signal })]);
  const outside = /* @__PURE__ */ new Set();
  let stopSha = head;
  if (head) {
    if (branch && branch !== meta.branch) {
      const startSha = (meta.startSha ? await rt.git.gitMergeBase(ctx.cwd, meta.startSha, "HEAD", { signal: rt.signal }) : null) ?? head;
      const updated = await updateMetaBranch(ctx.dir, { branch, startSha, lastStopSha: null });
      if (updated) ctx.meta = updated;
      appendJournal(ctx.dir, { t: "branch", at: nowIso(now), branch, worktree: meta.worktree, startSha });
      events.push(makeEvent({ type: "branch", branch, worktree: meta.worktree, startSha }, now));
    }
    const cur = ctx.meta;
    const base = cur.startSha ? await rt.git.gitMergeBase(ctx.cwd, cur.startSha, "HEAD", { signal: rt.signal }) : null;
    const from = cur.lastStopSha ?? base;
    const fold0 = loadFold(ctx.dir);
    if (from !== head) {
      const own = await rt.git.gitOwnCommits(ctx.cwd, { emails: cur.gitEmails, from }, { signal: rt.signal });
      if (own === null) {
        stopSha = from;
      } else {
        const scan = await commitEvents(rt, ctx, own.reverse(), fold0, now);
        for (const f of scan.files) outside.add(f);
        events.push(...scan.events);
        journal.push(...scan.journal);
        if (!scan.complete) stopSha = scan.lastSha ?? from;
      }
    }
    const dirty = await rt.git.gitDirtyPaths(ctx.cwd, { signal: rt.signal }) ?? [];
    for (const p of dirty) outside.add(p);
    const fold1 = loadFold(ctx.dir);
    const touched = /* @__PURE__ */ new Set([...dirty, ...Object.keys(openContracts(fold1))]);
    for (const rel of contractCandidatePaths(ctx, [...touched], DIRTY_CONTRACT_CAP)) {
      if (rt.signal.aborted || rt.remainingMs() < 1200) break;
      const diff = await rt.git.gitDiffU0(ctx.cwd, rel, { signal: rt.signal });
      const r = await workingTreeContract(rt, ctx, rel, diff, loadFold(ctx.dir), now);
      if (r.event) events.push(r.event);
      if (r.retract) events.push(r.retract);
      journal.push(...r.journal);
    }
  }
  for (const p of Object.keys(loadFold(ctx.dir).edits)) outside.delete(p);
  const fold = foldEntries(journal, loadFold(ctx.dir));
  const draft = isTrivialSession(fold) ? null : buildHandoffDraft({
    fold,
    areas: ctx.config.resolved.areas,
    branch: ctx.meta.branch,
    repoSlug: ctx.meta.repo,
    objectiveFromPrompts: privacy.objective_from_prompts,
    outsideFiles: [...outside].slice(0, 100),
    now
  });
  if (draft) writeDraft(ctx.dir, draft);
  events.push(makeEvent({ type: "turn_end", promptId, text, draft }, now));
  const posted = await postEvents(rt, ctx, events, { fold, journal });
  if (head) {
    const advance = posted.durable && stopSha !== null && stopSha !== ctx.meta.lastStopSha;
    await updateMetaBranch(ctx.dir, { lastStopAt: nowIso(now), ...advance ? { lastStopSha: stopSha } : {} });
    if (advance && stopSha) recordReportedSha(rt, ctx, ctx.meta.branch, stopSha);
  }
  return null;
}

// src/verbs/tasks.ts
async function runTask(rt, input) {
  const id = typeof input.task_id === "string" ? input.task_id : typeof input.task_id === "number" ? String(input.task_id) : null;
  const subject = typeof input.task_subject === "string" ? redact(input.task_subject).trim().slice(0, 300) : "";
  if (!id || !subject) return null;
  const status = input.hook_event_name === "TaskCompleted" ? "completed" : "created";
  const ctx = await prepareSession(rt, input);
  const now = rt.now();
  appendJournal(ctx.dir, { t: "task", at: nowIso(now), id, subject, status });
  if (!hubConfigured(rt)) return null;
  const event = makeEvent({ type: "task", taskId: id, subject, status }, now);
  writeOutbox(rt.home, {
    sessionId: ctx.sessionId,
    kind: "events",
    endpoint: "/v1/events",
    body: { session: buildPresence(rt, ctx), events: [event] },
    ephemeral: false,
    now
  });
  return null;
}

// src/main.ts
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
var HOOK_VERBS = /* @__PURE__ */ new Set([
  "session-start",
  "prompt",
  "pre-edit",
  "pre-read",
  "post-edit",
  "post-git",
  "task-created",
  "task-completed",
  "cwd",
  "stop",
  "session-end"
]);
var verb = process.argv[2] ?? "";
var args = process.argv.slice(3);
var watchdog = null;
function armWatchdog(ms) {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => process.exit(0), ms);
}
armWatchdog(deadlineFor(verb));
async function dispatch(rt, input) {
  switch (rt.verb) {
    case "session-start":
      if (input.hook_event_name !== "SessionStart") return null;
      if (input.source === "compact") {
        rt.setDeadline(DEADLINE_MS["session-start-compact"]);
        armWatchdog(Math.max(50, DEADLINE_MS["session-start-compact"] - (rt.now() - rt.startedAt)));
      }
      return runSessionStart(rt, input);
    case "prompt":
      return input.hook_event_name === "UserPromptSubmit" ? runPrompt(rt, input) : null;
    case "pre-edit":
      return input.hook_event_name === "PreToolUse" ? runPreEdit(rt, input) : null;
    case "pre-read":
      return input.hook_event_name === "PreToolUse" ? runPreRead(rt, input) : null;
    case "post-edit":
      return input.hook_event_name === "PostToolUse" ? runPostEdit(rt, input) : null;
    case "post-git":
      return input.hook_event_name === "PostToolUse" ? runPostGit(rt, input) : null;
    case "task-created":
    case "task-completed":
      return input.hook_event_name === "TaskCreated" || input.hook_event_name === "TaskCompleted" ? runTask(rt, input) : null;
    case "cwd":
      return input.hook_event_name === "CwdChanged" ? runCwd(rt, input) : null;
    case "stop":
      return input.hook_event_name === "Stop" ? runStop(rt, input) : null;
    case "session-end":
      return input.hook_event_name === "SessionEnd" ? runSessionEnd(rt, input) : null;
    default:
      return null;
  }
}
async function main() {
  if (process.env["RELAY_DISABLE"] === "1") return;
  if (verb === "bg") {
    await runBg(createRuntime({ verb: "bg", args }));
    return;
  }
  if (verb === "mute") {
    const line2 = await runMute(createRuntime({ verb: "mute", args }));
    if (line2) writeStdout(line2 + "\n");
    return;
  }
  if (!HOOK_VERBS.has(verb)) return;
  const rt = createRuntime({ verb, args });
  const input = parseHookInput(await readStdin());
  if (!input) {
    rt.log("no usable stdin; exiting silently");
    return;
  }
  let out = null;
  let error;
  try {
    out = await dispatch(rt, input);
  } catch (err) {
    error = String(err?.stack ?? err).slice(0, 500);
    rt.log(`verb failed: ${error}`);
    out = null;
  }
  if (out) writeStdout(JSON.stringify(capOutput(out)));
  appendStats(rt.home, {
    at: new Date(rt.now()).toISOString(),
    event: input.hook_event_name,
    verb,
    ms: rt.now() - rt.startedAt,
    out: error ? "error" : outcomeOf(out),
    sessionId: input.session_id,
    ...error ? { error: error.slice(0, 200) } : {}
  });
}
void (async () => {
  try {
    await main();
  } catch {
  } finally {
    process.exit(0);
  }
})();
