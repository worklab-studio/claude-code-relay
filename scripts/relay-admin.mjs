#!/usr/bin/env node
/**
 * Relay admin CLI (DESIGN.md §2.2, §3.1, §3.3). Plain Node >= 18, no dependencies.
 *
 *   relay-admin init-project [dir] [--local] [--project <id>] [--repo <slug>]
 *                            [--area name=glob[,glob]]... [--owner area=dev[,dev]]... [--shared area]...
 *                            [--depends area=area[,area]]... [--marketplace owner/repo]
 *                            [--no-statusline] [--no-plugin] [--force]
 *       writes/merges .claude/settings.json (or settings.local.json with --local) and .relay.json
 *   relay-admin init-team --hub <url> --token <rt_…> --marketplace owner/repo [--team slug]
 *                         --member handle=email[,email][:github]... [--out packages/plugin/team.json]
 *       writes the plugin's team.json (alias: team set)
 *   relay-admin token new                        prints a fresh rt_ team token
 *   relay-admin rotate-token [--hub <url>] [--admin-token <t>] [--team-json <path>] [--no-hub] [--publish]
 *       new token -> hub (POST /admin/token/rotate) -> team.json; prints the Vercel/commit/publish steps (alias: token rotate)
 *   relay-admin publish [publish-plugin.sh args]  copy packages/plugin to the relay-plugin repo and push (alias: plugin publish)
 *   relay-admin demo up|down|stop|check|status    delegates to scripts/demo.sh
 *   relay-admin doctor [--hub <url>] [--token <t>] [--dev <handle>]   local + hub checks for this machine
 *   relay-admin validate                          plugin JSON files, exec-form hooks, sh -n on scripts, claude plugin validate
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(ROOT, 'packages', 'plugin');
const MARKETPLACE_DEFAULT = 'your-org/relay-plugin';
const PERMISSION_RULES = ['mcp__plugin_relay_relay', 'mcp__plugin_relay_relay__*'];
// §4.11: exec the per-machine copy only when it exists, so a project statusLine never breaks a machine without Relay.
const STATUSLINE_COMMAND = `/bin/sh -c 'f="\${RELAY_HOME:-$HOME/.relay}/statusline.sh"; [ -r "$f" ] && exec /bin/sh "$f" || true'`;

// ---------------------------------------------------------------- helpers
function usage(code = 0) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const m = text.match(/\/\*\*([\s\S]*?)\*\//);
  console.log((m ? m[1] : '').replace(/^ \* ?/gm, '').trim());
  process.exit(code);
}
function fail(msg) {
  console.error(`relay-admin: ${msg}`);
  process.exit(1);
}
function parseArgs(argv, multi = new Set()) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val = true;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (key.startsWith('no-')) { /* boolean flag */ }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[++i]; }
      if (multi.has(key)) (opts[key] ??= []).push(val);
      else opts[key] = val;
    } else positional.push(a);
  }
  return { opts, positional };
}
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return r.status ?? 1;
}
function newToken() {
  // 48 chars of [A-Za-z0-9] after the rt_ prefix so redact() recognizes it (§11.1)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(48);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `rt_${s}`;
}
function originSlug(root) {
  const url = git(['config', '--get', 'remote.origin.url'], root);
  if (!url) return null;
  let s = url.trim().replace(/\.git$/, '');
  s = s.replace(/^ssh:\/\/(?:[^@]+@)?/, '').replace(/^(?:git|https?):\/\/(?:[^@]+@)?/, '').replace(/^[^@]+@([^:]+):/, '$1/');
  return s.toLowerCase();
}
async function fetchJson(url, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    return { status: 0, body: String(err?.message ?? err), headers: new Headers() };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- init-project
function inferAreas(root) {
  const areas = {};
  const add = (name, paths, extra = {}) => { if (!areas[name]) areas[name] = { paths, ...extra }; };
  for (const parent of ['apps', 'packages', 'services', 'libs']) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    for (const child of readdirSync(dir)) {
      if (child.startsWith('.') || child === 'node_modules') continue;
      if (!statSync(join(dir, child)).isDirectory()) continue;
      if (/^(contracts|shared|types|schema|schemas|api-types|proto)$/i.test(child)) continue; // shared area below
      add(child, [`${parent}/${child}/**`]);
    }
  }
  const src = join(root, 'src');
  if (existsSync(src) && Object.keys(areas).length === 0) {
    for (const child of readdirSync(src)) {
      if (child.startsWith('.')) continue;
      if (statSync(join(src, child)).isDirectory()) add(child, [`src/${child}/**`]);
    }
  }
  const sharedPaths = [];
  for (const parent of ['packages', 'libs']) {
    for (const name of ['contracts', 'shared', 'types', 'schema', 'schemas', 'api-types', 'proto']) {
      if (existsSync(join(root, parent, name))) sharedPaths.push(`${parent}/${name}/**`);
    }
  }
  if (existsSync(join(root, 'prisma'))) sharedPaths.push('prisma/**');
  if (sharedPaths.length) add('contracts', sharedPaths, { shared: true });
  return areas;
}

