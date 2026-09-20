// A Linear ticket turned into a New Agent draft — spec 2026-09-15 (linear agent) §5.4–§5.5. Pure.
import { z } from 'zod';
import { stripUntrustedText, stripUntrustedTextKeepNewlines } from './agent-name.ts';
import { AGENT_NAME_MAX, AGENT_WORKSPACES_MAX, NOTE_MAX } from './constants.ts';
import { linearIssueUrl } from './linear-ref.ts';
import type { Folder, Id } from './types.ts';

/** How many unmatched picks `droppedRepos` lists; the dialog shows them on one muted line. */
export const DROPPED_REPOS_MAX = 8;
/** Each listed pick is cut to this many code points — a model can "pick" a path of any length. */
export const DROPPED_REPO_CHARS = 200;
/** A refusal message (the model's own `error`, or the identifier mismatch) is cut to this many code points. */
export const TRIAGE_ERROR_MAX = 300;

/**
 * A repository the triage may pick. `projectId` is set when it is already a Hangar project — every
 * registered project is a candidate whether or not it lives in the repos folder — and null for a git
 * repo found directly inside `config.reposDir` (`src/main/services/repo-discovery.ts`).
 */
export interface RepoCandidate {
  path: string;
  name: string;
  hint: string;
  projectId: Id | null;
}

export type DraftFolder = { kind: 'root' } | { kind: 'existing'; folderId: Id } | { kind: 'new'; name: string };

/** Base branches are always the project default (spec §5.5), so a row carries none. */
export type DraftRow = { kind: 'existing'; projectId: Id } | { kind: 'new'; repoPath: string; name: string };

/** What `linear:triage` answers with, and what `DialogState['new-agent'].draft` carries. */
export interface TicketDraft {
  name: string;
  folder: DraftFolder;
  rows: DraftRow[];
  notes: string;
  /** Picks that matched no candidate, shown as one muted warning line in the dialog. */
  droppedRepos: string[];
  /**
   * True for a draft `buildTicketDraft` made from a triage answer, false for `manualDraft`'s
   * "Continue manually". The dialog treats a manual draft as the plain New Agent dialog with only the
   * name prefilled (spec section 6): it seeds a first row, shows the "No projects yet" hint, and keeps
   * Start Claude immediately on.
   */
  fromTriage: boolean;
}

/**
 * Handed to `claude -p --json-schema`. Every field is required and `additionalProperties` is false,
 * so a well-behaved answer has exactly the shape `TriageOutputSchema` checks; `linear-draft.test.ts`
 * asserts the two name the same fields.
 */
export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'error', 'identifier', 'title', 'url', 'shortSummary', 'summary', 'cycle', 'repos'],
  properties: {
    found: { type: 'boolean' },
    error: { type: ['string', 'null'] },
    identifier: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    shortSummary: { type: 'string' },
    summary: { type: 'string' },
    cycle: {
      anyOf: [
        { type: 'object', additionalProperties: false, required: ['number'], properties: { number: { type: 'integer', minimum: 1 } } },
        { type: 'null' },
      ],
    },
    repos: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'reason'], properties: { path: { type: 'string' }, reason: { type: 'string' } } },
    },
  },
} as const;

