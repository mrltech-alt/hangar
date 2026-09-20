// Single writer for workspace.json — spec §6.4. Atomic writes, .bak recovery, version migrations.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { normalizeLayout } from '../../../shared/layout.ts';
import { emptyWorkspace, type Folder, type WorkspaceFile } from '../../../shared/types.ts';
import { WorkspaceFileSchema } from '../../../shared/workspace-schema.ts';
import { atomicWriteJson } from '../util/atomic-write.ts';

export const CURRENT_VERSION = 1;

/**
 * An I/O failure — permissions, device, a directory where a file belongs, descriptor exhaustion —
 * as opposed to damaged content. Kept distinct because §6.4's corruption path (move aside, start
 * empty) is the wrong response to it, and destructive: `rename` needs only directory permission, so
 * a perfectly healthy `workspace.json` that merely could not be OPENED would be renamed away and
 * replaced with an empty one, and the user would meet zero projects and zero agents after a
 * transient EMFILE. `load()` throws instead so boot can fail loudly with a dialog; nothing is moved
 * and nothing is written. One base class so that dialog needs a single `instanceof`.
 */
export class WorkspaceIoError extends Error {
  readonly file: string;
  /** libuv error code, e.g. `EACCES`, `EMFILE`, `EISDIR`. */
  readonly code: string | undefined;
  /** libuv syscall, e.g. `open`, `rename` — the half of the failure `code` alone does not say. */
  readonly syscall: string | undefined;
  constructor(name: string, summary: string, file: string, cause: unknown) {
    const e = cause as { code?: unknown; syscall?: unknown };
    const code = typeof e.code === 'string' ? e.code : undefined;
    super(`${summary} ${file}: ${code ?? (cause instanceof Error ? cause.message : String(cause))}`, { cause });
    this.name = name;
    this.file = file;
    this.code = code;
    this.syscall = typeof e.syscall === 'string' ? e.syscall : undefined;
  }
}

/** `workspace.json` or its `.bak` exists but could not be read. */
export class WorkspaceUnreadableError extends WorkspaceIoError {
  constructor(file: string, cause: unknown) {
    super('WorkspaceUnreadableError', 'cannot read', file, cause);
  }
}

/** A corrupt `workspace.json` could not be renamed to `.corrupt-<timestamp>`. */
export class WorkspaceMoveAsideError extends WorkspaceIoError {
  constructor(file: string, cause: unknown) {
    super('WorkspaceMoveAsideError', 'cannot move aside the corrupt', file, cause);
  }
}

/** Keyed by the version being migrated FROM. Add `[1]: (raw) => ({ ...raw, version: 2, ... })` when bumping. */
export const migrations: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  let version = typeof current.version === 'number' ? current.version : 0;
  // A file from a NEWER build is not corrupt, and the difference matters to the user: it is still
  // preserved as `.corrupt-<timestamp>`, but a generic schema error gives them no way to know that
  // the fix is to upgrade rather than to let Hangar overwrite it.
  if (version > CURRENT_VERSION) {
    throw new Error(
      `workspace file version ${version} was written by a newer version of Hangar (this build reads version ${CURRENT_VERSION}); ` +
        'the file has been preserved — upgrade Hangar rather than overwriting it',
    );
  }
  while (version < CURRENT_VERSION) {
    const step = migrations[version];
    if (!step) throw new Error(`no migration from workspace version ${version}`);
    current = step(current);
    // Assuming `version + 1` when a migration forgets to set `version` hid the bug: the loop
    // exited, the half-migrated object failed the schema, and the user's file was classed corrupt.
    const next = current.version;
    if (typeof next !== 'number') throw new Error(`migration from version ${version} did not set a numeric version`);
    if (next <= version) throw new Error(`migration from version ${version} did not advance the version`);
    version = next;
  }
  return current;
}

/** Deterministic winner among entries sharing an id: lowest id, then sortKey, then name, then first. */
function preferred<T extends { id: string; name: string; sortKey: number }>(a: T, b: T): T {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? a : b;
  return a.name <= b.name ? a : b;
}

