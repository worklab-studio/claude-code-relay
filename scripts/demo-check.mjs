#!/usr/bin/env node
/**
 * `scripts/demo.sh check` (DESIGN.md §12 M0): verify the six demo moments from a third
 * terminal without reading the two Claude terminals. Local facts from the demo rig and
 * ~/.claude plugin state, then the hub's own view (status, snapshot, handoffs, decisions)
 * as each developer. Plain Node >= 18, no dependencies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEMO = process.env.RELAY_DEMO_DIR ?? '/tmp/relay-demo';
const HUB = process.env.RELAY_DEMO_HUB ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.RELAY_DEMO_TOKEN ?? 'demo';
const CLAUDE_DIR = process.env.CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const REPO = 'demo/app';
const DEVS = ['priya', 'arjun'];
const asJson = process.argv.includes('--json');

const out = { hub: null, plugin: {}, local: {}, devs: {}, moments: {} };
const log = (s = '') => { if (!asJson) console.log(s); };

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
function hhmmss(iso) {
  return typeof iso === 'string' && iso.length >= 19 ? iso.slice(11, 19) + 'Z' : String(iso);
}
async function hubGet(dev, path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(HUB + path, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-relay-dev': dev, 'x-relay-client': 'cli', 'x-relay-proto': '1' },
      signal: ctl.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------ hub health
log('== hub');
const health = await hubGet('priya', '/health');
out.hub = health;
if (health.status === 200 && health.body && health.body.db) {
  log(`  up: ${HUB}  version ${health.body.version}  db ${health.body.db}  time ${health.body.time}`);
} else {
  log(`  DOWN or not a Relay hub at ${HUB}: ${JSON.stringify(health.body).slice(0, 200)}`);
}

// ------------------------------------------------------------------ plugin install state
log('\n== plugin install state (~/.claude)');
const mode = (() => { try { return readFileSync(join(DEMO, 'mode'), 'utf8').trim(); } catch { return 'marketplace'; } })();
out.plugin.mode = mode;
const known = readJson(join(CLAUDE_DIR, 'plugins', 'known_marketplaces.json')) ?? {};
const src = known.relay && known.relay.source ? (known.relay.source.url ?? known.relay.source.repo ?? known.relay.source.path) : null;
out.plugin.marketplace = src;
log(`  marketplace 'relay': ${src ? `registered (${src})` : 'not registered' + (mode === 'marketplace' ? ' — registration happens at the first session after the trust dialog' : ' (plugin-dir mode: expected)')}`);
const cacheDir = join(CLAUDE_DIR, 'plugins', 'cache', 'relay', 'relay');
let cached = [];
try { cached = readdirSync(cacheDir).filter((d) => statSync(join(cacheDir, d)).isDirectory()); } catch {}
out.plugin.cached = cached;
log(`  cached versions: ${cached.length ? cached.join(', ') : 'none' + (mode === 'marketplace' ? ' — B.1: cached on the session after registration' : '')}`);
const installed = readJson(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
const entry = installed && installed.plugins ? installed.plugins['relay@relay'] : null;
const entries = Array.isArray(entry) ? entry : entry ? [entry] : [];
out.plugin.installed = entries;
for (const e of entries) log(`  installed: scope ${e.scope ?? '?'} version ${e.version ?? '?'} commit ${e.gitCommitSha ?? '?'}${e.projectPath ? ` project ${e.projectPath}` : ''}`);
// The install record is per project folder (real-claude verification): a clone without one logs
// plugin-cache-miss even though the cache directory exists, and needs its own first session(s).
for (const dev of DEVS) {
  const clone = join(DEMO, `app-${dev}`);
  const covered = entries.some((e) => e.scope === 'user' || (e.projectPath && (e.projectPath === clone || e.projectPath === join('/private', clone))));
  if (entries.length && !covered) log(`  ${dev}: no install record for ${clone} yet — the plugin is not live there until its own first session(s) (see B.1)`);
}
const mkt = join(DEMO, 'mkt');
if (existsSync(mkt)) {
  const mj = readJson(join(mkt, '.claude-plugin', 'marketplace.json'));
  const v = mj && mj.plugins && mj.plugins[0] ? mj.plugins[0].version : null;
  out.plugin.marketplaceVersion = v;
  if (v) log(`  demo marketplace version: ${v}${cached.includes(v) ? ' (cached: plugin is installable/loaded)' : cached.length ? ' (a DIFFERENT version is cached: stale plugin; /reload-plugins or restart)' : ''}`);
}

// ------------------------------------------------------------------ local state per developer
log('\n== local state per developer');
for (const dev of DEVS) {
  const home = join(DEMO, `home-${dev}`);
  const info = { home, live: [], sessions: 0, outbox: 0, statusline: null, lastError: null, configError: null, downUntil: null };
  out.local[dev] = info;
  log(`  ${dev}: ${home}`);
  if (!existsSync(home)) { log('    (no RELAY_HOME yet: no hook has run for this developer)'); continue; }
  try {
    for (const f of readdirSync(join(home, 'current'))) {
      const c = readJson(join(home, 'current', f));
      if (!c) continue;
      const alive = pidAlive(c.pid);
      info.live.push({ pid: c.pid, alive, sessionId: c.sessionId, at: c.at });
      log(`    session ${String(c.sessionId).slice(0, 8)} pid ${c.pid} ${alive ? 'ALIVE' : 'dead'} last hook ${hhmmss(c.at)} cwd ${c.cwd}`);
    }
  } catch {}
  if (info.live.length === 0) log('    no current/<pid>.json: no hook has fired yet (plugin not live?)');
  try { info.sessions = readdirSync(join(home, 'sessions')).length; } catch {}
  try { info.outbox = readdirSync(join(home, 'outbox')).length; } catch {}
  log(`    session journals: ${info.sessions}   outbox entries waiting: ${info.outbox}`);
  try {
    for (const k of readdirSync(join(home, 'cache'))) {
      const p = join(home, 'cache', k, 'statusline.txt');
      if (existsSync(p)) { info.statusline = readFileSync(p, 'utf8').trim(); log(`    status line: ${info.statusline}`); }
    }
  } catch {}
  for (const [key, file] of [['lastError', 'last-error'], ['configError', 'config-error.json'], ['downUntil', 'down-until']]) {
    const p = join(home, file);
    if (existsSync(p)) { info[key] = readFileSync(p, 'utf8').trim().split('\n').slice(-2).join(' | '); log(`    ${file}: ${info[key]}`); }
  }
}

// ------------------------------------------------------------------ hub view per developer
log('\n== hub view');
const sessionsByDev = {};
let changeSetsForArjun = [];
let notesForPriya = [];
let handoffsPriya = [];
let decisionsAll = [];
for (const dev of DEVS) {
  const d = { status: null, snapshot: null, handoffs: null };
  out.devs[dev] = d;
  const st = await hubGet(dev, `/v1/query/status?repo=${encodeURIComponent(REPO)}&project=current`);
  d.status = st.body;
  if (st.status !== 200) { log(`  ${dev}: status ${st.status} ${JSON.stringify(st.body).slice(0, 160)}`); continue; }
  const project = (st.body.projects ?? [])[0];
  if (project) {
    for (const sd of project.devs ?? []) {
      sessionsByDev[sd.dev] = sd.sessions ?? [];
    }
  }
  const snap = await hubGet(dev, `/v1/snapshot?repo=${encodeURIComponent(REPO)}`);
  d.snapshot = snap.body;
  const ho = await hubGet(dev, `/v1/query/handoffs?repo=${encodeURIComponent(REPO)}&dev=${dev}&n=3`);
  d.handoffs = ho.body;
  if (dev === 'arjun' && snap.status === 200) changeSetsForArjun = snap.body.changeSets ?? [];
  if (dev === 'priya' && snap.status === 200) notesForPriya = (snap.body.inbox ?? []).filter((i) => i.kind === 'note');
  if (dev === 'priya' && ho.status === 200) handoffsPriya = ho.body.items ?? [];
  if (dev === 'priya') {
    const de = await hubGet(dev, `/v1/query/decisions?repo=${encodeURIComponent(REPO)}`);
    if (de.status === 200) decisionsAll = de.body.items ?? [];
  }
  log(`  as ${dev}: unacked change sets ${st.body.me?.unackedChangeSets ?? '?'}, unread inbox ${st.body.me?.unreadInbox ?? '?'}, snapshot serverTime ${snap.status === 200 ? hhmmss(snap.body.serverTime) : snap.status}`);
}
log('\n  sessions on the hub (project acme-portal):');
let anyLive = false;
for (const dev of Object.keys(sessionsByDev)) {
  for (const s of sessionsByDev[dev]) {
    if (s.state !== 'gone') anyLive = true;
    log(`    ${dev}: ${s.state.padEnd(7)} ${s.branch}${s.worktree ? ` (${s.worktree})` : ''} area ${s.area ?? '?'} objective "${s.objective ?? ''}" last seen ${hhmmss(s.lastSeenAt)} client ${s.client} edits ${s.editCount}`);
  }
}
if (!anyLive) log('    (no live sessions on the hub: none started yet, or every session has ended)');

log('\n  change sets targeting arjun (impact routing):');
for (const cs of changeSetsForArjun) {
  log(`    ${cs.id} by ${cs.by} ${cs.status}/${cs.priority} at ${hhmmss(cs.at)} branch ${cs.branch}`);
  for (const i of cs.impacts ?? []) log(`      ${i.path} ${i.status ?? ''} symbols ${JSON.stringify(i.symbols ?? [])}${i.commitSha ? ` commit ${String(i.commitSha).slice(0, 7)}` : ''}`);
  for (const dep of (cs.dependents ?? []).slice(0, 6)) log(`      dependent ${dep.path} (${dep.via ?? '?'})`);
}
if (changeSetsForArjun.length === 0) log('    none yet (moment 2 needs priya\'s edit or commit of packages/contracts/src/orders.ts)');

log('\n  notes waiting in priya\'s inbox (undelivered):');
for (const n of notesForPriya) log(`    ${n.id} from ${n.from}: ${n.body}`);
if (notesForPriya.length === 0) log('    none (either not sent yet, or already delivered at priya\'s prompt — delivered notes leave the inbox)');

log('\n  handoffs for priya:');
for (const h of handoffsPriya) {
  log(`    ${h.id} rev ${h.rev} quality ${h.quality} generated ${hhmmss(h.generatedAt)} end ${h.endReason ?? 'open'}`);
  for (const line of (h.done ?? []).slice(0, 3)) log(`      done: ${line}`);
  for (const line of (h.next ?? []).slice(0, 2)) log(`      next: ${line}`);
}
if (handoffsPriya.length === 0) log('    none yet (moment 5: after priya\'s /exit)');

log('\n  decisions:');
for (const d of decisionsAll.slice(0, 5)) log(`    ${hhmmss(d.createdAt)} ${d.dev} (${d.source}): ${d.text}`);
if (decisionsAll.length === 0) log('    none');

// ------------------------------------------------------------------ verdicts
const priyaLive = (sessionsByDev.priya ?? []).some((s) => s.state !== 'gone');
const arjunLive = (sessionsByDev.arjun ?? []).some((s) => s.state !== 'gone');
out.moments = {
  presence: priyaLive || arjunLive,
  impact: changeSetsForArjun.length > 0,
  collision: null,
  notify: notesForPriya.length > 0 || (out.devs.priya?.status?.me?.unreadInbox ?? 0) > 0,
  handoff: handoffsPriya.length > 0,
  digest: null,
};
log('\n== moments');
log(`  1 PRESENCE  ${priyaLive ? 'priya is live on the hub' : 'priya not live yet'}${arjunLive ? '; arjun is live' : ''}`);
log(`  2 IMPACT    ${out.moments.impact ? `${changeSetsForArjun.length} change set(s) routed to arjun` : 'no change set routed to arjun yet'}`);
log('  3 COLLISION local to terminal B (the permission prompt); not observable from the hub');
log(`  4 NOTIFY    ${out.moments.notify ? 'a note for priya is on the hub' : 'no undelivered note for priya (sent notes are delivered at her next prompt)'}`);
log(`  5 HANDOFF   ${out.moments.handoff ? `${handoffsPriya.length} handoff(s) stored for priya` : 'no handoff for priya yet'}`);
log('  6 DIGEST    rendered by the hub at B\'s next session start; ask Claude "what does Relay say?" in terminal B');
if (asJson) console.log(JSON.stringify(out, null, 2));