function parseKv(list, sep = '=') {
  const out = {};
  for (const item of list ?? []) {
    const i = item.indexOf(sep);
    if (i <= 0) fail(`expected name${sep}value, got "${item}"`);
    out[item.slice(0, i)] = item.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

async function initProject(argv) {
  const { opts, positional } = parseArgs(argv, new Set(['area', 'owner', 'shared', 'depends']));
  const dir = resolve(positional[0] ?? process.cwd());
  const root = git(['rev-parse', '--show-toplevel'], dir) ?? dir;
  const local = Boolean(opts.local);
  const settingsPath = join(root, '.claude', local ? 'settings.local.json' : 'settings.json');
  const marketplace = typeof opts.marketplace === 'string' ? opts.marketplace : MARKETPLACE_DEFAULT;

  // ---- .claude/settings[.local].json (merge; never drop keys we do not own)
  const settings = readJson(settingsPath) ?? {};
  if (!opts['no-plugin']) {
    settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces ?? {}), relay: { source: { source: 'github', repo: marketplace }, autoUpdate: true } };
    settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), 'relay@relay': true };
  }
  settings.permissions = settings.permissions ?? {};
  const allow = new Set(Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []);
  for (const r of PERMISSION_RULES) allow.add(r);
  settings.permissions.allow = [...allow];
  let statusNote = '';
  if (!opts['no-statusline']) {
    const existing = settings.statusLine;
    const isRelay = existing && typeof existing.command === 'string' && existing.command.includes('statusline.sh');
    if (!existing || isRelay || opts.force) {
      settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND, refreshInterval: 10 };
    } else {
      statusNote = `kept the existing statusLine in ${basename(settingsPath)} (use --force to replace it; Relay chains a user-scope status line automatically, §4.11)`;
    }
  }
  writeJson(settingsPath, settings);

  // ---- .relay.json
  const relayPath = join(root, '.relay.json');
  let relayNote = '';
  if (existsSync(relayPath) && !opts.force) {
    relayNote = '.relay.json exists; left unchanged (use --force to regenerate)';
  } else {
    const slug = typeof opts.repo === 'string' ? opts.repo : originSlug(root);
    const project = typeof opts.project === 'string' ? opts.project : slug ? slug.split('/').slice(-2).join('/') : basename(root);
    const areaArgs = parseKv(opts.area);
    const areas = Object.keys(areaArgs).length ? Object.fromEntries(Object.entries(areaArgs).map(([k, v]) => [k, { paths: v }])) : inferAreas(root);
    for (const [area, owners] of Object.entries(parseKv(opts.owner))) {
      if (!areas[area]) fail(`--owner ${area}: no such area (areas: ${Object.keys(areas).join(', ') || 'none'})`);
      areas[area].owners = owners;
    }
    for (const name of opts.shared ?? []) {
      if (!areas[name]) fail(`--shared ${name}: no such area`);
      areas[name].shared = true;
    }
    const depends = parseKv(opts.depends);
    if (!Object.keys(depends).length && areas.contracts) {
      for (const a of Object.keys(areas)) if (a !== 'contracts' && !areas[a].shared) depends[a] = ['contracts'];
    }
    const config = { project, areas };
    if (slug) config.repo = slug;
    config.contracts = { export_scan: true };
    if (Object.keys(depends).length) config.depends = depends;
    config.impacts = { debounce_minutes: 3 };
    config.collision = { hot: 'ask', claimed: 'ask', warm: 'context', same_dev: 'note' };
    config.privacy = { send_prompts: false, send_turns: 'prose', send_diffs: 'contracts', objective_from_prompts: true };
    config.handoff = { llm: true, idle_minutes: 20 };
    writeJson(relayPath, config);
    relayNote = `wrote .relay.json (project ${project}, areas ${Object.keys(areas).join(', ') || 'none — add --area name=glob'})`;
  }

  console.log(`relay: ${root}`);
  console.log(`  ${local ? 'wrote' : 'wrote/merged'} ${settingsPath.replace(root + '/', '')}${opts['no-plugin'] ? ' (permissions/statusLine only)' : ` (marketplace ${marketplace}, plugin relay@relay, permissions, statusLine)`}`);
  console.log(`  ${relayNote}`);
  if (statusNote) console.log(`  ${statusNote}`);
  console.log('next:');
  if (local) {
    console.log('  .claude/settings.local.json is gitignored by Claude Code; commit .relay.json only:');
    console.log('    git add .relay.json && git commit -m "Add Relay area map"');
    console.log('  every developer runs this same init-project --local once per clone (client-owned repo rule, §3.1).');
  } else {
    console.log(`    git add ${basename(dirname(settingsPath))}/${basename(settingsPath)} .relay.json && git commit -m "Add Relay" && git push`);
  }
  console.log('  developers: git pull && claude, accept the trust dialog; if the status line shows no "relay", run /reload-plugins or restart claude once.');
}