/**
 * Drops entries that repeat an id, keeping one deterministically. Neither `WorkspaceFileSchema` nor
 * anything else enforces uniqueness, and a repeat is not cosmetic: every lookup here builds a
 * `Map` keyed by id, which silently keeps the LAST entry, so the cycle detector below would walk a
 * graph that is not the one on disk — `[a→b, b→a, a→null]` reported no problem at all while
 * `siblings()` looped forever on it. A hand-edited file or a sync-conflict merge produces exactly
 * this, and that is the threat model this whole function is written against.
 */
function dedupeById<T extends { id: string; name: string; sortKey: number }>(items: T[], kind: string, problems: string[]): T[] {
  const winner = new Map<string, T>();
  for (const it of items) {
    const prev = winner.get(it.id);
    winner.set(it.id, prev === undefined ? it : preferred(prev, it));
  }
  if (winner.size === items.length) return items;
  return items.filter((it) => {
    if (winner.get(it.id) === it) return true;
    problems.push(`${kind} "${it.name}" repeated the id ${it.id}; kept "${winner.get(it.id)!.name}" and dropped this one`);
    return false;
  });
}

/**
 * Repairs §6.2 referential damage the schema cannot express, appending a line to `problems` for each
 * repair. Repair, never reject: `load()` treats a parse failure as corruption and moves the file
 * aside, so throwing here would cost the user every project and agent over something fixable.
 *
 * Three failures this exists for, all of which the schema accepts as valid:
 *   - a duplicate id makes every id-keyed lookup — including this function's own — disagree with the
 *     file, so the other two repairs cannot be trusted until it is gone (hence it runs first);
 *   - a dangling `parentId`/`folderId` makes `siblings()` silently omit that folder and its ENTIRE
 *     subtree — invisible, unreachable, and still written back on the next save;
 *   - a cycle makes every walk over the graph meaningless (`isDescendantFolder` is bounded, so it no
 *     longer hangs, but it cannot return a trustworthy answer).
 *
 * Repair lines are sorted before they reach `problems`: their content is a property of the graph,
 * but the order they are discovered in is not, and the §6.4 banner shows them to the user.
 */
export function repairTree(ws: WorkspaceFile, problems: string[]): WorkspaceFile {
  const found: string[] = [];
  const deduped = dedupeById(ws.folders, 'folder', found);
  const known = new Set(deduped.map((f) => f.id));
  let folders = deduped.map((f) => {
    if (f.parentId !== null && !known.has(f.parentId)) {
      found.push(`folder "${f.name}" (${f.id}) had a missing parent ${f.parentId}; moved to root`);
      return { ...f, parentId: null };
    }
    return f;
  });

  // Walk each folder's ancestry; the first ancestor the walk revisits is on a cycle. Cut ONE member
  // of that cycle, chosen by lowest id: the folder the walk started from is usually not in the cycle
  // at all (a healthy chain hanging off one starts outside it), and the member the walk happens to
  // revisit depends on where it started, so neither is a safe or order-independent choice. Picking
  // the lowest id makes the repair — and the `problems` line naming a folder to the user — a
  // property of the graph rather than of the order the folders happened to be stored in. That rule
  // is well defined because `parentId` is single-valued, so a folder belongs to at most one cycle
  // and distinct cycles are disjoint: each is cut exactly once, by its own lowest id.
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (const start of folders) {
    const seen = new Set<string>([start.id]);
    let cur = byId.get(start.id)!;
    while (cur.parentId !== null) {
      const parent = byId.get(cur.parentId);
      if (parent === undefined) break;
      if (seen.has(parent.id)) {
        const cycle: Folder[] = [];
        // `parent` is on the cycle, so following parentId from it returns to it; every member has a
        // non-null parentId that resolves, or the walk could not have reached this point.
        for (let node: Folder | undefined = parent; node !== undefined; node = node.parentId === null ? undefined : byId.get(node.parentId)) {
          if (cycle.length > 0 && node.id === parent.id) break;
          cycle.push(node);
        }
        const victim = cycle.reduce((a, b) => (a.id <= b.id ? a : b));
        found.push(`folder "${victim.name}" (${victim.id}) was in a parent cycle; moved to root`);
        const fixed = { ...victim, parentId: null };
        byId.set(victim.id, fixed);
        folders = folders.map((f) => (f.id === victim.id ? fixed : f));
        break;
      }
      seen.add(parent.id);
      cur = parent;
    }
  }

  const live = new Set(folders.map((f) => f.id));
  const agents = dedupeById(ws.agents, 'agent', found).map((a) => {
    if (a.folderId !== null && !live.has(a.folderId)) {
      found.push(`agent "${a.name}" (${a.id}) had a missing folder ${a.folderId}; moved to root`);
      return { ...a, folderId: null };
    }
    return a;
  });

  for (const line of found.sort()) problems.push(line);
  return { ...ws, folders, agents };
}

