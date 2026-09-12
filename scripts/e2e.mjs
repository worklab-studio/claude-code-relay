#!/usr/bin/env node
/**
 * `pnpm test:e2e` — the §12 M0 six moments without the claude CLI: a throwaway
 * hub on PGlite, two clones of examples/demo-repo (priya: app, arjun: dashboard),
 * two RELAY_HOMEs, and the real bundles (dist/hook.mjs replayed with Claude Code
 * stdin payloads, dist/mcp.mjs driven over stdio). Every hook run must exit 0
 * with an empty stderr (§4.0 rules 1–3); the moments are asserted through the
 * hub's own API and the hook outputs.
 *
 *   node scripts/e2e.mjs            (RELAY_HUB=<url> reuses a running hub; KEEP=1 keeps the temp dir)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Checker,
  HOOK,
  MCP,
  authorEnv,
  copyDemoRepo,
  git,
  hookEnv,
  hso,
  hub,
  initRepo,
  listOutbox,
  makeOrigin,
  mcpClient,
  readJson,
  rmrf,
  runHook,
  stdin,
  startHub,
  tmpRoot,
  waitFor,
} from './lib/relay-test.mjs';
import { existsSync } from 'node:fs';

const REPO = 'demo/app';
const ORDERS = 'packages/contracts/src/orders.ts';
const c = new Checker('e2e');

for (const b of [HOOK, MCP]) {
  if (!existsSync(b)) {
    console.error(`missing ${b}: run pnpm build first`);
    process.exit(1);
  }
}

const root = tmpRoot('relay-e2e-');
console.log(`e2e: temp dir ${root}`);
let hubHandle = null;
let mcp = null;
let ok = false;
try {
  hubHandle = await startHub({ dataDir: join(root, 'hub-data') });
  const HUB = hubHandle.url;
  console.log(`e2e: hub ${HUB}${hubHandle.external ? ' (external)' : ''}`);

  // ------------------------------------------------------------ rig: origin + two clones + two homes
  const seed = initRepo(copyDemoRepo(join(root, 'seed')), { name: 'Demo Seed', email: 'seed@demo', message: 'acme-portal demo seed' });
  const { clones } = makeOrigin(root, seed, [
    { handle: 'priya', name: 'Priya', email: 'priya@demo' },
    { handle: 'arjun', name: 'Arjun', email: 'arjun@demo' },
  ]);
  const devs = {};
  for (const handle of ['priya', 'arjun']) {
    const home = join(root, `home-${handle}`);
    mkdirSync(home, { recursive: true });
    const sessionId = randomUUID();
    devs[handle] = {
      handle,
      home,
      cwd: clones[handle],
      sessionId,
      env: hookEnv({ home, hubUrl: HUB, dev: handle, sessionId }),
      base: () => ({ session_id: devs[handle].sessionId, cwd: devs[handle].cwd, transcript_path: join(home, 'transcript.jsonl') }),
    };
  }
  const priya = devs.priya;
  const arjun = devs.arjun;

  /** Run a hook verb for a dev; asserts the §4.0 invariants; returns the run. */
  async function verb(dev, name, input, { extraEnv = {}, maxMs = null } = {}) {
    const r = await runHook([name], input, { ...dev.env, ...extraEnv }, { cwd: dev.cwd });
    const label = `${dev.handle} ${name}`;
    c.check(`${label}: exit 0`, r.code === 0, `code ${r.code}`);
    c.check(`${label}: stderr empty`, r.stderr === '', r.stderr.slice(0, 300));
    if (r.stdout.trim()) c.check(`${label}: stdout is one JSON object`, r.json !== null, r.stdout.slice(0, 200));
    if (maxMs !== null) c.check(`${label}: ${r.ms} ms < ${maxMs} ms`, r.ms < maxMs);
    return r;
  }
  async function bg(dev, job, extra = []) {
    const r = await runHook(['bg', job, '--session', dev.sessionId, '--cwd', dev.cwd, ...extra], null, { ...dev.env, RELAY_BG: '1' }, { cwd: dev.cwd });
    c.check(`${dev.handle} bg ${job}: exit 0, silent`, r.code === 0 && r.stdout === '' && r.stderr === '', `code ${r.code} ${r.stderr.slice(0, 200)}`);
    return r;
  }
  const query = (dev, path, q = {}) => hub(HUB, { dev: dev.handle, session: dev.sessionId, path, query: { repo: REPO, ...q } });
  const digestOf = (r) => String(hso(r)?.additionalContext ?? '');

  // ------------------------------------------------------------ moment 1: PRESENCE
  console.log('\n== moment 1: presence');
  const ps = await verb(priya, 'session-start', stdin.sessionStart(priya.base()), { maxMs: 3500 + 400 });
  const pDigest = digestOf(ps);
  c.must('priya session-start: SessionStart digest', hso(ps)?.hookEventName === 'SessionStart' && /^<relay-digest /.test(pDigest), pDigest.slice(0, 120));
  c.check('priya digest is live and <= 6,000 chars', /freshness="live"/.test(pDigest) && pDigest.length <= 6000, `${pDigest.length} chars`);
  c.check('priya digest names the repo and dev', pDigest.includes(`repo="${REPO}"`) && pDigest.includes('dev="priya"'));
  c.check('no sessionTitle before an objective exists (§4.1: title = area: objective)', hso(ps)?.sessionTitle === undefined, JSON.stringify(hso(ps)?.sessionTitle));
  await bg(priya, 'session-start');

  const as = await verb(arjun, 'session-start', stdin.sessionStart(arjun.base()), { maxMs: 3500 + 400 });
  const aDigest = digestOf(as);
  c.must('arjun session-start: SessionStart digest', hso(as)?.hookEventName === 'SessionStart' && /^<relay-digest /.test(aDigest), aDigest.slice(0, 120));
  c.check('arjun digest lists priya under Team now', /## Team now[\s\S]*?- priya /.test(aDigest), aDigest.slice(0, 600));
  await bg(arjun, 'session-start');

  const st = await query(arjun, '/v1/query/status');
  c.must('hub status 200', st.status === 200, JSON.stringify(st.body).slice(0, 200));
  const devsOnHub = st.body.projects?.[0]?.devs ?? [];
  const live = (h) => (devsOnHub.find((d) => d.dev === h)?.sessions ?? []).filter((s) => s.state !== 'gone');
  c.check('hub: priya and arjun are both live', live('priya').length === 1 && live('arjun').length === 1, JSON.stringify(devsOnHub.map((d) => [d.dev, d.sessions.map((s) => s.state)])));
  const statusline = readJson(join(arjun.home, 'sessions', arjun.sessionId, 'meta.json'))?.repoKey;
  const slPath = statusline ? join(arjun.home, 'cache', statusline, 'statusline.txt') : null;
  const sl = slPath && existsSync(slPath) ? readFileSync(slPath, 'utf8') : '';
  c.check('arjun status line shows priya', /relay/.test(sl) && /priya/.test(sl), sl.trim());
  c.check('current/<pid>.json written for arjun', existsSync(join(arjun.home, 'current', `${process.pid}.json`)));

  // ------------------------------------------------------------ priya works: prompt, edit, commit, stop
  console.log('\n== priya: prompt, edit, commit');
  const pp = await verb(priya, 'prompt', stdin.prompt(priya.base(), 'Add an optional `status: OrderStatus` field to OrderFilter in packages/contracts/src/orders.ts and use it in apps/app/src/api/orders.ts. Commit.'), { maxMs: 2400 });
  c.check('priya prompt: nothing to say yet', pp.stdout === '' || !/IMPACT|NOTE/.test(pp.stdout), pp.stdout.slice(0, 200));
  const promptEntry = listOutbox(priya.home).find((e) => e.kind === 'events');
  c.check('priya prompt wrote a WAL entry for the worker', Boolean(promptEntry));
  await bg(priya, 'prompt', promptEntry ? ['--entry', promptEntry.id] : []);
  const st2 = await query(priya, '/v1/query/status');
  const pSess = (st2.body.projects?.[0]?.devs ?? []).find((d) => d.dev === 'priya')?.sessions?.[0];
  c.check('hub: priya objective derived from the prompt', typeof pSess?.objective === 'string' && /status/i.test(pSess.objective), JSON.stringify(pSess?.objective));

  const pe0 = await verb(priya, 'pre-edit', stdin.preEdit(priya.base(), join(priya.cwd, ORDERS)), { maxMs: 900 + 400 });
  c.check('priya pre-edit on orders.ts: no collision (nobody else touched it)', !hso(pe0)?.permissionDecision, pe0.stdout.slice(0, 200));

  const ordersPath = join(priya.cwd, ORDERS);
  const before = readFileSync(ordersPath, 'utf8');
  c.must('demo-repo orders.ts has OrderFilter', before.includes('export interface OrderFilter {'));
  writeFileSync(ordersPath, before.replace('  minTotal?: number;\n}', '  minTotal?: number;\n  status?: OrderStatus;\n}'));
  const apiPath = join(priya.cwd, 'apps/app/src/api/orders.ts');
  writeFileSync(apiPath, readFileSync(apiPath, 'utf8') + '\n// status filter wired through OrderFilter.status\n');
  const po = await verb(priya, 'post-edit', stdin.postEdit(priya.base(), ordersPath), { maxMs: 6400 });
  c.check('priya post-edit silent (no inbox yet)', po.stdout === '' || !/IMPACT/.test(po.stdout));
  const rc = await query(arjun, '/v1/query/recent_changes', { kind: 'contracts' });
  const contractItem = (rc.body.items ?? []).find((i) => i.kind === 'contract' && i.path === ORDERS);
  c.check('hub: uncommitted contract record for orders.ts with OrderFilter', Boolean(contractItem) && contractItem.status === 'uncommitted' && contractItem.symbols.includes('OrderFilter'), JSON.stringify(contractItem)?.slice(0, 300));
  const csIdEarly = contractItem?.changeSetId ?? null;

  git(priya.cwd, ['add', '-A']);
  git(priya.cwd, ['commit', '-q', '-m', 'contracts: add optional OrderFilter.status'], authorEnv('Priya', 'priya@demo'));
  const sha = git(priya.cwd, ['rev-parse', 'HEAD']);
  const pg = await verb(priya, 'post-git', stdin.postGit(priya.base(), 'git add -A && git commit -m "contracts: add optional OrderFilter.status"', `[main ${sha.slice(0, 7)}] contracts: add optional OrderFilter.status`), { maxMs: 6400 });
  c.check('priya post-git silent', pg.stdout === '' || !/IMPACT/.test(pg.stdout));

  // ------------------------------------------------------------ moment 2: IMPACT (hub side)
  console.log('\n== moment 2: impact routing');
  const snapA = await waitFor(async () => {
    const s = await query(arjun, '/v1/snapshot');
    return s.status === 200 && (s.body.changeSets ?? []).some((cs) => cs.impacts.some((i) => i.path === ORDERS && i.status === 'committed')) ? s.body : null;
  });
  c.must('hub: committed change set for orders.ts targets arjun', Boolean(snapA), 'no committed change set in arjun snapshot');
  const cs = snapA.changeSets.find((x) => x.impacts.some((i) => i.path === ORDERS));
  c.check('change set by priya, committed, carries the commit sha', cs.by === 'priya' && cs.status === 'committed' && cs.impacts.some((i) => i.commitSha === sha), JSON.stringify({ by: cs.by, status: cs.status, shas: cs.impacts.map((i) => i.commitSha) }));
  c.check('change set symbols include OrderFilter', cs.impacts.some((i) => i.symbols.includes('OrderFilter')), JSON.stringify(cs.impacts.map((i) => i.symbols)));
  const depPaths = cs.dependents.map((d) => d.path);
  c.check("arjun's dashboard is a dependent (import-derived)", cs.dependents.some((d) => d.path.startsWith('apps/dashboard/') && d.via === 'import'), JSON.stringify(depPaths));
  c.check('change set priority is high for arjun (owner + live area + import dependent)', cs.priority === 'high', `priority ${cs.priority}`);
  if (csIdEarly) c.check('the commit joined the uncommitted record into one change set', cs.id === csIdEarly, `${csIdEarly} vs ${cs.id}`);
  c.check('priya heat on orders.ts visible to arjun', (snapA.heat ?? []).some((h) => h.path === ORDERS && h.dev === 'priya'), JSON.stringify(snapA.heat?.map((h) => [h.dev, h.path, h.kind])));

  const stop = await verb(priya, 'stop', stdin.stop(priya.base(), 'I added an optional `status: OrderStatus` field to `OrderFilter` and used it in apps/app/src/api/orders.ts. Committed as ' + sha.slice(0, 7) + '.\n\nWe decided to keep the field optional so existing callers keep working.\n\n## Next\n- Update the dashboard filter UI to send status\n- Add an index on orders.status\n'), { maxMs: 5400 });
  c.check('priya stop: no stdout', stop.stdout === '');
  c.check('priya stop wrote a heuristic draft with next steps', (readJson(join(priya.home, 'sessions', priya.sessionId, 'draft.json'))?.next ?? []).length >= 1);

  // ------------------------------------------------------------ moment 2 (client side): arjun's prompt delivers the change set once
  console.log('\n== moment 2: inbox at arjun prompt (exactly once)');
  const ap1 = await verb(arjun, 'prompt', stdin.prompt(arjun.base(), 'Add a status column to apps/dashboard/src/OrdersTable.tsx — first check whether any contract I depend on changed.'), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' }, maxMs: 2400 });
  const inbox1 = digestOf(ap1);
  c.check('arjun prompt: <relay-inbox> with the IMPACT line', /^<relay-inbox /.test(inbox1) && inbox1.includes(`IMPACT ${cs.id}`), inbox1.slice(0, 300) || '(no stdout)');
  c.check('inbox names OrderFilter and the committed sha', inbox1.includes('OrderFilter') && inbox1.includes(sha.slice(0, 7)), inbox1.slice(0, 400));
  c.check('inbox names a dashboard dependent', /apps\/dashboard\//.test(inbox1), inbox1.slice(0, 400));
  c.check('arjun prompt systemMessage for the user', typeof ap1.json?.systemMessage === 'string' && /Relay: 1 impact/.test(ap1.json.systemMessage), JSON.stringify(ap1.json?.systemMessage));
  const aEntry = listOutbox(arjun.home).filter((e) => e.kind === 'events').pop();
  c.check('arjun prompt WAL entry carries delivered[] for the hub', Boolean(aEntry) && Array.isArray(aEntry.body.delivered) && aEntry.body.delivered.includes(cs.id), JSON.stringify(aEntry?.body?.delivered));
  await bg(arjun, 'prompt', aEntry ? ['--entry', aEntry.id] : []);
  const ap2 = await verb(arjun, 'prompt', stdin.prompt(arjun.base(), 'Thanks. Now read the OrdersTable component.'), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' }, maxMs: 2400 });
  c.check('second arjun prompt does not repeat the IMPACT (once per session)', !ap2.stdout.includes(`IMPACT ${cs.id}`), ap2.stdout.slice(0, 200));
  const pr = await verb(arjun, 'pre-read', stdin.preRead(arjun.base(), join(arjun.cwd, 'apps/dashboard/src/hooks/useOrders.ts')), { maxMs: 1000 });
  c.check('pre-read of a dependent is silent after the prompt delivered the change set', pr.stdout === '', pr.stdout.slice(0, 200));

  // ------------------------------------------------------------ moment 3: COLLISION
  console.log('\n== moment 3: collision ask');
  const ape = await verb(arjun, 'pre-edit', stdin.preEdit(arjun.base(), join(arjun.cwd, ORDERS), { permission_mode: 'default' }), { maxMs: 900 + 400 });
  const h3 = hso(ape);
  c.check('arjun pre-edit on orders.ts: permissionDecision ask', h3?.hookEventName === 'PreToolUse' && h3?.permissionDecision === 'ask', JSON.stringify(h3).slice(0, 300));
  c.check('ask reason is factual: "Relay: priya is editing packages/contracts/src/orders.ts …"', typeof h3?.permissionDecisionReason === 'string' && /^Relay: priya is editing packages\/contracts\/src\/orders\.ts/.test(h3.permissionDecisionReason), h3?.permissionDecisionReason);
  c.check('ask reason carries an absolute HH:MM:SSZ time', /\d\d:\d\d:\d\dZ/.test(String(h3?.permissionDecisionReason)), h3?.permissionDecisionReason);
  const ape2 = await verb(arjun, 'pre-edit', stdin.preEdit(arjun.base(), join(arjun.cwd, ORDERS)), { maxMs: 900 + 400 });
  c.check('a second pre-edit on the same file is context only (asked mark)', !hso(ape2)?.permissionDecision, JSON.stringify(hso(ape2)).slice(0, 200));
  const apw = await verb(arjun, 'pre-edit', stdin.preEdit(arjun.base(), join(arjun.cwd, 'apps/dashboard/src/OrdersTable.tsx'), { tool_name: 'Write', tool_input: { file_path: join(arjun.cwd, 'apps/dashboard/src/OrdersTable.tsx'), content: 'x' } }), { maxMs: 900 + 400 });
  c.check('editing his own dashboard file asks nothing of arjun', !hso(apw)?.permissionDecision, JSON.stringify(hso(apw)).slice(0, 200));

  // ------------------------------------------------------------ moment 4: NOTIFY through the MCP bundle over stdio
  console.log('\n== moment 4: notify via dist/mcp.mjs over stdio');
  mcp = mcpClient({ env: { RELAY_HOME: arjun.home, RELAY_HUB: HUB, RELAY_TOKEN: 'demo', RELAY_DEV: 'arjun', RELAY_DEBUG: '1' }, cwd: arjun.cwd });
  const init = await mcp.initialize();
  c.check('mcp initialize: server named relay', init?.serverInfo?.name === 'relay', JSON.stringify(init?.serverInfo));
  const tools = await mcp.listTools();
  const names = (tools.tools ?? []).map((t) => t.name);
  c.check('mcp lists the 13 §9.2 tools', names.length === 13 && ['status', 'who_is_on', 'notify', 'handoffs', 'whoami', 'impacts', 'impact_of', 'decide', 'handoff', 'claim', 'release', 'recent_changes', 'decisions'].every((n) => names.includes(n)), names.join(','));
  const who = await mcp.call('whoami', {});
  c.check('mcp whoami resolves arjun and the live session from current/<ppid>.json', !who.isError && who.json?.dev === 'arjun' && who.json?.sessionId === arjun.sessionId && who.json?.sessionSource === 'current-file', who.text.slice(0, 300));
  const status = await mcp.call('status', {});
  c.check('mcp status (live) lists priya', !status.isError && /live/.test(status.text) && /priya/.test(status.text), status.text.slice(0, 300));
  const wio = await mcp.call('who_is_on', { target: ORDERS });
  c.check('mcp who_is_on orders.ts names priya as a recent editor', !wio.isError && /priya/.test(wio.text), wio.text.slice(0, 300));
  const note = await mcp.call('notify', { dev: 'priya', message: 'keep `status`; the dashboard already consumes it', kind: 'fyi' });
  c.check('mcp notify priya accepted (one notification id)', !note.isError && Array.isArray(note.json?.ids) && note.json.ids.length === 1, note.text.slice(0, 300));
  c.check('notify says how it will reach priya', /next prompt|next-prompt|priya/.test(note.text), note.text.slice(0, 200));
  const h0 = await mcp.call('handoffs', { dev: 'priya' });
  c.check('mcp handoffs before priya exits: no items, not an error', !h0.isError && Array.isArray(h0.json?.items) && h0.json.items.length === 0, h0.text.slice(0, 200));

  const pn = await verb(priya, 'prompt', stdin.prompt(priya.base(), 'Any messages from arjun?'), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' }, maxMs: 2400 });
  const pInbox = digestOf(pn);
  c.check("priya's next prompt delivers the NOTE from arjun", /^<relay-inbox /.test(pInbox) && /NOTE from arjun/.test(pInbox) && pInbox.includes('keep `status`'), pInbox.slice(0, 300) || '(no stdout)');
  c.check('priya prompt systemMessage counts the note', /Relay: 1 note/.test(String(pn.json?.systemMessage)), JSON.stringify(pn.json?.systemMessage));
  const pEntry2 = listOutbox(priya.home).filter((e) => e.kind === 'events').pop();
  await bg(priya, 'prompt', pEntry2 ? ['--entry', pEntry2.id] : []);
  const pn2 = await verb(priya, 'prompt', stdin.prompt(priya.base(), 'Ok, keep status as is.'), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' }, maxMs: 2400 });
  c.check('the note is not delivered twice', !/NOTE from arjun/.test(pn2.stdout), pn2.stdout.slice(0, 200));

  // ------------------------------------------------------------ moment 5: HANDOFF at priya's session end
  console.log('\n== moment 5: handoff at session end');
  const se = await verb(priya, 'session-end', stdin.sessionEnd(priya.base(), 'prompt_input_exit'), { maxMs: 600 + 400 });
  c.check('priya session-end: silent', se.stdout === '');
  const endEntry = listOutbox(priya.home).find((e) => e.kind === 'session_end');
  c.must('session-end wrote the session_end WAL entry (no fetch inside the 1.5 s budget)', Boolean(endEntry));
  c.check('session_end body carries the edited file and the commit', (endEntry.body.files ?? []).some((f) => f.path === ORDERS) && (endEntry.body.commits ?? []).some((k) => k.sha === sha), JSON.stringify({ files: endEntry.body.files, commits: endEntry.body.commits?.map((k) => k.sha) }).slice(0, 300));
  await bg(priya, 'session-end', ['--entry', endEntry.id]);
  c.check('worker deleted the session_end entry after 2xx', !listOutbox(priya.home).some((e) => e.kind === 'session_end'));
  const handoffs = await waitFor(async () => {
    const r = await query(arjun, '/v1/query/handoffs', { dev: 'priya', n: 3 });
    return r.status === 200 && (r.body.items ?? []).length > 0 ? r.body.items : null;
  });
  c.must('hub: a handoff exists for priya', Boolean(handoffs), 'no handoff within 10 s');
  const ho = handoffs[0];
  c.check('handoff is the heuristic tier (no ANTHROPIC_API_KEY in the hub)', ho.quality === 'heuristic', ho.quality);
  c.check('handoff ended by prompt_input_exit, branch main', ho.endReason === 'prompt_input_exit' && ho.branch === 'main', JSON.stringify([ho.endReason, ho.branch]));
  c.check('handoff lists the contract change and the commit', ho.changed.some((f) => f.path === ORDERS) && ho.commits.some((k) => k.sha === sha), JSON.stringify({ changed: ho.changed.map((f) => f.path), commits: ho.commits.map((k) => k.sha.slice(0, 7)) }));
  c.check('handoff carries next steps from the Stop draft', ho.next.some((n) => /dashboard filter UI/i.test(n)), JSON.stringify(ho.next));
  c.check('handoff markdown rendered', typeof ho.markdown === 'string' && ho.markdown.includes('priya'));
  const stEnd = await query(arjun, '/v1/query/status');
  const pAfter = ((stEnd.body.projects?.[0]?.devs ?? []).find((d) => d.dev === 'priya')?.sessions ?? []).filter((s) => s.state !== 'gone');
  c.check('hub: priya is gone after session end', pAfter.length === 0, JSON.stringify(pAfter.map((s) => s.state)));

  const h1 = await mcp.call('handoffs', { dev: 'priya' });
  c.check("mcp handoffs shows priya's handoff to arjun", !h1.isError && (h1.json?.items ?? []).length === 1 && /priya/.test(h1.text), h1.text.slice(0, 300));
  await mcp.close();
  mcp = null;

  // ------------------------------------------------------------ moment 6: DIGEST at arjun's next session start
  console.log('\n== moment 6: digest at the next session start');
  const ase = await verb(arjun, 'session-end', stdin.sessionEnd(arjun.base(), 'prompt_input_exit'), { maxMs: 1000 });
  c.check('arjun session-end silent', ase.stdout === '');
  const aEnd = listOutbox(arjun.home).find((e) => e.kind === 'session_end');
  if (aEnd) await bg(arjun, 'session-end', ['--entry', aEnd.id]);
  arjun.sessionId = randomUUID();
  arjun.env = hookEnv({ home: arjun.home, hubUrl: HUB, dev: 'arjun', sessionId: arjun.sessionId });
  const as2 = await verb(arjun, 'session-start', stdin.sessionStart(arjun.base()), { maxMs: 3500 + 400 });
  const d6 = digestOf(as2);
  c.must('arjun relaunch: SessionStart digest', /^<relay-digest /.test(d6), d6.slice(0, 120));
  c.check('digest <= 6,000 chars, mode full, live', d6.length <= 6000 && /mode="full"/.test(d6) && /freshness="live"/.test(d6), `${d6.length} chars`);
  c.check('digest lists the committed change set under "Contract changes affecting you"', /## Contract changes affecting you/.test(d6) && d6.includes(cs.id) && /committed/.test(d6), d6.slice(0, 1200));
  c.check("digest lists priya's handoff under \"Handoffs since your last session\"", /## Handoffs since your last session/.test(d6) && new RegExp(`- priya[\\s\\S]*${ho.id}`).test(d6), d6.slice(0, 2500));
  c.check('digest change-set line names a dashboard dependent', /Your dependents: [^\n]*apps\/dashboard\//.test(d6), d6.match(/Your dependents:[^\n]*/)?.[0] ?? '(none)');
  c.check('digest carries absolute timestamps (HH:MM:SSZ) and no relative ages', /\d\d:\d\d(:\d\d)?Z/.test(d6) && !/\b\d+ ?(m|min|s) ago\b/.test(d6));
  c.check('digest ends with the Relay tools line', /## Relay\nTools \(mcp relay\): status, who_is_on/.test(d6) && d6.trimEnd().endsWith('</relay-digest>'));
  const cached = join(arjun.home, 'cache', readJson(join(arjun.home, 'sessions', arjun.sessionId, 'meta.json'))?.repoKey ?? '_', 'digest.md');
  c.check('digest cached locally for the offline fallback', existsSync(cached));

  // compact re-injection is local and fast
  const cp = await verb(arjun, 'session-start', stdin.sessionStart(arjun.base(), 'compact'), { maxMs: 800 + 400 });
  const dc = digestOf(cp);
  c.check('compact re-injection <= 1,500 chars, no network', /^<relay-digest mode="compact"/.test(dc) && dc.length <= 1500, `${dc.length} chars: ${dc.slice(0, 120)}`);

  // hook stats: every run recorded, none as error
  const stats = readFileSync(join(arjun.home, 'log/stats.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  c.check('stats.jsonl: no hook recorded an error', stats.every((s) => s.out !== 'error'), JSON.stringify(stats.filter((s) => s.out === 'error')).slice(0, 300));

  ok = c.summary();
} catch (err) {
  console.error(`\ne2e aborted: ${err && err.stack ? err.stack : err}`);
  c.summary();
  ok = false;
} finally {
  if (mcp) await mcp.close().catch(() => undefined);
  if (hubHandle) await hubHandle.stop();
  if (process.env.KEEP === '1') console.log(`e2e: kept ${root}`);
  else rmrf(root);
}
process.exit(ok ? 0 : 1);
