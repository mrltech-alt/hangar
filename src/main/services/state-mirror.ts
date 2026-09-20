// state/agents/<id>.json — what `hangar status` reads; works even when the app is closed (spec §6.6).
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMirror, WorkspaceFile } from '../../../shared/types.ts';
import { atomicWriteJson } from '../util/atomic-write.ts';

export function buildMirrors(ws: WorkspaceFile, now: string): AgentMirror[] {
  return ws.agents.map((a) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    notes: a.notes,
    updatedAt: now,
    workspaces: a.workspaces.map((w) => {
      const p = ws.projects.find((x) => x.id === w.projectId);
      return { projectName: p?.name ?? w.projectId, repoPath: p?.repoPath ?? '', branch: w.branch, worktreePath: w.worktreePath };
    }),
  }));
}

export function writeMirrors(dir: string, ws: WorkspaceFile, now: string = new Date().toISOString()): void {
  mkdirSync(dir, { recursive: true });
  const keep = new Set<string>();
  for (const m of buildMirrors(ws, now)) {
    // Defence in depth at the boundary where an id becomes a path. `IdSchema` already constrains the
    // charset, but this is the place where getting it wrong writes a file outside the profile, and
    // this module must not depend on a validation rule living in another file staying strict.
    if (m.id.includes('/') || m.id.includes('\\') || m.id === '.' || m.id === '..') {
      throw new Error(`refusing to write a state mirror for an unsafe agent id: ${JSON.stringify(m.id)}`);
    }
    const name = `${m.id}.json`;
    keep.add(name);
    // `atomicWriteJson`, not a hand-rolled write+rename: it is the same `<file>.tmp` → rename dance
    // (the `.json.tmp` swept below is its temp file), and it also refuses to write a value
    // `JSON.stringify` turns into `undefined`. Three copies of this was two too many.
    atomicWriteJson(join(dir, name), m);
  }
  // This directory is owned exclusively by main and namespaced by agent id, so anything that is not
  // a current agent is debris — do not "fix" this into something more cautious. `.json.tmp` is swept
  // too: a crash between the write and the rename leaves one behind, and matching only `.json` left
  // it there permanently once its agent was deleted.
  for (const f of readdirSync(dir)) {
    if (/\.json(\.tmp)?$/.test(f) && !keep.has(f)) unlinkSync(join(dir, f));
  }
}
