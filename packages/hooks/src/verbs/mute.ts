/**
 * `hook.mjs mute <target> [--undo]` for `/relay:mute` (§5.4, §9.2): a
 * per-machine mute in ~/.relay/mute/<repoKey>.json that silences collision
 * and JIT notes for a path, glob, area or `@dev`. Run from the repo by the
 * skill (Bash), not by a hook, so it prints one plain-text line.
 */
import { addMute, loadRelayConfig, localSlug, normalizeOriginUrl, readMutes, removeMute, repoKey } from '@relay/core';
import type { HookRuntime } from '../runtime.js';

export async function runMute(rt: HookRuntime, cwd: string = process.cwd()): Promise<string> {
  const undo = rt.args.includes('--undo');
  const target = rt.args.find((a) => !a.startsWith('--'))?.trim();
  const rp = await rt.git.revParseSet(cwd, { signal: rt.signal });
  const root = rp.toplevel ?? cwd;
  const slug = normalizeOriginUrl(rp.originUrl) ?? localSlug(root);
  const config = loadRelayConfig(root, { slug, project: rt.env.project });
  const key = repoKey(config.resolved.repo);
  if (!target) {
    const list = readMutes(rt.home, key);
    return list.length ? `Relay mutes for ${config.resolved.repo}: ${list.map((m) => `${m.target} (${m.kind})`).join(', ')}` : `Relay: no mutes for ${config.resolved.repo}`;
  }
  if (undo) {
    removeMute(rt.home, key, target);
    return `Relay: unmuted ${target} for ${config.resolved.repo} on this machine`;
  }
  const list = addMute(rt.home, key, target, config.resolved.areas, rt.now());
  const kind = list.find((m) => m.target === target)?.kind ?? 'path';
  return `Relay: muted ${target} (${kind}) for ${config.resolved.repo} on this machine; collision and impact notes for it are silenced until /relay:mute ${target} --undo`;
}