// ---------------------------------------------------------------- init-team
function initTeam(argv) {
  const { opts } = parseArgs(argv, new Set(['member']));
  const out = typeof opts.out === 'string' ? resolve(opts.out) : join(PLUGIN_DIR, 'team.json');
  const existing = readJson(out) ?? {};
  const team = {
    hub: typeof opts.hub === 'string' ? opts.hub.replace(/\/+$/, '') : existing.hub,
    team: typeof opts.team === 'string' ? opts.team : existing.team ?? 'exampleteam',
    token: typeof opts.token === 'string' ? opts.token : existing.token,
    marketplace: typeof opts.marketplace === 'string' ? opts.marketplace : existing.marketplace ?? MARKETPLACE_DEFAULT,
    members: { ...(existing.members ?? {}) },
  };
  if (!team.hub) fail('--hub <url> is required');
  if (!team.token) fail('--token <rt_…> is required (relay-admin token new)');
  for (const m of opts.member ?? []) {
    // handle=email[,email][:github]
    const eq = m.indexOf('=');
    if (eq <= 0) fail(`--member expects handle=email[,email][:github], got "${m}"`);
    const handle = m.slice(0, eq).trim().toLowerCase();
    let rest = m.slice(eq + 1);
    let github;
    const colon = rest.lastIndexOf(':');
    if (colon > 0 && !rest.slice(colon + 1).includes('@')) { github = rest.slice(colon + 1).trim(); rest = rest.slice(0, colon); }
    const emails = rest.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(handle)) fail(`handle "${handle}" must be lowercase [a-z0-9_-]`);
    const prev = team.members[handle] ?? {};
    team.members[handle] = { name: prev.name ?? handle.charAt(0).toUpperCase() + handle.slice(1), emails: [...new Set([...(prev.emails ?? []), ...emails])], ...(github || prev.github ? { github: github ?? prev.github } : {}) };
  }
  writeJson(out, team);
  console.log(`wrote ${out}: hub ${team.hub}, team ${team.team}, marketplace ${team.marketplace}, members ${Object.keys(team.members).join(', ') || 'none'}`);
  console.log('next: git commit -am "relay: team config" && git push   (CI publishes packages/plugin -> relay-plugin; or: pnpm plugin:publish)');
}