export function parseWorkspace(text: string, problems: string[] = []): WorkspaceFile {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('workspace file is not an object');
  const parsed = WorkspaceFileSchema.parse(migrate(raw as Record<string, unknown>));
  return repairTree({ ...parsed, layout: normalizeLayout(parsed.layout) }, problems);
}

const MAX_ISSUES = 3;

/**
 * One human-readable line for the §6.4 banner. A zod 4 message is the pretty-printed issue list and
 * starts with a bare `[`, so `message.split('\n')[0]` — written for `JSON.parse`, which is one line
 * — rendered every schema failure as literally `/…/workspace.json: [`. Same `path: message` shape
 * `host/server.ts` uses for `BAD_MESSAGE`, so the two do not drift.
 */
export function describeParseFailure(e: unknown): string {
  if (e instanceof z.ZodError) {
    const shown = e.issues.slice(0, MAX_ISSUES).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return e.issues.length > MAX_ISSUES ? `${shown}; and ${e.issues.length - MAX_ISSUES} more` : shown;
  }
  return e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
}

export interface LoadResult {
  recovered: 'none' | 'bak' | 'fresh';
  movedCorruptTo: string | null;
  problems: string[];
}

export interface WorkspaceStore {
  /** @throws {WorkspaceUnreadableError} if `file` exists but cannot be read (an I/O error is not corruption). */
  load(): LoadResult;
  get(): WorkspaceFile;
  update(mutate: (ws: WorkspaceFile) => WorkspaceFile): WorkspaceFile;
  /**
   * Writes any pending change now. Returns false only when a write was attempted and failed —
   * `true` means nothing is outstanding, not that a write happened. Never throws; see
   * `lastWriteError`, and note that a failed write is retried on a timer as well.
   */
  flush(): boolean;
  /** The most recent write failure, or null if the last attempted write succeeded. */
  lastWriteError(): Error | null;
  subscribe(listener: (ws: WorkspaceFile) => void): () => void;
}