/** The model's `structured_output`, checked rather than trusted — the ticket text it read is untrusted input (spec §9). */
export const TriageOutputSchema = z.object({
  found: z.boolean(),
  error: z.string().nullable(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  shortSummary: z.string(),
  summary: z.string(),
  // `.min(1)` rather than `.positive()`: for an integer they accept the same values, and `.min(1)` is
  // what `z.toJSONSchema` renders as `minimum: 1`, the spelling the hand-written schema uses.
  cycle: z.object({ number: z.number().int().min(1) }).nullable(),
  repos: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export type DraftResult = { ok: true; draft: TicketDraft } | { ok: false; message: string };

export function parseTriageOutput(raw: unknown): { ok: true; output: TriageOutput } | { ok: false; message: string } {
  const parsed = TriageOutputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, output: parsed.data };
  const issue = parsed.error.issues[0];
  // `map(String)`: zod types a path segment as PropertyKey, and `join` throws on a symbol.
  const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
  return { ok: false, message: `the answer did not have the expected shape (${where}${issue?.message ?? 'invalid'})` };
}

/**
 * One line of model text: C0 and C1 controls flattened, invisible format characters (bidi,
 * zero-width, tags — see `stripUntrustedText`) deleted, whitespace collapsed. Every model-derived
 * string goes through this or its multi-line sibling.
 */
const oneLine = (s: string): string => stripUntrustedText(s).replace(/\s+/g, ' ').trim();

/** The first `max` code points of `s` — never half a surrogate pair. */
const capChars = (s: string, max: number): string => (s.length <= max ? s : Array.from(s).slice(0, max).join(''));

/** `ref` as a RegExp source matching exactly that text. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const cycleFolderName = (n: number): string => `Cycle ${n}`;

/** The folder a `Cycle <n>` draft means: an existing TOP-LEVEL folder of exactly that name. */
export function findTopLevelFolder(folders: readonly Folder[], name: string): Folder | undefined {
  return folders.find((f) => f.parentId === null && f.name === name);
}

/**
 * `<ID> <shortSummary>`: control characters flattened, whitespace collapsed, and cut to
 * `AGENT_NAME_MAX` at a word boundary. Counted in code points, like `cleanAgentName`, so a cut can
 * never leave half a surrogate pair. The result always satisfies `AgentNameSchema`.
 */
export function composeAgentName(ref: string, shortSummary: string): string {
  // `ref` is normally `parseLinearRef`'s output, which needs no escaping — escaped anyway, so this
  // function is total for any string. `\b` stops `AC-3461` from eating the front of `AC-34610`.
  const summary = oneLine(shortSummary).replace(new RegExp(`^${escapeRegExp(ref)}\\b[\\s:—–-]*`, 'i'), '');
  const flat = oneLine(`${ref} ${summary}`);
  const chars = Array.from(flat);
  if (chars.length <= AGENT_NAME_MAX) return flat;
  const head = chars.slice(0, AGENT_NAME_MAX);
  if (chars[AGENT_NAME_MAX] === ' ') return head.join('').trim();
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).join('').trim();
}

interface PickedRepo {
  candidate: RepoCandidate;
  reason: string;
}

function draftFolder(cycle: TriageOutput['cycle'], folders: readonly Folder[]): DraftFolder {
  if (cycle === null) return { kind: 'root' };
  const name = cycleFolderName(cycle.number);
  const existing = findTopLevelFolder(folders, name);
  return existing ? { kind: 'existing', folderId: existing.id } : { kind: 'new', name };
}

/**
 * The model's `url` as `origin + pathname`, or null unless it is a Linear issue link to `ref`.
 *
 * The rule itself lives in `linear-ref.ts` now: the ticket list shows links too, and one rule has to
 * decide what a Linear issue link is. All this adds is the cleaning a model's answer needs first.
 */
function ticketUrl(raw: string, ref: string): string | null {
  return linearIssueUrl(oneLine(raw), ref);
}

function composeNotes(ref: string, output: TriageOutput, picked: readonly PickedRepo[]): string {
  const lines = [`${ref} — ${oneLine(output.title)}`];
  const url = ticketUrl(output.url, ref);
  if (url !== null) lines.push(url);
  const summary = stripUntrustedTextKeepNewlines(output.summary).trim();
  if (summary !== '') lines.push('', summary);
  if (picked.length > 0) lines.push('', 'Projects:', ...picked.map((p) => `- ${p.candidate.name} — ${p.reason}`));
  // `agent:update` validates notes with zod's `.max(NOTE_MAX)`, which counts code points (zod 4.5),
  // so the cap is in code points too — which is also what keeps a surrogate pair whole.
  return capChars(lines.join('\n'), NOTE_MAX);
}

/**
 * Spec §5.5. `ref` is the identifier the user asked for (already canonical); `candidates` is exactly
 * what the prompt listed; `folders` is the workspace's folder list.
 */
export function buildTicketDraft(output: TriageOutput, ctx: { ref: string; candidates: readonly RepoCandidate[]; folders: readonly Folder[] }): DraftResult {
  const refuse = (message: string): DraftResult => ({ ok: false, message: capChars(message, TRIAGE_ERROR_MAX).trim() });
  if (!output.found) return refuse(oneLine(output.error ?? '') || 'the ticket could not be found');
  if (output.identifier.trim().toUpperCase() !== ctx.ref.toUpperCase()) {
    return refuse(`Looked up ${ctx.ref} but got ${oneLine(output.identifier) || 'no identifier'}`);
  }

  // Matched on the RAW path, exactly as the prompt listed it; cleaning is only for what is shown.
  const byPath = new Map(ctx.candidates.map((c) => [c.path, c] as const));
  const picked: PickedRepo[] = [];
  const pickedPaths = new Set<string>();
  const dropped = new Set<string>();
  for (const repo of output.repos) {
    const candidate = byPath.get(repo.path);
    if (candidate === undefined) {
      const shown = capChars(oneLine(repo.path), DROPPED_REPO_CHARS).trim();
      // A path that cleans to nothing would be a blank entry on the warning line.
      if (shown !== '' && dropped.size < DROPPED_REPOS_MAX) dropped.add(shown);
    } else if (!pickedPaths.has(candidate.path)) {
      pickedPaths.add(candidate.path);
      picked.push({ candidate, reason: oneLine(repo.reason) });
    }
  }
  const droppedRepos = [...dropped];
  // Registered first, each group in the model's order, THEN the cap — so a ninth pick is the one lost.
  const ordered = [...picked.filter((p) => p.candidate.projectId !== null), ...picked.filter((p) => p.candidate.projectId === null)].slice(0, AGENT_WORKSPACES_MAX);
  const rows = ordered.map(({ candidate }): DraftRow => (
    candidate.projectId !== null ? { kind: 'existing', projectId: candidate.projectId } : { kind: 'new', repoPath: candidate.path, name: candidate.name }
  ));

  return {
    ok: true,
    draft: {
      name: composeAgentName(ctx.ref, output.shortSummary),
      folder: draftFolder(output.cycle, ctx.folders),
      rows,
      notes: composeNotes(ctx.ref, output, ordered),
      droppedRepos,
      fromTriage: true,
    },
  };
}

/** What "Continue manually" opens (spec §3.5): the identifier as the name, or empty when the input did not parse. */
export function manualDraft(identifier: string | null): TicketDraft {
  return { name: identifier ?? '', folder: { kind: 'root' }, rows: [], notes: '', droppedRepos: [], fromTriage: false };
}
