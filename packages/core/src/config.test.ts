import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { configHash, loadRelayConfig, loadTeamConfig, readEnv, resolveContractGlobs, resolvePluginSha, resolveRelayConfig, stripJsonComments } from './config.js';
import { DEFAULT_CONTRACT_GLOBS, RELAY_CONFIG_DEFAULTS } from './protocol.js';

describe('config', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('applies "+glob" prepend semantics and plain replacement', () => {
    expect(resolveContractGlobs(undefined)).toEqual([...DEFAULT_CONTRACT_GLOBS]);
    expect(resolveContractGlobs(['+**/*.graphql'])).toEqual(['**/*.graphql', ...DEFAULT_CONTRACT_GLOBS]);
    expect(resolveContractGlobs(['src/api/**'])).toEqual(['src/api/**']);
    expect(resolveContractGlobs(['+extra/**', 'only/**'])).toEqual(['extra/**', 'only/**']);
  });

  it('resolves defaults for an absent file', () => {
    const r = resolveRelayConfig(null, { slug: 'github.com/acme/app' });
    expect(r.project).toBe('acme/app');
    expect(r.repo).toBe('github.com/acme/app');
    expect(r.collision).toEqual(RELAY_CONFIG_DEFAULTS.collision);
    expect(r.privacy.send_turns).toBe('prose');
    expect(r.contracts.export_scan).toBe(true);
    expect(r.handoff.idle_minutes).toBe(20);
  });

  it('loads JSONC with comments, overrides repo/project and hashes canonically', () => {
    const t = tmpHome();
    cleanups.push(t.cleanup);
    writeFileSync(
      join(t.home, '.relay.json'),
      `{
        // comment
        "project": "acme-portal",
        "repo": "demo/app", /* block */
        "areas": { "app": { "paths": ["apps/app/**"], "owners": ["priya"] }, "contracts": { "paths": ["packages/contracts/**"], "shared": true } },
        "contracts": { "globs": ["+**/*.graphql"], "packages": ["@acme/contracts"] },
        "collision": { "hot": "deny" },
        "privacy": { "send_prompts": true, "send_turns": false },
        "handoff": { "idle_minutes": 5 },
      }`,
    );
    const a = loadRelayConfig(t.home, { slug: 'github.com/acme/app' });
    expect(a.invalid).toBe(false);
    expect(a.resolved.project).toBe('acme-portal');
    expect(a.resolved.repo).toBe('demo/app');
    expect(a.resolved.areas['contracts']?.shared).toBe(true);
    expect(a.resolved.contracts.globs[0]).toBe('**/*.graphql');
    expect(a.resolved.contracts.packages).toEqual(['@acme/contracts']);
    expect(a.resolved.collision.hot).toBe('deny');
    expect(a.resolved.collision.warm).toBe('context');
    expect(a.resolved.privacy.send_turns).toBe(false);
    expect(a.resolved.privacy.send_prompts).toBe(true);
    expect(a.resolved.handoff.idle_minutes).toBe(5);
    expect(a.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(configHash({ b: 1, a: 2 } as never)).toBe(configHash({ a: 2, b: 1 } as never));
  });

  it('treats a malformed file as absent', () => {
    const t = tmpHome();
    cleanups.push(t.cleanup);
    writeFileSync(join(t.home, '.relay.json'), '{ not json');
    const a = loadRelayConfig(t.home, { slug: 'local/x' });
    expect(a.invalid).toBe(true);
    expect(a.raw).toBeNull();
    expect(a.resolved.repo).toBe('local/x');
  });

  it('strips comments only outside strings', () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x // not a comment", /* c */ "b": 1, }'))).toEqual({ a: 'http://x // not a comment', b: 1 });
  });

  it('reads env with overrides and team.json', () => {
    const t = tmpHome();
    cleanups.push(t.cleanup);
    const plugin = join(t.home, 'plugin');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, 'team.json'), JSON.stringify({ hub: 'https://hub.example/', team: 'pc', token: 'rt_x', members: { deepak: { name: 'D', emails: ['d@x.com'] } } }));
    const env = readEnv({ RELAY_HOME: t.home, RELAY_HUB: 'http://localhost:8787', RELAY_SNAPSHOT_TTL_MS: '15000', CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PID: '123', RELAY_INTERACTIVE: '0' });
    expect(env.home).toBe(t.home);
    expect(env.snapshotTtlMs).toBe(15000);
    expect(env.pid).toBe(123);
    expect(env.interactive).toBe(false);
    const team = loadTeamConfig(env);
    expect(team?.hub).toBe('http://localhost:8787');
    expect(team?.token).toBe('rt_x');
    expect(team?.members['deepak']?.emails).toEqual(['d@x.com']);
    // no plugin root but env hub+token -> synthesized team
    const env2 = readEnv({ RELAY_HUB: 'http://h', RELAY_TOKEN: 'rt_y' });
    expect(loadTeamConfig(env2)?.team).toBe('env');
    expect(loadTeamConfig(readEnv({}))).toBeNull();
    // plugin sha: installed_plugins.json first, then plugin.json version, then basename
    const claudeHome = join(t.home, 'claude');
    mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
    expect(resolvePluginSha(env, claudeHome)).toBe('plugin');
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'relay', version: '0.0.3' }));
    expect(resolvePluginSha(env, claudeHome)).toBe('0.0.3');
    writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'relay@relay': [{ gitCommitSha: 'abc123' }] } }));
    expect(resolvePluginSha(env, claudeHome)).toBe('abc123');
  });
});