export function createWorkspaceStore(opts: { file: string; bakFile: string; debounceMs?: number; now?: () => Date; log?: (line: string) => void }): WorkspaceStore {
  let ws: WorkspaceFile = emptyWorkspace();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let writeError: Error | null = null;
  const listeners = new Set<(ws: WorkspaceFile) => void>();
  const now = opts.now ?? (() => new Date());

  const debounceMs = opts.debounceMs ?? 200;
  // A failed write leaves `dirty` set, but nothing pending would then retry it until the user's next
  // edit — so the last change before a force-quit on a momentarily-full disk would be lost. Back off
  // rather than spin: a permissions or ENOSPC failure clears on a human timescale, if at all.
  const retryMs = Math.min(30_000, debounceMs * 10);

  const write = (): boolean => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return true; // nothing outstanding; a successful write is the only way to clear `dirty`
    try {
      atomicWriteJson(opts.file, ws, opts.bakFile);
    } catch (e) {
      // This runs from a `setTimeout`, where a throw is an UNCAUGHT EXCEPTION: in Electron main that
      // is an app crash with no dialog, and `flush()` on `before-quit` would crash the app on quit.
      // Stay dirty, retry later, and expose the failure through `lastWriteError()` for a banner.
      writeError = e instanceof Error ? e : new Error(String(e));
      opts.log?.(`workspace write to ${opts.file} failed: ${writeError.message}`);
      timer = setTimeout(write, retryMs);
      // A retry that never succeeds must not be the only thing holding a process open — this is the
      // one timer here that reschedules itself indefinitely.
      timer.unref?.();
      return false;
    }
    dirty = false;
    writeError = null;
    return true;
  };

  /** `<file>.corrupt-<timestamp>`, suffixed if that name is taken — clobbering it would lose the earlier copy. */
  const uniqueCorruptName = (): string => {
    const base = `${opts.file}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    let target = base;
    for (let n = 2; existsSync(target); n++) target = `${base}-${n}`;
    return target;
  };

  /** Raw bytes, or null if the file is absent. Distinguishes "not there" from "cannot be read". */
  const readOrNull = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') return null;
      throw new WorkspaceUnreadableError(file, e);
    }
  };

  const tryParse = (file: string, text: string | null, problems: string[]): WorkspaceFile | null => {
    if (text === null) return null;
    try {
      return parseWorkspace(text, problems);
    } catch (e) {
      problems.push(`${file}: ${describeParseFailure(e)}`);
      return null;
    }
  };

  /** The §6.4 banner needs to say a write failed; `LoadResult.problems` is where it looks. */
  const noteWriteFailure = (problems: string[]): void => {
    if (writeError !== null) problems.push(`${opts.file}: could not be saved: ${writeError.message}`);
  };

  return {
    load() {
      const problems: string[] = [];
      // Throws WorkspaceUnreadableError: nothing moved aside, nothing written.
      const text = readOrNull(opts.file);
      const primary = tryParse(opts.file, text, problems);
      if (primary !== null) {
        ws = primary;
        dirty = true;
        if (!write()) noteWriteFailure(problems); // persist normalization / migrations
        return { recovered: 'none', movedCorruptTo: null, problems };
      }
      // Read the .bak BEFORE moving anything: an unreadable .bak must propagate with the profile
      // still intact on disk. It is tempting to treat it as merely absent — the main file is already
      // known corrupt, and it is preserved under its `.corrupt-` name — but when the main file is
      // corrupt the .bak is the user's ONLY healthy copy, and "start empty" does not just ignore it:
      // the empty `workspace.json` parses cleanly on the next boot, and `atomicWriteJson` then
      // copies it straight over the .bak. Two faults, but the second is an EMFILE that clears by
      // itself, and one clean-looking boot later the real profile is gone for good.
      const bak = tryParse(opts.bakFile, readOrNull(opts.bakFile), problems);
      let movedCorruptTo: string | null = null;
      if (text !== null) {
        // Not a plain `renameSync`: on a read-only directory it throws a bare EACCES the caller
        // cannot tell from a bug, and falling through to `write()` would then overwrite the corrupt
        // file that is the user's only remaining recovery material.
        movedCorruptTo = uniqueCorruptName();
        try {
          renameSync(opts.file, movedCorruptTo);
        } catch (e) {
          throw new WorkspaceMoveAsideError(opts.file, e);
        }
      }
      ws = bak ?? emptyWorkspace();
      dirty = true;
      if (!write()) noteWriteFailure(problems);
      return { recovered: bak !== null ? 'bak' : 'fresh', movedCorruptTo, problems };
    },
    get: () => ws,
    update(mutate) {
      ws = mutate(ws);
      dirty = true;
      if (timer === null) timer = setTimeout(write, debounceMs);
      // Guarded individually: a throwing subscriber would otherwise escape `update()` into the
      // IPC handler and stop every later one — including the broadcast the renderer depends on.
      for (const l of listeners) {
        try {
          l(ws);
        } catch (e) {
          opts.log?.(`workspace subscriber threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        }
      }
      return ws;
    },
    flush: write,
    lastWriteError: () => writeError,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