// ---------------------------------------------------------------- token new / rotate
async function rotateToken(argv) {
  const { opts } = parseArgs(argv);
  const teamPath = typeof opts['team-json'] === 'string' ? resolve(opts['team-json']) : join(PLUGIN_DIR, 'team.json');
  const team = readJson(teamPath);
  if (!team) fail(`cannot read ${teamPath}`);
  const hub = typeof opts.hub === 'string' ? opts.hub.replace(/\/+$/, '') : process.env.RELAY_HUB ?? team.hub;
  const adminToken = typeof opts['admin-token'] === 'string' ? opts['admin-token'] : process.env.RELAY_ADMIN_TOKEN;
  const previous = team.token;
  const next = newToken();
  if (!opts['no-hub']) {
    if (!adminToken) fail('--admin-token <t> (or RELAY_ADMIN_TOKEN) is required to tell the hub; use --no-hub to only rewrite team.json');
    const r = await fetchJson(`${hub}/admin/token/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ current: next }),
    });
    if (r.status !== 200) fail(`hub rejected the rotation: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    console.log(`hub ${hub}: rotated at ${r.body.rotatedAt}; previous token accepted until ${r.body.graceUntil} (14-day grace, §3.3)`);
  }
  team.token = next;
  writeJson(teamPath, team);
  console.log(`wrote ${teamPath} with the new token`);
  console.log('persist it on the hosting side (the hub process keeps it only until redeploy):');
  console.log(`  vercel env rm RELAY_TEAM_TOKEN_PREV production -y; printf '%s' '${previous}' | vercel env add RELAY_TEAM_TOKEN_PREV production`);
  console.log(`  vercel env rm RELAY_TEAM_TOKEN production -y;      printf '%s' '${next}' | vercel env add RELAY_TEAM_TOKEN production`);
  console.log('  vercel deploy --prod');
  console.log('then publish the plugin so teammates pick the token up within the grace period:');
  console.log('  git commit -am "relay: rotate team token" && git push     (or: pnpm plugin:publish)');
  if (opts.publish) {
    const code = sh('/bin/sh', [join(ROOT, 'scripts', 'publish-plugin.sh')]);
    if (code !== 0) fail('publish-plugin.sh failed');
  }
}

// ---------------------------------------------------------------- doctor
async function doctor(argv) {
  const { opts } = parseArgs(argv);
  const home = process.env.RELAY_HOME ?? join(homedir(), '.relay');
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const team = readJson(join(PLUGIN_DIR, 'team.json'));
  const hub = typeof opts.hub === 'string' ? opts.hub : process.env.RELAY_HUB ?? team?.hub;
  const token = typeof opts.token === 'string' ? opts.token : process.env.RELAY_TOKEN ?? team?.token;
  const dev = typeof opts.dev === 'string' ? opts.dev : process.env.RELAY_DEV ?? 'doctor';
  let problems = 0;
  const bad = (s) => { problems++; console.log(`  ✗ ${s}`); };
  const ok = (s) => console.log(`  ✓ ${s}`);

  console.log('relay doctor');
  console.log(`  RELAY_HOME: ${home}`);
  const nodePath = existsSync(join(home, 'node-path')) ? readFileSync(join(home, 'node-path'), 'utf8').trim() : null;
  if (nodePath && existsSync(nodePath)) {
    let v = null;
    try { v = execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim(); } catch {}
    ok(`node resolved by hook.sh: ${nodePath} ${v ?? ''}`);
  } else {
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 18) ok(`no cached node-path yet; this node is ${process.version} (hook.sh resolves and caches on first run)`);
    else bad(`this node is ${process.version}; hooks need >= 18`);
  }
  for (const f of ['hook.mjs', 'mcp.mjs']) {
    const p = join(PLUGIN_DIR, 'dist', f);
    const size = existsSync(p) ? statSync(p).size : 0;
    if (size > 1000) ok(`packages/plugin/dist/${f}: ${size} bytes`); else bad(`packages/plugin/dist/${f} is ${size} bytes: run pnpm build`);
  }
  const cfgErr = readJson(join(home, 'config-error.json'));
  if (cfgErr) bad(`config-error.json: ${JSON.stringify(cfgErr)} (401/426: update the plugin — claude plugin marketplace update relay && claude plugin update relay@relay)`); else ok('no config-error.json');
  if (existsSync(join(home, 'down-until'))) {
    const until = readFileSync(join(home, 'down-until'), 'utf8').trim();
    if (new Date(until).getTime() > Date.now()) bad(`breaker open until ${until}`); else ok(`breaker closed (expired ${until})`);
  } else ok('breaker closed');
  if (existsSync(join(home, 'last-error'))) {
    const lines = readFileSync(join(home, 'last-error'), 'utf8').trim().split('\n');
    bad(`last-error (${lines.length} lines): ${lines.at(-1)}`);
  }
  const identity = readJson(join(home, 'identity.json'));
  if (identity) ok(`identity.json: ${identity.dev} (${identity.source})`); else ok('identity from RELAY_DEV / git email (no identity.json)');
  const known = readJson(join(claudeDir, 'plugins', 'known_marketplaces.json')) ?? {};
  if (known.relay) ok(`marketplace 'relay' registered (${JSON.stringify(known.relay.source)})`); else bad("marketplace 'relay' not registered on this machine (happens at the first trusted session of a repo with .claude/settings.json from init-project)");
  const installed = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'));
  const entry = installed?.plugins?.['relay@relay'];
  const entries = Array.isArray(entry) ? entry : entry ? [entry] : [];
  if (entries.length) {
    for (const e of entries) ok(`plugin relay@relay installed: scope ${e.scope ?? '?'} version ${e.version ?? '?'} commit ${e.gitCommitSha ?? '?'}`);
    const clone = join(claudeDir, 'plugins', 'marketplaces', 'relay');
    const local = git(['rev-parse', 'HEAD'], clone);
    const remote = git(['ls-remote', 'origin', 'HEAD'], clone)?.split(/\s+/)[0] ?? null;
    if (local && remote) { if (local === remote) ok(`marketplace clone up to date (${local.slice(0, 7)})`); else bad(`plugin behind: clone ${local.slice(0, 7)}, remote ${remote.slice(0, 7)} — claude plugin marketplace update relay && claude plugin update relay@relay`); }
  } else bad('plugin relay@relay not installed on this machine');
  const stats = join(home, 'log', 'stats.jsonl');
  if (existsSync(stats)) {
    const counts = {};
    for (const line of readFileSync(stats, 'utf8').trim().split('\n').slice(-500)) {
      const m = /"verb":"([a-z-]+)"/.exec(line);
      if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    ok(`hook counters (last 500): ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  } else ok('no log/stats.jsonl yet (no hook has run under this RELAY_HOME)');
  if (hub) {
    const h = await fetchJson(`${hub}/health`);
    if (h.status === 200 && h.body?.db) ok(`hub ${hub}: up (version ${h.body.version}, db ${h.body.db})`); else bad(`hub ${hub}: ${h.status || 'unreachable'} ${JSON.stringify(h.body).slice(0, 120)}`);
    if (token && h.status === 200) {
      const s = await fetchJson(`${hub}/v1/query/status?project=current`, { headers: { authorization: `Bearer ${token}`, 'x-relay-dev': dev, 'x-relay-client': 'cli', 'x-relay-proto': '1' } });
      if (s.status === 200) ok(`team token accepted${s.headers.get('x-relay-warn') ? ` (warn: ${s.headers.get('x-relay-warn')})` : ''}`);
      else if (s.status === 404) ok('team token accepted (no session for this dev yet)');
      else bad(`token check: ${s.status} ${JSON.stringify(s.body).slice(0, 120)}`);
    }
  } else bad('no hub URL (team.json missing hub; pass --hub)');
  console.log(problems ? `${problems} problem(s)` : 'Relay looks healthy');
  process.exit(problems ? 2 : 0);
}

// ---------------------------------------------------------------- validate
function validate() {
  let problems = 0;
  const bad = (s) => { problems++; console.log(`  ✗ ${s}`); };
  const ok = (s) => console.log(`  ✓ ${s}`);
  console.log('relay validate (packages/plugin)');
  const manifest = readJson(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'));
  if (!manifest) bad('plugin.json unreadable'); else {
    if (manifest.name !== 'relay') bad(`plugin.json name is "${manifest.name}", expected "relay"`);
    if ('version' in manifest) bad('plugin.json must not carry a version (commit-SHA versioning, §2.3)'); else ok('plugin.json has no version field');
  }
  const hooks = readJson(join(PLUGIN_DIR, 'hooks', 'hooks.json'));
  if (!hooks?.hooks) bad('hooks/hooks.json unreadable'); else {
    let n = 0;
    for (const [event, groups] of Object.entries(hooks.hooks)) {
      for (const g of groups) for (const h of g.hooks ?? []) {
        n++;
        if (h.command !== '/bin/sh' || !Array.isArray(h.args)) bad(`${event}: hook must be exec form /bin/sh + args`);
        if (!String(h.args?.[0] ?? '').startsWith('${CLAUDE_PLUGIN_ROOT}/scripts/')) bad(`${event}: first arg must start with \${CLAUDE_PLUGIN_ROOT}/scripts/`);
        const script = String(h.args?.[0] ?? '').replace('${CLAUDE_PLUGIN_ROOT}/', '');
        if (!existsSync(join(PLUGIN_DIR, script))) bad(`${event}: ${script} does not exist`);
        if (h.async && h.timeout !== undefined) bad(`${event}: async hooks carry no timeout`);
        if (!h.async && event !== 'SessionEnd' && typeof h.timeout !== 'number') bad(`${event}: sync hook needs a timeout`);
      }
    }
    ok(`hooks.json: ${n} handlers, exec form, scripts present`);
  }
  const mcp = readJson(join(PLUGIN_DIR, '.mcp.json'));
  if (mcp?.mcpServers?.relay?.command === '/bin/sh' && mcp.mcpServers.relay.args?.[0] === '${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh') ok('.mcp.json: stdio server relay -> scripts/mcp.sh'); else bad('.mcp.json: expected stdio server "relay" running /bin/sh ${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh');
  const team = readJson(join(PLUGIN_DIR, 'team.json'));
  if (team?.hub && team?.token && team?.members) ok(`team.json: hub ${team.hub}, ${Object.keys(team.members).length} members`); else bad('team.json: missing hub/token/members');
  for (const f of readdirSync(join(PLUGIN_DIR, 'scripts'))) {
    if (!f.endsWith('.sh')) continue;
    const p = join(PLUGIN_DIR, 'scripts', f);
    const mode = statSync(p).mode & 0o111;
    if (!mode) bad(`scripts/${f} is not executable`);
    const r = spawnSync('/bin/sh', ['-n', p], { stdio: 'ignore' });
    if (r.status !== 0) bad(`scripts/${f}: sh -n failed`); else ok(`scripts/${f}: POSIX syntax ok${mode ? '' : ' (not executable)'}`);
  }
  for (const s of ['status', 'handoff', 'doctor', 'iam', 'mute']) {
    const p = join(PLUGIN_DIR, 'skills', s, 'SKILL.md');
    const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (/^---\nname: /.test(text) && /\ndescription: /.test(text)) ok(`skills/${s}/SKILL.md`); else bad(`skills/${s}/SKILL.md missing or without name/description frontmatter`);
  }
  for (const f of ['hook.mjs', 'mcp.mjs']) {
    const p = join(PLUGIN_DIR, 'dist', f);
    const size = existsSync(p) ? statSync(p).size : 0;
    if (size > 1000) ok(`dist/${f}: ${size} bytes`); else bad(`dist/${f}: ${size} bytes (run pnpm build)`);
  }
  const r = spawnSync('claude', ['plugin', 'validate', PLUGIN_DIR], { encoding: 'utf8' });
  if (r.error) console.log('  - claude CLI not found; skipped `claude plugin validate`');
  else if (r.status === 0) ok('claude plugin validate passed (the only warning is the intentional missing version)');
  else bad(`claude plugin validate failed:\n${(r.stdout + r.stderr).trim()}`);
  console.log(problems ? `${problems} problem(s)` : 'plugin is valid');
  process.exit(problems ? 2 : 0);
}

// ---------------------------------------------------------------- main
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'init-project': await initProject(rest); break;
  case 'init-team': initTeam(rest); break;
  case 'team':
    if (rest[0] === 'set') initTeam(rest.slice(1)); else usage(1);
    break;
  case 'token':
    if (rest[0] === 'new') console.log(newToken());
    else if (rest[0] === 'rotate') await rotateToken(rest.slice(1));
    else usage(1);
    break;
  case 'rotate-token': await rotateToken(rest); break;
  case 'publish': process.exit(sh('/bin/sh', [join(ROOT, 'scripts', 'publish-plugin.sh'), ...rest]));
  case 'plugin':
    if (rest[0] === 'publish') process.exit(sh('/bin/sh', [join(ROOT, 'scripts', 'publish-plugin.sh'), ...rest.slice(1)]));
    usage(1);
    break;
  case 'demo': process.exit(sh('/bin/sh', [join(ROOT, 'scripts', 'demo.sh'), ...rest]));
  case 'doctor': await doctor(rest); break;
  case 'validate': validate(); break;
  case undefined: case '-h': case '--help': case 'help': usage(0); break;
  default: fail(`unknown command "${cmd}" (try --help)`);
}
