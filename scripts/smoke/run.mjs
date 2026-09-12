#!/usr/bin/env node
/**
 * `pnpm test:hooks` (DESIGN.md §12 M0): replay the stdin fixtures in this directory
 * through the real bundle (packages/plugin/dist/hook.mjs) against a throwaway hub
 * on PGlite, and assert:
 *   - §4.0 rules 1–3 on every run: exit 0, empty stderr, stdout empty or one JSON
 *     object of the documented shape, wall time under the verb's DEADLINE;
 *   - the fixture expectations (README.md) in the documented order, in a scenario
 *     built for them: priya is live and has edited + committed billing.ts before
 *     deepak's prompt, so deepak's prompt delivers an inbox and his pre-edit asks;
 *   - p95 timings without a refresh: pre-edit < 120 ms, prompt < 150 ms;
 *   - 8 parallel pre-edit processes on one session -> exactly one `ask`;
 *     8 parallel post-edit processes -> no duplicate note, one contract record;
 *   - `git pull` of 50 foreign commits -> zero commit events (author filter).
 *
 *   node scripts/smoke/run.mjs          RELAY_HUB=<url> reuses a running hub; KEEP=1 keeps the temp dir;
 *                                       RELAY_SMOKE_TIMING=warn turns the p95 gates into warnings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Checker,
  HOOK,
  authorEnv,
  git,
  hookEnv,
  hso,
  hub,
  initRepo,
  listOutbox,
  loadFixture,
  makeOrigin,
  percentile,
  readJson,
  rmrf,
  runHook,
  startHub,
  stdin,
  substitute,
  tmpRoot,
  waitFor,
  writeSmokeTree,
} from '../lib/relay-test.mjs';

const REPO = 'acme/app';
const BILLING = 'packages/contracts/src/billing.ts';
const INVOICES = 'apps/dashboard/src/invoices.tsx';
const RELAY_JSON = {
  project: 'acme-portal',
  repo: REPO,
  areas: {
    app: { paths: ['apps/app/**'], owners: ['priya'] },
    dashboard: { paths: ['apps/dashboard/**'], owners: ['deepak'] },
    contracts: { paths: ['packages/contracts/**', 'prisma/**'], shared: true },
  },
  contracts: { packages: ['@acme/contracts'], export_scan: true },
  depends: { dashboard: ['contracts'], app: ['contracts'] },
  impacts: { debounce_minutes: 3 },
};
const P95 = { 'pre-edit': 120, prompt: 150 };
const TIMING_MODE = process.env.RELAY_SMOKE_TIMING ?? 'strict';
const SLACK_MS = 400; // wall time includes the node spawn; the design's DEADLINE is measured inside the hook

const c = new Checker('smoke');
if (!existsSync(HOOK)) {
  console.error(`missing ${HOOK}: run pnpm build first`);
  process.exit(1);
}

const root = tmpRoot('relay-smoke-');
console.log(`smoke: temp dir ${root}`);
let hubHandle = null;
let ok = false;
try {
  hubHandle = await startHub({ dataDir: join(root, 'hub-data'), seed: false });
  const HUB = hubHandle.url;
  console.log(`smoke: hub ${HUB}${hubHandle.external ? ' (external)' : ''}`);

  // ------------------------------------------------------------ rig
  const seedDir = join(root, 'seed');
  mkdirSync(seedDir, { recursive: true });
  writeSmokeTree(seedDir, RELAY_JSON);
  initRepo(seedDir, { name: 'Seed', email: 'seed@acme.dev', message: 'init' });
  const { clones } = makeOrigin(root, seedDir, [
    { handle: 'priya', name: 'Priya', email: 'priya@acme.dev' },
    { handle: 'deepak', name: 'Deepak', email: 'deepak@acme.dev' },
  ]);
  const mkDev = (handle) => {
    const home = join(root, `home-${handle}`);
    mkdirSync(home, { recursive: true });
    const d = { handle, home, cwd: clones[handle], sessionId: randomUUID() };
    d.env = () => hookEnv({ home, hubUrl: HUB, dev: handle, sessionId: d.sessionId });
    d.base = () => ({ session_id: d.sessionId, cwd: d.cwd, transcript_path: join(home, 'transcript.jsonl') });
    d.vars = () => ({ REPO: d.cwd, HOME: home, SESSION: d.sessionId, HUB });
    return d;
  };
  const priya = mkDev('priya');
  const deepak = mkDev('deepak');
  const query = (dev, path, q = {}) => hub(HUB, { dev: dev.handle, session: dev.sessionId, path, query: { repo: REPO, ...q } });

  /** Run one verb; assert the §4.0 invariants; return the run. */
  async function run(dev, verb, input, { extraEnv = {}, maxMs = null, label = null, quiet = false } = {}) {
    const r = await runHook([verb], input, { ...dev.env(), ...extraEnv }, { cwd: dev.cwd });
    const name = label ?? `${dev.handle} ${verb}`;
    if (!quiet) {
      c.check(`${name}: exit 0`, r.code === 0, `code ${r.code}`);
      c.check(`${name}: stderr empty`, r.stderr === '', r.stderr.slice(0, 300));
      if (r.stdout.trim()) {
        c.check(`${name}: stdout is one JSON object <= 9,000 chars`, r.json !== null && r.stdout.length <= 9000, r.stdout.slice(0, 200));
      }
      if (maxMs !== null) c.check(`${name}: ${r.ms} ms < ${maxMs} ms`, r.ms < maxMs);
    }
    return r;
  }
  /** Replay a fixture file for a dev and check its `expect` block. */
  async function fixture(dev, name, { extraEnv = {}, expectStdout = undefined, expectDecision = undefined } = {}) {
    const fx = substitute(loadFixture(name), dev.vars());
    const r = await run(dev, fx.verb, fx.stdin, { extraEnv: { ...fx.env, ...extraEnv }, maxMs: (fx.expect.maxMs ?? 2000) + SLACK_MS, label: `fixture ${name}` });
    c.check(`fixture ${name}: exit ${fx.expect.exit}`, r.code === fx.expect.exit);
    const want = expectStdout ?? fx.expect.stdout;
    if (want === 'none') c.check(`fixture ${name}: no stdout`, r.stdout === '', r.stdout.slice(0, 200));
    else {
      const h = hso(r);
      c.check(`fixture ${name}: hookSpecificOutput.hookEventName = ${fx.expect.hookEventName}`, h?.hookEventName === fx.expect.hookEventName, r.stdout.slice(0, 200) || '(no stdout)');
      const decision = expectDecision === undefined ? fx.expect.permissionDecision : expectDecision;
      if (decision) c.check(`fixture ${name}: permissionDecision = ${decision}`, h?.permissionDecision === decision, JSON.stringify({ decision: h?.permissionDecision, reason: h?.permissionDecisionReason }).slice(0, 300));
    }
    return { fx, r };
  }
  async function bg(dev, job, extra = []) {
    const r = await runHook(['bg', job, '--session', dev.sessionId, '--cwd', dev.cwd, ...extra], null, { ...dev.env(), RELAY_BG: '1' }, { cwd: dev.cwd });
    c.check(`${dev.handle} bg ${job}: exit 0, silent`, r.code === 0 && r.stdout === '' && r.stderr === '', `code ${r.code} ${r.stderr.slice(0, 200)}`);
    return r;
  }
  const ctx = (r) => String(hso(r)?.additionalContext ?? '');

  // ------------------------------------------------------------ priya is live
  console.log('\n== priya: session start');
  const ps = await run(priya, 'session-start', stdin.sessionStart(priya.base()), { maxMs: 3500 + SLACK_MS });
  c.must('priya session-start: live digest', /^<relay-digest [^>]*freshness="live"/.test(ctx(ps)), ctx(ps).slice(0, 160));
  await bg(priya, 'session-start');

  // ------------------------------------------------------------ deepak fixtures, in the documented order
  console.log('\n== fixture: session-start');
  const { r: ss } = await fixture(deepak, 'session-start');
  const digest = ctx(ss);
  c.check('digest <= 6,000 chars, names priya under Team now', digest.length <= 6000 && /## Team now[\s\S]*- priya /.test(digest), digest.slice(0, 400));
  c.check('meta.json: dev deepak, branch main, author filter set', (() => {
    const m = readJson(join(deepak.home, 'sessions', deepak.sessionId, 'meta.json'));
    return m && m.dev === 'deepak' && m.branch === 'main' && m.gitEmails.includes('deepak@acme.dev');
  })());
  await bg(deepak, 'session-start');

  // priya changes and commits the contract, then leaves deepak a note — after deepak's digest, so the prompt must deliver both
  console.log('\n== priya: edit + commit billing.ts, notify deepak');
  const pBilling = join(priya.cwd, BILLING);
  writeFileSync(pBilling, readFileSync(pBilling, 'utf8').replace('total: number', 'amountDue: number'));
  await run(priya, 'post-edit', stdin.postEdit(priya.base(), pBilling), { maxMs: 6000 + SLACK_MS });
  git(priya.cwd, ['commit', '-qam', 'contracts: rename Invoice.total to amountDue'], authorEnv('Priya', 'priya@acme.dev'));
  const priyaSha = git(priya.cwd, ['rev-parse', 'HEAD']);
  await run(priya, 'post-git', stdin.postGit(priya.base(), 'git commit -am "contracts: rename Invoice.total to amountDue"'), { maxMs: 6000 + SLACK_MS });
  const note = await hub(HUB, { dev: 'priya', session: priya.sessionId, method: 'POST', path: '/v1/notify', body: { dev: 'deepak', message: 'keep `status` — dashboard already consumes it', kind: 'fyi', repo: REPO } });
  c.must('hub: priya -> deepak note accepted', note.status === 200 && Array.isArray(note.body.ids) && note.body.ids.length === 1, JSON.stringify(note.body).slice(0, 200));
  const noteId = note.body.ids[0];
  const snap = await waitFor(async () => {
    const s = await query(deepak, '/v1/snapshot');
    return s.status === 200 && (s.body.changeSets ?? []).some((cs) => cs.impacts.some((i) => i.path === BILLING && i.status === 'committed')) ? s.body : null;
  });
  c.must('hub: committed change set for billing.ts targets deepak', Boolean(snap));
  const cs = snap.changeSets.find((x) => x.impacts.some((i) => i.path === BILLING));
  c.check('change set dependents include the dashboard (import-derived)', cs.dependents.some((d) => d.path === INVOICES && d.via === 'import'), JSON.stringify(cs.dependents));
  console.log(`   change set ${cs.id} priority ${cs.priority}`);

  console.log('\n== fixture: prompt');
  const { r: pr } = await fixture(deepak, 'prompt', { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' } });
  const inbox = ctx(pr);
  c.check('prompt: <relay-inbox> with the NOTE from priya', /^<relay-inbox /.test(inbox) && /NOTE from priya/.test(inbox) && inbox.includes('keep `status`'), inbox.slice(0, 300) || '(no stdout)');
  const impactAtPrompt = inbox.includes(`IMPACT ${cs.id}`);
  c.check(`prompt: IMPACT delivered iff the change set is high priority (${cs.priority})`, impactAtPrompt === (cs.priority === 'high'), inbox.slice(0, 300));
  c.check('prompt: systemMessage for the user', /^Relay: /.test(String(pr.json?.systemMessage)), JSON.stringify(pr.json?.systemMessage));
  const promptEntry = listOutbox(deepak.home).filter((e) => e.kind === 'events').pop();
  c.check('prompt: WAL entry with delivered[] for the worker', Boolean(promptEntry) && (promptEntry.body.delivered ?? []).includes(noteId), JSON.stringify(promptEntry?.body?.delivered));
  await bg(deepak, 'prompt', promptEntry ? ['--entry', promptEntry.id] : []);
  const again = await run(deepak, 'prompt', stdin.prompt(deepak.base(), 'Continue with the dashboard table.'), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' }, maxMs: 2000 + SLACK_MS });
  c.check('prompt: nothing is delivered twice', !/NOTE from priya/.test(again.stdout) && !again.stdout.includes(`IMPACT ${cs.id}`), again.stdout.slice(0, 200));

  console.log('\n== fixture: pre-edit (collision ask)');
  const { r: pe } = await fixture(deepak, 'pre-edit');
  const h = hso(pe);
  c.check('pre-edit: reason "Relay: priya is editing packages/contracts/src/billing.ts …"', /^Relay: priya is editing packages\/contracts\/src\/billing\.ts/.test(String(h?.permissionDecisionReason)), h?.permissionDecisionReason);
  c.check('pre-edit: additionalContext "Relay at HH:MM:SSZ:"', /^Relay at \d\d:\d\d:\d\dZ:/.test(String(h?.additionalContext)), h?.additionalContext);
  const pe2 = await fixture(deepak, 'pre-edit', { expectStdout: 'json', expectDecision: null });
  c.check('pre-edit: second run is context only (asked mark), never a second ask', hso(pe2.r)?.permissionDecision === undefined, JSON.stringify(hso(pe2.r)).slice(0, 200));

  console.log('\n== fixture: pre-edit-write (JIT note on a dependent)');
  const { r: pw } = await fixture(deepak, 'pre-edit-write', { expectStdout: impactAtPrompt ? 'none' : 'json' });
  if (impactAtPrompt) c.check('pre-edit-write: silent because the prompt already delivered the change set (once per session)', pw.stdout === '', pw.stdout.slice(0, 200));
  else c.check('pre-edit-write: JIT note names the change set and the dependent', ctx(pw).includes(`IMPACT ${cs.id}`) && ctx(pw).includes(INVOICES), ctx(pw).slice(0, 300));
  c.check('pre-edit-write: no permission decision on my own area', hso(pw)?.permissionDecision === undefined);

  console.log('\n== fixture: pre-read');
  await fixture(deepak, 'pre-read');

  console.log('\n== fixture: post-edit');
  const dBilling = join(deepak.cwd, BILLING);
  writeFileSync(dBilling, 'export interface Invoice {\n  id: string\n  amountDue: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n');
  await fixture(deepak, 'post-edit');
  const mine = await query(priya, '/v1/query/recent_changes', { kind: 'contracts' });
  c.check('hub: deepak\'s uncommitted contract record for billing.ts (Invoice)', (mine.body.items ?? []).some((i) => i.dev === 'deepak' && i.path === BILLING && i.status === 'uncommitted' && i.symbols.includes('Invoice')), JSON.stringify(mine.body.items?.map((i) => [i.dev, i.path, i.status])).slice(0, 300));

  console.log('\n== fixture: post-git');
  git(deepak.cwd, ['commit', '-qam', 'contracts: rename Invoice.total to amountDue'], authorEnv('Deepak', 'deepak@acme.dev'));
  const deepakSha = git(deepak.cwd, ['rev-parse', 'HEAD']);
  await fixture(deepak, 'post-git');
  const commits = await query(priya, '/v1/query/recent_changes', { kind: 'commits' });
  c.check('hub: deepak\'s commit reported with its sha', (commits.body.items ?? []).some((i) => i.kind === 'commit' && i.dev === 'deepak' && i.sha === deepakSha), JSON.stringify(commits.body.items?.map((i) => [i.dev, i.sha?.slice(0, 7)])).slice(0, 300));

  console.log('\n== fixtures: task-created, task-completed, cwd');
  for (const name of ['task-created', 'task-completed', 'cwd']) await fixture(deepak, name);

  console.log('\n== fixture: stop');
  await fixture(deepak, 'stop');
  const draft = readJson(join(deepak.home, 'sessions', deepak.sessionId, 'draft.json'));
  c.check('stop: heuristic draft with the two next steps', Array.isArray(draft?.next) && draft.next.join('|') === 'Backfill legacy invoices|Update the API docs', JSON.stringify(draft?.next));
  c.check('stop: draft records the decision and the blocker', (draft?.decisions ?? []).length >= 1 && (draft?.blockers ?? []).length >= 1, JSON.stringify({ decisions: draft?.decisions, blockers: draft?.blockers }));

  console.log('\n== fixture: session-start-resume, session-start-compact');
  const { r: rs } = await fixture(deepak, 'session-start-resume');
  c.check('resume: delta digest <= 2,000 chars', /mode="delta"/.test(ctx(rs)) && ctx(rs).length <= 2000, `${ctx(rs).length} chars: ${ctx(rs).slice(0, 120)}`);
  const { r: cp } = await fixture(deepak, 'session-start-compact');
  c.check('compact: local re-injection <= 1,500 chars', /^<relay-digest mode="compact"/.test(ctx(cp)) && ctx(cp).length <= 1500, `${ctx(cp).length} chars`);

  console.log('\n== fixture: session-end');
  const { r: se } = await fixture(deepak, 'session-end');
  c.check('session-end: under 1 s wall time', se.ms < 1000, `${se.ms} ms`);
  const endEntry = listOutbox(deepak.home).find((e) => e.kind === 'session_end');
  c.must('session-end: session_end WAL entry written', Boolean(endEntry));
  await bg(deepak, 'session-end', ['--entry', endEntry.id]);
  const handoffs = await waitFor(async () => {
    const r = await query(priya, '/v1/query/handoffs', { dev: 'deepak', n: 3 });
    return r.status === 200 && (r.body.items ?? []).length > 0 ? r.body.items : null;
  });
  c.check('hub: heuristic handoff for deepak with the draft\'s next steps', Boolean(handoffs) && handoffs[0].quality === 'heuristic' && handoffs[0].next.includes('Backfill legacy invoices'), JSON.stringify(handoffs?.[0]?.next));

  // ------------------------------------------------------------ p95 timings without a refresh (§12 M0)
  console.log('\n== timings (20 runs each, snapshot fresh, no refresh)');
  const timing = {};
  deepak.sessionId = randomUUID();
  const s2 = await run(deepak, 'session-start', stdin.sessionStart(deepak.base()), { maxMs: 3500 + SLACK_MS, label: 'deepak session-start (S2)' });
  c.must('S2 session-start: digest', /^<relay-digest /.test(ctx(s2)));
  for (const [verb, input] of [
    ['pre-edit', () => stdin.preEdit(deepak.base(), join(deepak.cwd, 'apps/dashboard/src/invoices.tsx'))],
    ['prompt', () => stdin.prompt(deepak.base(), 'Keep going with the table.')],
  ]) {
    const ms = [];
    for (let i = 0; i < 20; i++) {
      const r = await run(deepak, verb, input(), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '3600000' }, quiet: true });
      if (r.code !== 0 || r.stderr) c.check(`${verb} timing run ${i}: exit 0, no stderr`, false, `${r.code} ${r.stderr.slice(0, 100)}`);
      ms.push(r.ms);
    }
    const p95 = percentile(ms, 95);
    timing[verb] = { p50: percentile(ms, 50), p95 };
    const label = `${verb} p95 ${p95} ms < ${P95[verb]} ms (p50 ${timing[verb].p50} ms, wall time incl. node spawn)`;
    if (p95 < P95[verb] || TIMING_MODE === 'strict') c.check(label, p95 < P95[verb]);
    else c.warn(label);
  }

  // ------------------------------------------------------------ 8 parallel pre-edit: exactly one ask; 8 parallel post-edit: no duplicate note
  console.log('\n== parallel hooks on one session');
  const target = join(deepak.cwd, BILLING);
  const pres = await Promise.all(Array.from({ length: 8 }, (_, i) => runHook(['pre-edit'], stdin.preEdit(deepak.base(), target, { tool_use_id: `toolu_par_${i}` }), deepak.env(), { cwd: deepak.cwd })));
  c.check('8 parallel pre-edit: all exit 0 with empty stderr', pres.every((r) => r.code === 0 && r.stderr === ''), JSON.stringify(pres.map((r) => [r.code, r.stderr.slice(0, 40)])));
  const asks = pres.filter((r) => hso(r)?.permissionDecision === 'ask').length;
  c.check('8 parallel pre-edit on one session -> exactly one ask', asks === 1, `${asks} asks`);
  c.check('the other seven are context only or silent', pres.filter((r) => hso(r)?.permissionDecision === undefined).length === 7);
  const note2 = await hub(HUB, { dev: 'priya', session: priya.sessionId, method: 'POST', path: '/v1/notify', body: { dev: 'deepak', message: 'second note: parallel delivery test', kind: 'fyi', repo: REPO } });
  c.must('hub: second note accepted', note2.status === 200);
  // refresh deepak's cache so the post-edits see the note (the prompt path would do this; workers do it here)
  await run(deepak, 'prompt', stdin.prompt(deepak.base(), 'Read the new note but keep the file as is.'), { extraEnv: { RELAY_SNAPSHOT_TTL_MS: '1' }, quiet: true, label: 'refresh' }).then((r) => {
    // the prompt itself delivers the note once; the parallel post-edits below must not deliver it again
    c.check('refresh prompt delivered the second note once', /second note/.test(r.stdout), r.stdout.slice(0, 200));
  });
  const note3 = await hub(HUB, { dev: 'priya', session: priya.sessionId, method: 'POST', path: '/v1/notify', body: { dev: 'deepak', message: 'third note: arrives mid-turn', kind: 'fyi', repo: REPO } });
  c.must('hub: third note accepted', note3.status === 200);
  writeFileSync(target, readFileSync(target, 'utf8').replace('amountDue: number', 'amountDue: number\n  currency: string'));
  const posts = await Promise.all(Array.from({ length: 8 }, (_, i) => runHook(['post-edit'], stdin.postEdit(deepak.base(), target, { tool_use_id: `toolu_post_${i}` }), deepak.env(), { cwd: deepak.cwd })));
  c.check('8 parallel post-edit: all exit 0 with empty stderr', posts.every((r) => r.code === 0 && r.stderr === ''), JSON.stringify(posts.map((r) => [r.code, r.stderr.slice(0, 40)])));
  const noteHits = posts.filter((r) => /third note/.test(r.stdout)).length;
  c.check('the note that arrived mid-turn is delivered by exactly one of the 8 post-edits', noteHits === 1, `${noteHits} deliveries`);
  const contractsNow = await query(priya, '/v1/query/recent_changes', { kind: 'contracts' });
  const s2Records = (contractsNow.body.items ?? []).filter((i) => i.dev === 'deepak' && i.path === BILLING && i.status === 'uncommitted');
  c.check('hub: the 8 identical post-edits produced one uncommitted record for billing.ts (dedup by hash)', s2Records.length === 1, `${s2Records.length} records`);

  // ------------------------------------------------------------ git pull of 50 foreign commits -> zero commit events
  console.log('\n== git pull of 50 foreign commits');
  const carol = authorEnv('Carol', 'carol@acme.dev');
  for (let i = 0; i < 50; i++) {
    writeFileSync(join(priya.cwd, 'README.md'), `# smoke\ncarol ${i}\n`);
    git(priya.cwd, ['commit', '-qam', `carol: change ${i}`], carol);
  }
  git(priya.cwd, ['push', '-q', 'origin', 'main']);
  const foreign = git(priya.cwd, ['log', '--format=%H', '-n50']).split('\n');
  git(deepak.cwd, ['stash', '-q']);
  git(deepak.cwd, ['pull', '-q', '--no-rebase', 'origin', 'main']);
  const mergeSha = git(deepak.cwd, ['rev-parse', 'HEAD']);
  const pull = await run(deepak, 'post-git', stdin.postGit(deepak.base(), 'git pull', 'Updating…'), { maxMs: 6000 + SLACK_MS, label: 'deepak post-git (pull)' });
  c.check('post-git after pull: silent', pull.stdout === '' || !/IMPACT|NOTE/.test(pull.stdout));
  const after = await query(priya, '/v1/query/recent_changes', { kind: 'commits' });
  const byDeepak = (after.body.items ?? []).filter((i) => i.kind === 'commit' && i.dev === 'deepak').map((i) => i.sha);
  c.check('hub: none of the 50 foreign commits was attributed to deepak', !foreign.some((sha) => byDeepak.includes(sha)), JSON.stringify(byDeepak.map((s) => s.slice(0, 7))));
  const merge = readJson(join(deepak.home, 'sessions', deepak.sessionId, 'meta.json'));
  const state = readJson(join(deepak.home, 'cache', merge?.repoKey ?? '_', 'state.json'));
  c.check('lastReportedSha advanced past the pull (no re-scan next time)', state?.lastReportedSha?.main === mergeSha, JSON.stringify(state?.lastReportedSha));
  c.check('the pull\'s merge commit (authored by deepak) is not reported either (--no-merges)', !byDeepak.includes(mergeSha), mergeSha.slice(0, 7));

  console.log(`\ntimings: ${JSON.stringify(timing)}`);
  ok = c.summary();
} catch (err) {
  console.error(`\nsmoke aborted: ${err && err.stack ? err.stack : err}`);
  c.summary();
  ok = false;
} finally {
  if (hubHandle) await hubHandle.stop();
  if (process.env.KEEP === '1') console.log(`smoke: kept ${root}`);
  else rmrf(root);
}
process.exit(ok ? 0 : 1);
