/**
 * Spec §12.6's four dialogs. Until Task 8 these were the missing half of the app: `New agent`,
 * `New folder`, `Add project…` and `Delete…` all set `ui.dialog` from the menus and nothing
 * rendered it.
 *
 * The two standing renderer hazards are both live here, and dialogs are the worst place for the
 * first of them:
 *
 * **G59** — every one of these subscribes to a zustand store and is full of derived lists
 * (projects, folders, branches, workspaces). zustand 5 hands the selector to
 * `useSyncExternalStore`, which needs a referentially stable snapshot; measured on this project
 * three times at ~55 renders before React throws. Each dialog gets a commit count on a real React
 * root under a `<Profiler>`, with a deliberately-allocating control that proves the probe is not
 * blind.
 *
 * **G60** — a test that mounts a component alone cannot see an ANCESTOR handler stealing its
 * events. The last block dispatches REAL bubbling events at the deepest node through the whole
 * mounted `App`.
 */
import { act, Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_COMMAND_MAX, AGENT_WORKSPACES_MAX } from '../../../../shared/constants.ts';
import {
  LINEAR_CREATE_UNCONFIRMED,
  type DeleteInspection, type HangarBridge, type IpcEventKey, type IpcEvents, type IpcReply,
  type IpcRequestKey, type IpcRequests, type ProgressEvent,
} from '../../../../shared/ipc-contract.ts';
import { IpcSchemas } from '../../../../shared/ipc-schemas.ts';
import { manualDraft, type TicketDraft } from '../../../../shared/linear-draft.ts';
import type { LinearCycle, LinearIssue } from '../../../../shared/linear-issues.ts';
import {
  defaultAppConfig, defaultLayout, defaultProjectSetup, emptyWorkspace, initialSessionState,
  type Agent, type AppConfig, type Folder, type Layout, type Project, type SessionState, type Workspace,
  type WorkspaceSnapshot,
} from '../../../../shared/types.ts';

const ISO = '2026-09-07T10:00:00.000Z';

const project = (id: string, name: string, patch: Partial<Project> = {}): Project => ({
  id, name, repoPath: `/repos/${name}`, defaultBranch: 'main', setup: defaultProjectSetup(), claudeArgs: [], createdAt: ISO, ...patch,
});

const agent = (id: string, name: string, patch: Partial<Agent> = {}): Agent => ({
  id, name, slug: name.toLowerCase(), folderId: null, sortKey: 0,
  workspaces: [{ id: `w-${id}`, projectId: 'p1', branch: `agent/${name}`, worktreePath: `/wt/${name}`, baseRef: 'main', createdAt: ISO }],
  notes: '', claude: { sessionId: `s-${id}`, hasStartedOnce: false, permissionMode: null, extraArgs: [] },
  createdAt: ISO, lastOpenedAt: null, ...patch,
});

const FOLDERS: Folder[] = [
  { id: 'f1', name: 'Work', parentId: null, sortKey: 0, collapsed: false },
  { id: 'f2', name: 'Spikes', parentId: null, sortKey: 1, collapsed: false },
];

const PROJECTS: Project[] = [
  project('p1', 'hangar', {
    setup: { fetchBeforeBranch: true, copyPatterns: ['.env'], cloneDirs: ['node_modules'], postCreate: 'npm ci' },
    actions: [{ label: 'Tests', command: 'npm test' }],
  }),
  project('p2', 'acmeapi', { defaultBranch: 'master' }),
];

const AGENTS: Agent[] = [agent('a1', 'alpha', { folderId: 'f1' }), agent('a2', 'beta')];

/** The agent `agent:create` answers with in these tests. */
const CREATED = agent('new1', 'Smoke test');

/** A triage draft as `linear:triage` would hand it over: one registered project, one repo to register, a cycle folder to create. */
const DRAFT: TicketDraft = {
  name: 'AC-3461 0 click payments',
  folder: { kind: 'new', name: 'Cycle 32' },
  rows: [{ kind: 'existing', projectId: 'p2' }, { kind: 'new', repoPath: '/repos/acme-frontend', name: 'acme-frontend' }],
  notes: 'AC-3461 — 0 Click Payments\nhttps://linear.app/acme/issue/AC-3461\n\nCharge a saved card.',
  droppedRepos: ['/elsewhere/legacy-api'],
  fromTriage: true,
};

/** Two pages of the owner's tickets, as `linear:myIssues` answers with them. */
const team = { teamId: 'tu1', teamName: 'Acme' };
const ISSUES: LinearIssue[] = [
  { identifier: 'AC-3461', title: '0 Click Payments', state: 'Todo', stateType: 'unstarted', ...team, cycleId: 'cy-1', cycleNumber: 32, updatedAt: ISO, url: 'https://linear.app/acme/issue/AC-3461' },
  { identifier: 'AC-3400', title: 'Refund misclassification', state: 'Done', stateType: 'completed', ...team, cycleId: 'cy-0', cycleNumber: 31, updatedAt: ISO, url: '' },
  { identifier: 'AC-3399', title: 'Cancelled experiment', state: 'Cancelled', stateType: 'canceled', ...team, cycleId: null, cycleNumber: null, updatedAt: ISO, url: '' },
];
const MORE: LinearIssue[] = [...ISSUES, { identifier: 'AC-3200', title: 'Older thing', state: 'Backlog', stateType: 'backlog', ...team, cycleId: null, cycleNumber: null, updatedAt: ISO, url: '' }];

/** What `project:add` registers for DRAFT's second row. */
const FRONTEND = project('p3', 'acme-frontend', { defaultBranch: 'stage' });

function snapshotWith(layout: Partial<Layout> = {}, patch: Partial<WorkspaceSnapshot['workspace']> = {}): WorkspaceSnapshot {
  return {
    workspace: {
      ...emptyWorkspace(),
      projects: PROJECTS,
      folders: FOLDERS,
      agents: AGENTS,
      layout: { ...defaultLayout(), panes: [null], focusedIndex: 0, ...layout },
      ...patch,
    },
    sessions: {},
    runtime: {},
    host: { connected: true, version: '1', sessions: 0, socketPath: '/s', nodeBin: '/n', lastError: null },
    profile: { home: '/h', isDefault: true },
  };
}

interface Call { channel: IpcRequestKey; payload: unknown }

/**
 * One stubbed request. `gate` is how a test holds a call IN FLIGHT — the New Agent progress list
 * only exists between "Create was clicked" and "`agent:create` answered", so the events that
 * populate it have to be emitted inside that window.
 *
 * Typed per key off `IpcRequests`, with no `as unknown as` escape hatch (Plan 02's standing rule):
 * a stub whose value does not match the contract fails to compile here.
 */
interface Stub<K extends IpcRequestKey> {
  reply: IpcReply<IpcRequests[K]['res']>;
  gate?: Promise<unknown>;
}
type Stubs = { [K in IpcRequestKey]?: Stub<K> };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => { resolve = () => r(); });
  return { promise, resolve };
}

/**
 * `lib/api.ts` reads `window.hangar` at module-evaluation time, so the bridge has to exist before
 * anything is imported — the `vi.resetModules()` dance every renderer test in this project uses.
 * It also gives each test FRESH stores, which is what keeps them independent.
 */
async function load(stubs: Stubs) {
  const calls: Call[] = [];
  const listeners = new Map<string, ((payload: never) => void)[]>();
  const bridge: HangarBridge = {
    invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
      calls.push({ channel, payload: args[0] });
      const stub = stubs[channel];
      if (stub === undefined) return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
      return stub.gate === undefined ? Promise.resolve(stub.reply) : stub.gate.then(() => stub.reply);
    },
    on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
      const erased = handler as (payload: never) => void;
      const list = listeners.get(channel) ?? [];
      list.push(erased);
      listeners.set(channel, list);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== erased));
    },
  };
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  /**
   * Changes an answer BETWEEN calls, which a fixed `stubs` map cannot: `Load more` sends the same
   * request twice and the second answer is a longer list. `invoke` reads `stubs[channel]` per call,
   * so replacing the entry is all it takes.
   */
  const setStub = <K extends IpcRequestKey>(channel: K, stub: Stub<K>): void => {
    // `Stubs` is a MAPPED type, so `stubs[channel] = stub` under a generic `K` is a TS2322 — the
    // compiler widens the write target to the INTERSECTION of every key's stub type. The write is
    // sound (key and value are the same `K`) and narrowing the view to that one key is all this
    // assertion says; the per-key checking callers get from `Stub<K>` is untouched.
    (stubs as Record<K, Stub<K>>)[channel] = stub;
  };
  vi.resetModules();
  const [host, newAgent, newFolder, settings, del, addWs, removeWs, linear, cycleRun, { App }, workspace, layout, ui, sessions, config] = await Promise.all([
    import('./DialogHost.tsx'),
    import('./NewAgentDialog.tsx'),
    import('./NewFolderDialog.tsx'),
    import('./ProjectSettingsDialog.tsx'),
    import('./DeleteAgentDialog.tsx'),
    import('./AddWorkspaceDialog.tsx'),
    import('./RemoveWorkspaceDialog.tsx'),
    import('./LinearDialog.tsx'),
    import('./CycleRun.tsx'),
    import('../../App.tsx'),
    import('../../stores/workspace.ts'),
    import('../../stores/layout.ts'),
    import('../../stores/ui.ts'),
    import('../../stores/sessions.ts'),
    import('../../stores/config.ts'),
  ]);
  const emit = <K extends IpcEventKey>(channel: K, payload: IpcEvents[K]): void => {
    act(() => {
      for (const h of listeners.get(channel) ?? []) (h as (p: IpcEvents[K]) => void)(payload);
    });
  };
  return { ...host, ...newAgent, ...newFolder, ...settings, ...del, ...addWs, ...removeWs, ...linear, ...cycleRun, App, workspace, layout, ui, sessions, config, calls, emit, setStub };
}

/** The common case: a snapshot already in the stores, no `App`, no bootstrap. */
async function withSnapshot(stubs: Stubs, snap: WorkspaceSnapshot = snapshotWith()) {
  const t = await load(stubs);
  t.workspace.useWorkspace.getState().setSnapshot(snap);
  t.layout.layoutStore.getState().hydrate(snap.workspace.layout);
  return t;
}

let container: HTMLDivElement;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  container.remove();
});

/** Mounts `node` and returns the host element plus a live count of subtree COMMITS. */
function mount(node: ReactNode): { el: HTMLElement; commits: () => number } {
  return mountWith((n) => n, node);
}

/**
 * The same under `<StrictMode>` — a separate helper rather than `mount(<StrictMode>…</StrictMode>)`,
 * because StrictMode only double-invokes EFFECTS when it is the OUTERMOST element handed to
 * `root.render()` (G65). Measured on React 19.2.8 by `components/strict-mode-nesting.test.tsx`,
 * which re-runs the comparison on every suite run:
 *
 *   root.render(<StrictMode><Profiler><P/></Profiler></StrictMode>)  → effects 2, updaters 2
 *   root.render(<Profiler><StrictMode><P/></StrictMode></Profiler>)  → effects 1, updaters 2
 *
 * The second line is the spelling this file used until the G65 correction. Render and state
 * updaters stayed doubled either way, so the allocating-selector detection below was doing its
 * stated job throughout; what was switched off was the double-MOUNT half — the one that catches
 * double-subscribe, double-fetch and double-attach. `FilesTab.test.tsx`'s `mountStrict` is the
 * reference shape.
 */
function mountStrict(node: ReactNode): { el: HTMLElement; commits: () => number } {
  return mountWith((n) => <StrictMode>{n}</StrictMode>, node);
}

function mountWith(shell: (n: ReactNode) => ReactNode, node: ReactNode): { el: HTMLElement; commits: () => number } {
  const el = document.createElement('div');
  container.appendChild(el);
  let commits = 0;
  const root = createRoot(el);
  roots.push(root);
  // The commit counter goes INSIDE the shell, so `<StrictMode>` stays the outermost element handed
  // to `root.render()` — that placement is what decides whether effects double-invoke at all.
  act(() => root.render(shell(<Profiler id="probe" onRender={() => { commits += 1; }}>{node}</Profiler>)));
  return { el, commits: () => commits };
}

/** Lets a pending IPC reply and the state update it causes settle. */
const flush = async (): Promise<void> => { await act(async () => undefined); };

/**
 * `flush` for a SEQUENCE of round trips. The ticket-draft Create awaits up to four requests one after
 * another (project:add → folder:create → agent:create → agent:update), and one `act` turn is not
 * guaranteed to drain all four chains. Ten turns is far more than they need and costs nothing when
 * there is less to do.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await flush();
};

/**
 * Types into a CONTROLLED field the way a browser does. React installs its own value setter on
 * the element, so assigning `.value` directly is invisible to it — the native prototype setter
 * has to run before the event, or `onChange` sees the stale value.
 */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(el: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('nothing to click');
  act(() => (el as HTMLElement).click());
};

const button = (el: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}" in: ${[...el.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
  return found;
};
const maybeButton = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

const field = (el: HTMLElement, label: string): HTMLInputElement => {
  const found = el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`no field "${label}"`);
  return found;
};

const picker = (el: HTMLElement, label: string): HTMLSelectElement => {
  const found = el.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`no select "${label}"`);
  return found;
};

const payloadsFor = (calls: Call[], channel: IpcRequestKey): unknown[] =>
  calls.filter((c) => c.channel === channel).map((c) => c.payload);

/**
 * The Delete/Remove dialogs' "Delete branch" box while the worktree is kept: disabled, its label
 * dimmed, and pointing at the hint that says why through `aria-describedby` — a disabled control
 * with no stated reason reads as broken. With the worktree removed again, none of that remains.
 */
function expectBranchHint(box: HTMLInputElement, shown: boolean): void {
  const hintId = box.getAttribute('aria-describedby');
  if (shown) {
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId ?? '')?.textContent).toContain('still has it checked out');
    expect(box.closest('label')?.className).toContain('opacity-50');
  } else {
    expect(hintId).toBeNull();
    expect(box.closest('label')?.className).not.toContain('opacity-50');
  }
}

const ev = (step: string, status: ProgressEvent['status'], patch: Partial<ProgressEvent> = {}): ProgressEvent => ({
  agentId: CREATED.id, opId: 'op1', step, status, message: `${step} ${status}`, ...patch,
});

const inspection = (patch: Partial<DeleteInspection['workspaces'][number]> = {}): DeleteInspection => ({
  workspaces: [{
    workspaceId: 'w-a1', branch: 'agent/alpha', worktreePath: '/wt/alpha',
    dirtyFiles: 0, unmergedCommits: 0, worktreeMissing: false, inspectionFailed: false, ...patch,
  }],
});

/** An agent with two workspaces for the Remove project dialog: `w1` on hangar (primary), `w2` on acmeapi. */
const GAMMA = agent('a3', 'gamma', {
  workspaces: [
    { id: 'w1', projectId: 'p1', branch: 'agent/gamma', worktreePath: '/wt/g1', baseRef: 'main', createdAt: ISO },
    { id: 'w2', projectId: 'p2', branch: 'agent/gamma', worktreePath: '/wt/g2', baseRef: 'main', createdAt: ISO },
  ],
});

const secondInspection = (patch: Partial<DeleteInspection['workspaces'][number]> = {}): DeleteInspection => ({
  workspaces: [{
    workspaceId: 'w2', branch: 'agent/gamma', worktreePath: '/wt/g2',
    dirtyFiles: 0, unmergedCommits: 0, worktreeMissing: false, inspectionFailed: false, ...patch,
  }],
});

// ────────────────────────────────────────────────────────────────────────────────────────────

describe('DialogHost', () => {
  it('renders nothing at all while no dialog is open', async () => {
    const t = await withSnapshot({});
    const { el } = mount(<t.DialogHost />);
    expect(el.querySelector('dialog')).toBeNull();
  });

  it('renders each dialog kind, and swaps between them', async () => {
    const t = await withSnapshot({ 'agent:inspectDelete': { reply: { ok: true, value: inspection() } } });
    const { el } = mount(<t.DialogHost />);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    expect(el.querySelector('h2')?.textContent).toBe('New folder');
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null }));
    expect(el.querySelector('h2')?.textContent).toBe('New agent');
    act(() => t.ui.useUi.getState().openDialog({ kind: 'project-settings', projectId: 'p1' }));
    expect(el.querySelector('h2')?.textContent).toBe('Project: hangar');
    act(() => t.ui.useUi.getState().openDialog({ kind: 'delete-agent', agentId: 'a1' }));
    await flush();
    expect(el.querySelector('h2')?.textContent).toBe('Delete alpha');
    act(() => t.ui.useUi.getState().openDialog({ kind: 'add-workspace', agentId: 'a1' }));
    expect(el.querySelector('h2')?.textContent).toBe('Add a project to alpha');
    act(() => t.ui.useUi.getState().openDialog({ kind: 'remove-workspace', agentId: 'a1', workspaceId: 'w-a1' }));
    expect(el.querySelector('h2')?.textContent).toBe('Remove hangar from alpha');
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    expect(el.querySelector('h2')?.textContent).toBe('New agent from a Linear ticket');
    act(() => t.ui.useUi.getState().closeDialog());
    expect(el.querySelector('dialog')).toBeNull();
  });

  // Task 8 asserted only that the `host-panel` STUB rendered nothing; Task 9 made it a real
  // dialog, so this now says the switch reaches it. Its own behaviour lives in `status.test.tsx`.
  it('renders the host panel', async () => {
    const t = await withSnapshot({});
    const { el } = mount(<t.DialogHost />);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'host-panel' }));
    expect(el.querySelector('h2')?.textContent).toBe('Session host');
  });

  /**
   * `Dialog.tsx` calls `showModal()` on mount, which jsdom 30 does not implement (see
   * `test-setup.ts`). If the stub there ever stops being installed this is the test that says so,
   * rather than every dialog test failing with `d.showModal is not a function`.
   */
  it('actually opens the native <dialog>', async () => {
    const t = await withSnapshot({});
    const { el } = mount(<t.DialogHost />);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    expect(el.querySelector('dialog')?.open).toBe(true);
  });
});

describe('New folder', () => {
  it('offers Root plus every folder, and preselects the one the menu named', async () => {
    const t = await withSnapshot({});
    const { el } = mount(<t.NewFolderDialog parentId="f2" />);
    const select = el.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Root', 'Work', 'Spikes']);
    expect(select.value).toBe('f2');
  });

  /**
   * The bounds are `FolderNameSchema`'s, the same ones `folder:create` validates with — not a
   * hand-rolled `length > 0`. `shared/workspace-schema.ts`'s own comment records that copies of
   * these rules have drifted before.
   */
  it('keeps Create disabled until the name is one folder:create would accept', async () => {
    const t = await withSnapshot({});
    const { el } = mount(<t.NewFolderDialog parentId={null} />);
    const input = el.querySelector('input') as HTMLInputElement;
    expect(button(el, 'Create').disabled).toBe(true);
    type(input, '   ');
    expect(button(el, 'Create').disabled).toBe(true);
    type(input, 'x'.repeat(81));
    expect(button(el, 'Create').disabled).toBe(true);
    type(input, 'Experiments');
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('creates the folder with a trimmed name and closes', async () => {
    const t = await withSnapshot({ 'folder:create': { reply: { ok: true, value: FOLDERS[0]! } } });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    const { el } = mount(<t.DialogHost />);
    type(el.querySelector('input') as HTMLInputElement, '  Experiments  ');
    const select = el.querySelector('select') as HTMLSelectElement;
    choose(select, 'f1');
    click(button(el, 'Create'));
    await flush();
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([{ name: 'Experiments', parentId: 'f1' }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  it('stays open when the create fails', async () => {
    const t = await withSnapshot({});
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    const { el } = mount(<t.DialogHost />);
    type(el.querySelector('input') as HTMLInputElement, 'Experiments');
    click(button(el, 'Create'));
    await flush();
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
  });
});

describe('New agent — the form', () => {
  const branchStub: Stubs = { 'project:listBranches': { reply: { ok: true, value: { local: ['main', 'wip'], remote: ['origin/main', 'origin/release', 'origin'] } } } };

  it('previews the branch the slug will produce, live', async () => {
    const t = await withSnapshot(branchStub);
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    expect(el.textContent).toContain('Describe the task');
    type(el.querySelector('input') as HTMLInputElement, 'AcmeApi: fix Billing webhook retries');
    expect(el.textContent).toContain('branch: agent/acmeapi-fix-billing-webhook-retries');
  });

  it('preselects the folder the caller named and lists the setup that will run', async () => {
    const t = await withSnapshot(branchStub);
    const { el } = mount(<t.NewAgentDialog folderId="f1" />);
    expect(picker(el, 'Folder').value).toBe('f1');
    expect(el.textContent).toContain('fetch origin · copy .env · clone node_modules · then: npm ci');
  });

  /**
   * The datalist must offer BARE branch names. `project:listBranches` answers `origin/main`, but
   * `agent-service.baseRefFor` resolves the typed base as `refs/remotes/origin/<base>` and then
   * `refs/heads/<base>` — so the plan's `[...local, ...remote]` would have offered a value that
   * resolves to `refs/remotes/origin/origin/main` and fails BASE_NOT_FOUND every time.
   */
  it('offers base branches as names agent:create can actually resolve, fetched once per project', async () => {
    const t = await withSnapshot(branchStub);
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    await flush();
    expect([...el.querySelectorAll('#branches-0 option')].map((o) => (o as HTMLOptionElement).value))
      .toEqual(['main', 'wip', 'release']);
    // Typing in the base-branch box must not re-ask: the plan's version re-fetched on every
    // keystroke whenever the answer had been empty or had failed.
    type(field(el, 'Base branch 1'), 'r');
    type(field(el, 'Base branch 1'), 're');
    await flush();
    expect(payloadsFor(t.calls, 'project:listBranches')).toEqual([{ id: 'p1' }]);
  });

  // A repo with no branches at all, and a listBranches that rejects, are the two cases that made
  // the plan's "re-fetch until the list is non-empty" guard spin forever.
  it('asks once even when the answer is empty or the call fails', async () => {
    const empty = await withSnapshot({ 'project:listBranches': { reply: { ok: true, value: { local: [], remote: [] } } } });
    const a = mount(<empty.NewAgentDialog folderId={null} />);
    await flush();
    type(field(a.el, 'Base branch 1'), 'x');
    await flush();
    expect(payloadsFor(empty.calls, 'project:listBranches').length).toBe(1);

    const failing = await withSnapshot({});
    const b = mount(<failing.NewAgentDialog folderId={null} />);
    await flush();
    type(field(b.el, 'Base branch 1'), 'x');
    await flush();
    expect(payloadsFor(failing.calls, 'project:listBranches').length).toBe(1);
    expect(failing.ui.useUi.getState().toasts).toEqual([]);
  });

  it('rejects the same project twice, naming the later row', async () => {
    const t = await withSnapshot(branchStub);
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    type(el.querySelector('input') as HTMLInputElement, 'Two repos');
    click(button(el, '+ Add another project'));
    expect(el.textContent).toContain('Already chosen above');
    expect(button(el, 'Create').disabled).toBe(true);
    choose(picker(el, 'Project 2'), 'p2');
    expect(el.textContent).not.toContain('Already chosen above');
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('removes an extra row, and stops at agent:create\'s own cap of 8', async () => {
    const t = await withSnapshot(branchStub);
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    click(button(el, '+ Add another project'));
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(2);
    click(button(el, 'Remove'));
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(1);
    for (let i = 0; i < 7; i += 1) click(button(el, '+ Add another project'));
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(8);
    expect(button(el, '+ Add another project').disabled).toBe(true);
  });

  it('sends what the user chose, with an empty base branch as null', async () => {
    const t = await withSnapshot({ ...branchStub, 'agent:create': { reply: { ok: true, value: CREATED } }, 'agent:markOpened': { reply: { ok: true, value: undefined } }, 'layout:set': { reply: { ok: true, value: undefined } } });
    const { el } = mount(<t.NewAgentDialog folderId="f1" />);
    type(el.querySelector('input') as HTMLInputElement, '  Smoke test  ');
    click(button(el, '+ Add another project'));
    choose(picker(el, 'Project 2'), 'p2');
    type(field(el, 'Base branch 2'), ' release ');
    choose(picker(el, 'Permission mode'), 'plan');
    click(el.querySelector('input[type="checkbox"]'));
    click(button(el, 'Create'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:create')).toEqual([{
      name: 'Smoke test',
      folderId: 'f1',
      workspaces: [{ projectId: 'p1', baseBranch: null }, { projectId: 'p2', baseBranch: 'release' }],
      permissionMode: 'plan',
      startNow: false,
    }]);
  });

  it('says so, rather than showing an empty picker, when there are no projects yet', async () => {
    const t = await withSnapshot({}, snapshotWith({}, { projects: [], agents: [] }));
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    expect(el.textContent).toContain('No projects yet');
    expect(button(el, '+ Add another project').disabled).toBe(true);
    type(el.querySelector('input') as HTMLInputElement, 'Nowhere to run');
    expect(button(el, 'Create').disabled).toBe(true);
  });

  // "Add project…" from inside this dialog is the one way `projects` grows under it. The row list
  // is seeded lazily at mount, so without the re-seed effect the first project added would be
  // unusable until the dialog was closed and reopened.
  it('picks up a project added while it is open', async () => {
    const t = await withSnapshot({}, snapshotWith({}, { projects: [], agents: [] }));
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { agents: [] })));
    await flush();
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(1);
    expect(el.textContent).not.toContain('No projects yet');
  });

  it('reuses AgentNameSchema\'s bounds for the Create button', async () => {
    const t = await withSnapshot(branchStub);
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    const name = el.querySelector('input') as HTMLInputElement;
    expect(button(el, 'Create').disabled).toBe(true);
    type(name, '   ');
    expect(button(el, 'Create').disabled).toBe(true);
    type(name, 'x'.repeat(81));
    expect(button(el, 'Create').disabled).toBe(true);
    type(name, 'ok');
    expect(button(el, 'Create').disabled).toBe(false);
  });
});

/**
 * Spec §12.6: "**Create** → dialog turns into a progress list (one line per step from
 * `agent:progress`, spinner / ✓ / ⚠ / ✗, expandable log for postCreate). On success the dialog
 * closes and the agent opens in the focused pane (or a new pane if the focused one is occupied and
 * < 4 panes). On fatal error the dialog stays with the failing step highlighted and *Retry* /
 * *Close* (rollback already performed)."
 *
 * `gate` holds `agent:create` in flight so the events can be emitted in the window where the
 * progress list actually lives.
 */
describe('New agent — the progress list', () => {
  const okStubs = (gate?: Promise<unknown>): Stubs => ({
    'project:listBranches': { reply: { ok: true, value: { local: ['main'], remote: [] } } },
    'agent:create': { reply: { ok: true, value: CREATED }, gate },
    'agent:markOpened': { reply: { ok: true, value: undefined } },
    'layout:set': { reply: { ok: true, value: undefined } },
  });

  const failStubs = (gate?: Promise<unknown>): Stubs => ({
    ...okStubs(gate),
    'agent:create': { reply: { ok: false, error: { code: 'BASE_NOT_FOUND', message: 'hangar: branch "nope" was not found locally or on origin', detail: 'git rev-parse --verify' } }, gate },
  });

  async function startCreate(stubs: Stubs, snap = snapshotWith()) {
    const t = await withSnapshot(stubs, snap);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null }));
    const { el } = mount(<t.DialogHost />);
    type(el.querySelector('input') as HTMLInputElement, 'Smoke test');
    click(button(el, 'Create'));
    return { t, el };
  }

  const steps = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('li[data-step]')].map((li) => `${li.getAttribute('data-status')} ${li.getAttribute('data-step')}`);

  it('replaces the form with one line per step, upserting rather than appending', async () => {
    const gate = deferred();
    const { t, el } = await startCreate(okStubs(gate.promise));
    expect(el.querySelector('input[aria-label="Base branch 1"]')).toBeNull();
    t.emit('agent:progress', ev('hangar: fetch', 'running'));
    t.emit('agent:progress', ev('hangar: fetch', 'done'));
    t.emit('agent:progress', ev('hangar: worktree', 'running'));
    expect(steps(el)).toEqual(['done hangar: fetch', 'running hangar: worktree']);
    expect(el.textContent).toContain('✓');
    expect(el.textContent).toContain('…');
    gate.resolve();
    await flush();
  });

  it('shows postCreate output in a collapsed log', async () => {
    const gate = deferred();
    const { t, el } = await startCreate(okStubs(gate.promise));
    t.emit('agent:progress', ev('hangar: postCreate', 'done', { log: '$ npm ci\nadded 400 packages' }));
    const details = el.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('added 400 packages');
    gate.resolve();
    await flush();
  });

  it('closes, toasts and opens the agent in the focused EMPTY pane', async () => {
    const { t } = await startCreate(okStubs(), snapshotWith({ panes: [null], focusedIndex: 0 }));
    await flush();
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Created Smoke test']);
    expect(t.layout.layoutStore.getState().layout.panes).toEqual([CREATED.id]);
    expect(payloadsFor(t.calls, 'agent:markOpened')).toEqual([{ id: CREATED.id }]);
  });

  // Spec §12.6's parenthesis. `openAgent(id, false)` — what the plan called — would have replaced
  // the agent the user is watching.
  it('opens it in a NEW pane when the focused one is occupied', async () => {
    const { t } = await startCreate(okStubs(), snapshotWith({ panes: ['a1'], focusedIndex: 0 }));
    await flush();
    const layout = t.layout.layoutStore.getState().layout;
    expect(layout.panes).toEqual(['a1', CREATED.id]);
    expect(layout.focusedIndex).toBe(1);
  });

  // …and falls back to the focused pane at four, without the "All four panes are in use" toast
  // that `openAgent(id, true)` would have raised alongside "Created …".
  it('falls back to the focused pane when all four are taken', async () => {
    const { t } = await startCreate(okStubs(), snapshotWith({ panes: ['a1', 'a2', null, null], focusedIndex: 0 }));
    await flush();
    // The two empty slots are still panes, so the third one takes it; the point is that four
    // occupied panes never toast.
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2', CREATED.id, null]);
    const full = await startCreate(okStubs(), snapshotWith({ panes: ['a1', 'a2', 'a3', 'a4'], focusedIndex: 1 }));
    await flush();
    expect(full.t.layout.layoutStore.getState().layout.panes).toEqual(['a1', CREATED.id, 'a3', 'a4']);
    expect(full.t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Created Smoke test']);
  });

  /**
   * The mid-flight failure, in the exact shape `agent-service` produces it: the step that threw is
   * left on `running` and never gets a terminal event, `rollback` reports ✓ under it, and `failed`
   * carries the message. Without `failStalledSteps` the step spec §12.6 asks to highlight is the
   * one still showing a spinner.
   */
  it('highlights the failing step, keeps the dialog open, and offers Retry', async () => {
    const gate = deferred();
    const { t, el } = await startCreate(failStubs(gate.promise));
    t.emit('agent:progress', ev('hangar: fetch', 'done'));
    t.emit('agent:progress', ev('hangar: worktree', 'running'));
    t.emit('agent:progress', ev('rollback', 'done'));
    t.emit('agent:progress', ev('failed', 'error', { message: 'branch "nope" was not found' }));
    expect(steps(el)).toContain('running hangar: worktree');
    gate.resolve();
    await flush();
    expect(steps(el)).toEqual(['done hangar: fetch', 'error hangar: worktree', 'done rollback', 'error failed']);
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
    expect(el.textContent).toContain('was not found locally or on origin');
    expect(el.textContent).toContain('git rev-parse --verify');
    expect(maybeButton(el, 'Retry')).toBeDefined();
    expect(maybeButton(el, 'Close')).toBeDefined();
  });

  /**
   * A create that rejects before emitting a single step — an `ipc-schemas.ts` validation failure,
   * LOW_DISK, an unknown folder. Measured while writing this: with the progress screen shown only
   * for `busy || progress.length > 0`, the dialog fell back to the form, which renders no error,
   * and the failure vanished with no toast (the sink is suppressed so the message can land here).
   */
  it('shows a failure that arrived before any step did', async () => {
    const { t, el } = await startCreate(failStubs());
    await flush();
    expect(el.textContent).toContain('was not found locally or on origin');
    expect(maybeButton(el, 'Retry')).toBeDefined();
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  // Rollback already ran, so re-running the identical input is safe — and the previous attempt's
  // lines have to go, or the new op's steps read as a second copy of the old ones.
  it('Retry re-sends the same input and clears the failed attempt\'s lines', async () => {
    const { t, el } = await startCreate(failStubs());
    await flush();
    expect(payloadsFor(t.calls, 'agent:create').length).toBe(1);
    const gate = deferred();
    click(button(el, 'Retry'));
    expect(steps(el)).toEqual([]);
    t.emit('agent:progress', ev('hangar: fetch', 'running', { opId: 'op2' }));
    expect(steps(el)).toEqual(['running hangar: fetch']);
    await flush();
    gate.resolve();
    const sent = payloadsFor(t.calls, 'agent:create');
    expect(sent.length).toBe(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  // The other half: BASE_NOT_FOUND is a typo in a text field, and an identical Retry fails
  // identically. "Edit details" goes back to the form with every field still filled in.
  it('can go back to the form with the input intact', async () => {
    const { t, el } = await startCreate(failStubs());
    await flush();
    click(button(el, 'Edit details'));
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('Smoke test');
    expect(steps(el)).toEqual([]);
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
  });

  /**
   * The case that makes Retry WRONG. `createAgent` commits the record and emits `saved`, then
   * awaits `startAgent(id, 'auto')` with no catch — so `startNow` against a disconnected host
   * rejects `agent:create` for an agent that exists and was never rolled back. Offering Retry
   * there would create a second agent.
   */
  it('offers the created agent instead of Retry when only the start failed', async () => {
    const gate = deferred();
    const { t, el } = await startCreate({
      ...failStubs(gate.promise),
      'agent:create': { reply: { ok: false, error: { code: 'HOST_DOWN', message: 'the session host is not connected' } }, gate: gate.promise },
    });
    t.emit('agent:progress', ev('hangar: worktree', 'done'));
    t.emit('agent:progress', ev('saved', 'done', { message: 'agent created' }));
    gate.resolve();
    await flush();
    expect(maybeButton(el, 'Retry')).toBeUndefined();
    expect(maybeButton(el, 'Edit details')).toBeUndefined();
    expect(el.textContent).toContain('Retrying would create a second one');
    click(button(el, 'Open the agent'));
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.layout.layoutStore.getState().layout.panes).toEqual([CREATED.id]);
  });

  // The dialog must not be dismissable out from under a worktree that is half-made: `Dialog`'s
  // own close button and Escape are both wired to the same `onClose`.
  it('cannot be closed while the create is in flight', async () => {
    const gate = deferred();
    const { t, el } = await startCreate(okStubs(gate.promise));
    expect(button(el, 'Close').disabled).toBe(true);
    click(el.querySelector('button[aria-label="Close"]'));
    act(() => void (el.querySelector('dialog') as HTMLDialogElement).dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
    gate.resolve();
    await flush();
  });
});

/**
 * Spec 2026-09-15 §6–§7: the New Agent dialog opened with a `TicketDraft`. Without one the dialog is
 * unchanged — the two blocks above still run against the draft-less form, unmodified.
 */
describe('New agent — from a ticket draft', () => {
  const SEQUENCE: IpcRequestKey[] = ['project:add', 'folder:create', 'agent:create', 'agent:update'];
  const stubs = (patch: Stubs = {}): Stubs => ({
    'project:listBranches': { reply: { ok: true, value: { local: ['master'], remote: [] } } },
    'project:add': { reply: { ok: true, value: FRONTEND } },
    'folder:create': { reply: { ok: true, value: { id: 'f9', name: 'Cycle 32', parentId: null, sortKey: 2, collapsed: false } } },
    'agent:create': { reply: { ok: true, value: CREATED } },
    'agent:update': { reply: { ok: true, value: CREATED } },
    'agent:markOpened': { reply: { ok: true, value: undefined } },
    'layout:set': { reply: { ok: true, value: undefined } },
    ...patch,
  });

  async function open(s: Stubs, draft: TicketDraft = DRAFT, snap: WorkspaceSnapshot = snapshotWith()) {
    const t = await withSnapshot(s, snap);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null, draft }));
    const { el } = mount(<t.DialogHost />);
    await flush();
    return { t, el };
  }
  const notesBox = (el: HTMLElement): HTMLTextAreaElement | null => el.querySelector('textarea[aria-label="Notes"]');
  const sequenceOf = (calls: Call[]): IpcRequestKey[] => calls.map((c) => c.channel).filter((c) => SEQUENCE.includes(c));

  it('prefills the name, the new cycle folder, both rows, the notes and the ignored-repo line; Start is off', async () => {
    const { el } = await open(stubs());
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('AC-3461 0 click payments');
    const folderSelect = picker(el, 'Folder');
    expect([...folderSelect.options].map((o) => o.textContent)).toEqual(['Cycle 32 (new)', 'Root', 'Work', 'Spikes']);
    expect(folderSelect.selectedIndex).toBe(0);
    expect(picker(el, 'Project 1').value).toBe('p2');
    expect(el.querySelector('select[aria-label="Project 2"]')).toBeNull();
    expect(el.textContent).toContain('acme-frontend');
    expect(el.textContent).toContain('will be added');
    expect(field(el, 'Base branch 2').placeholder).toBe('base: detected when added');
    expect(notesBox(el)?.value).toBe(DRAFT.notes);
    expect(el.textContent).toContain('Ignored repos not in your repos folder: /elsewhere/legacy-api');
    // A dropped pick is an unbroken path of up to 200 characters; it must wrap inside the dialog.
    expect([...el.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Ignored repos'))?.className).toContain('break-all');
    expect((el.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('shows no Notes field and keeps Start on without a draft', async () => {
    const t = await withSnapshot(stubs());
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    expect(notesBox(el)).toBeNull();
    expect((el.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  // Spec §6: a draft with no rows means triage picked none, and seeding `projects[0]` would be a guess
  // the owner never saw being made.
  it('does not invent a first row for a draft that has none', async () => {
    const { el } = await open(stubs(), { ...DRAFT, rows: [], droppedRepos: [] });
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(0);
    expect(button(el, 'Create').disabled).toBe(true);
    click(button(el, '+ Add another project'));
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('lets a "will be added" row be removed, even from the primary slot', async () => {
    const { el } = await open(stubs(), { ...DRAFT, rows: [{ kind: 'new', repoPath: '/repos/acme-frontend', name: 'acme-frontend' }, { kind: 'existing', projectId: 'p2' }] });
    click(button(el, 'Remove'));
    expect(el.textContent).not.toContain('will be added');
    expect(picker(el, 'Project 1').value).toBe('p2');
  });

  it('adds the project, creates the folder, creates the agent, then saves the notes — in that order', async () => {
    const { t, el } = await open(stubs());
    click(button(el, 'Create'));
    await settle();
    expect(sequenceOf(t.calls)).toEqual(SEQUENCE);
    expect(payloadsFor(t.calls, 'project:add')).toEqual([{ repoPath: '/repos/acme-frontend' }]);
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([{ name: 'Cycle 32', parentId: null }]);
    expect(payloadsFor(t.calls, 'agent:create')).toEqual([{
      name: 'AC-3461 0 click payments',
      folderId: 'f9',
      // The new row's blank base branch becomes the added project's default branch (§7 step 1).
      workspaces: [{ projectId: 'p2', baseBranch: null }, { projectId: 'p3', baseBranch: 'stage' }],
      permissionMode: null,
      startNow: false,
    }]);
    expect(payloadsFor(t.calls, 'agent:update')).toEqual([{ id: CREATED.id, patch: { notes: DRAFT.notes } }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Created Smoke test']);
  });

  it('treats PROJECT_EXISTS as found, resolving the project from the snapshot by repoPath', async () => {
    const { t, el } = await open(
      stubs({ 'project:add': { reply: { ok: false, error: { code: 'PROJECT_EXISTS', message: 'project already added: /repos/acme-frontend' } } } }),
      DRAFT,
      snapshotWith({}, { projects: [...PROJECTS, FRONTEND] }),
    );
    click(button(el, 'Create'));
    await settle();
    expect(payloadsFor(t.calls, 'agent:create')).toMatchObject([{ workspaces: [{ projectId: 'p2', baseBranch: null }, { projectId: 'p3', baseBranch: 'stage' }] }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  it('stops at a repo that cannot be added, creating nothing after it, and Edit details keeps the draft', async () => {
    const { t, el } = await open(stubs({ 'project:add': { reply: { ok: false, error: { code: 'NOT_REPO_ROOT', message: '/repos/acme-frontend is not the top of a git repository' } } } }));
    click(button(el, 'Create'));
    await settle();
    expect(el.textContent).toContain('acme-frontend: /repos/acme-frontend is not the top of a git repository');
    expect(sequenceOf(t.calls)).toEqual(['project:add']);
    click(button(el, 'Edit details'));
    expect(notesBox(el)?.value).toBe(DRAFT.notes);
    expect(el.textContent).toContain('will be added');
  });

  it('uses a top-level folder of that name that appeared since the draft, and ignores a nested one', async () => {
    const appeared = await open(stubs(), DRAFT, snapshotWith({}, { folders: [...FOLDERS, { id: 'f3', name: 'Cycle 32', parentId: null, sortKey: 2, collapsed: false }] }));
    click(button(appeared.el, 'Create'));
    await settle();
    expect(payloadsFor(appeared.t.calls, 'folder:create')).toEqual([]);
    expect(payloadsFor(appeared.t.calls, 'agent:create')).toMatchObject([{ folderId: 'f3' }]);

    const nested = await open(stubs(), DRAFT, snapshotWith({}, { folders: [...FOLDERS, { id: 'f4', name: 'Cycle 32', parentId: 'f1', sortKey: 0, collapsed: false }] }));
    click(button(nested.el, 'Create'));
    await settle();
    expect(payloadsFor(nested.t.calls, 'folder:create')).toEqual([{ name: 'Cycle 32', parentId: null }]);
  });

  it('creates no folder when Root is chosen instead', async () => {
    const { t, el } = await open(stubs());
    choose(picker(el, 'Folder'), '');
    click(button(el, 'Create'));
    await settle();
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([]);
    expect(payloadsFor(t.calls, 'agent:create')).toMatchObject([{ folderId: null }]);
  });

  // §7 step 4: the agent exists by now, and rolling it back over a notes write would be the worse outcome.
  it('keeps the agent and toasts when only the notes could not be saved', async () => {
    const { t, el } = await open(stubs({ 'agent:update': { reply: { ok: false, error: { code: 'BAD_REQUEST', message: 'invalid payload for agent:update' } } } }));
    click(button(el, 'Create'));
    await settle();
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Agent created, but its notes could not be saved', 'Created Smoke test']);
    expect(t.layout.layoutStore.getState().layout.panes).toEqual([CREATED.id]);
  });

  it('skips the notes write when the notes were cleared', async () => {
    const { t, el } = await open(stubs());
    type(notesBox(el)!, '   ');
    click(button(el, 'Create'));
    await settle();
    expect(payloadsFor(t.calls, 'agent:update')).toEqual([]);
  });

  it('sends a base branch typed on a "will be added" row instead of the added project\'s default', async () => {
    const { t, el } = await open(stubs());
    type(field(el, 'Base branch 2'), ' release ');
    click(button(el, 'Create'));
    await settle();
    expect(payloadsFor(t.calls, 'agent:create')).toMatchObject([{ workspaces: [{ projectId: 'p2', baseBranch: null }, { projectId: 'p3', baseBranch: 'release' }] }]);
  });

  it('stops at a folder that cannot be created, showing why in the dialog rather than a toast', async () => {
    const { t, el } = await open(stubs({ 'folder:create': { reply: { ok: false, error: { code: 'BAD_REQUEST', message: 'invalid payload for folder:create' } } } }));
    click(button(el, 'Create'));
    await settle();
    expect(el.querySelector('pre')?.textContent).toBe('invalid payload for folder:create');
    expect(sequenceOf(t.calls)).toEqual(['project:add', 'folder:create']);
    expect(maybeButton(el, 'Retry')).toBeDefined();
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  // §7: what a failed attempt already made stays, and Retry finds it again instead of failing on it.
  it('Retry after a partial failure finds the project and the folder the first attempt made', async () => {
    const s = stubs({ 'agent:create': { reply: { ok: false, error: { code: 'LOW_DISK', message: 'not enough free space' } } } });
    const { t, el } = await open(s);
    click(button(el, 'Create'));
    await settle();
    expect(el.querySelector('pre')?.textContent).toBe('not enough free space');
    // Main now answers the second attempt as it would, and the snapshot it broadcast holds both.
    s['project:add'] = { reply: { ok: false, error: { code: 'PROJECT_EXISTS', message: 'project already added: /repos/acme-frontend' } } };
    s['agent:create'] = { reply: { ok: true, value: CREATED } };
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, {
      projects: [...PROJECTS, FRONTEND],
      folders: [...FOLDERS, { id: 'f9', name: 'Cycle 32', parentId: null, sortKey: 2, collapsed: false }],
    })));
    click(button(el, 'Retry'));
    await settle();
    expect(sequenceOf(t.calls)).toEqual(['project:add', 'folder:create', 'agent:create', 'project:add', 'agent:create', 'agent:update']);
    expect(payloadsFor(t.calls, 'agent:create')[1]).toMatchObject({ folderId: 'f9', workspaces: [{ projectId: 'p2', baseBranch: null }, { projectId: 'p3', baseBranch: 'stage' }] });
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /**
   * Spec §6, "Closing mid-create". ⌘N toggles a busy New Agent dialog shut (`installKeymap` closes
   * the dialog its own combo opened, busy or not), and the sequence runs on behind it. Measured
   * before the fix: the sequence's final `close()` shut whatever dialog was open by then, and a
   * failure after the close set state on an unmounted dialog — nothing on screen at all.
   */
  it('finishes a create after the dialog was closed without closing the dialog opened since', async () => {
    const gate = deferred();
    const { t, el } = await open(stubs({ 'project:add': { reply: { ok: true, value: FRONTEND }, gate: gate.promise } }));
    click(button(el, 'Create'));
    act(() => t.ui.useUi.getState().closeDialog());
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    gate.resolve();
    await settle();
    expect(sequenceOf(t.calls)).toEqual(SEQUENCE);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-folder', parentId: null });
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Created Smoke test']);
  });

  it('turns a failure after the dialog was closed into an error toast', async () => {
    const gate = deferred();
    const { t, el } = await open(stubs({
      'project:add': { reply: { ok: false, error: { code: 'NOT_REPO_ROOT', message: '/repos/acme-frontend is not the top of a git repository' } }, gate: gate.promise },
    }));
    click(button(el, 'Create'));
    act(() => t.ui.useUi.getState().closeDialog());
    gate.resolve();
    await settle();
    expect(sequenceOf(t.calls)).toEqual(['project:add']);
    expect(t.ui.useUi.getState().toasts).toMatchObject([{
      level: 'error',
      title: 'Could not create AC-3461 0 click payments',
      detail: 'acme-frontend: /repos/acme-frontend is not the top of a git repository',
      // Sticky: for a triage draft this toast is all that is left of what was looked up.
      sticky: true,
    }]);
  });

  // The closed dialog's own progress list is gone, so "not created" and "created, did not start" are
  // told apart by the sequence's own record — offering neither would hide an agent that exists.
  it('says the agent exists when only its start failed after the dialog was closed', async () => {
    const gate = deferred();
    const { t, el } = await open(stubs({
      'agent:create': { reply: { ok: false, error: { code: 'HOST_DOWN', message: 'the session host is not connected' } }, gate: gate.promise },
    }));
    click(button(el, 'Create'));
    await settle();
    expect(sequenceOf(t.calls)).toEqual(['project:add', 'folder:create', 'agent:create']);
    act(() => t.ui.useUi.getState().closeDialog());
    t.emit('agent:progress', ev('saved', 'done', { message: 'agent created' }));
    gate.resolve();
    await settle();
    expect(t.ui.useUi.getState().toasts).toMatchObject([{ level: 'error', title: 'Created AC-3461 0 click payments, but it could not be started', detail: 'the session host is not connected', sticky: true }]);
  });

  /**
   * ⌘N twice mid-create: close, then a fresh New Agent dialog. `agent:progress` is a broadcast, and
   * measured before the fix the fresh dialog took the earlier create's `saved` step as its own — the
   * form was replaced by a finished progress list with only Close on it, for good.
   */
  it("keeps a reopened dialog's form when the earlier create reports progress", async () => {
    const gate = deferred();
    const { t, el } = await open(stubs({ 'agent:create': { reply: { ok: true, value: CREATED }, gate: gate.promise } }));
    click(button(el, 'Create'));
    await settle();
    expect(sequenceOf(t.calls)).toEqual(['project:add', 'folder:create', 'agent:create']);
    act(() => t.ui.useUi.getState().closeDialog());
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null }));
    t.emit('agent:progress', ev('hangar: worktree', 'done'));
    t.emit('agent:progress', ev('saved', 'done', { message: 'agent created' }));
    expect(el.querySelector('li[data-step]')).toBeNull();
    expect(button(el, 'Create')).toBeDefined();
    gate.resolve();
    await settle();
    // The earlier create finished behind it, and neither closed it nor reached its form.
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });
    expect(el.querySelector('li[data-step]')).toBeNull();
    expect(button(el, 'Create')).toBeDefined();
  });
});

/**
 * Spec 2026-09-15 §6 (decided at Task 11 review): only a TRIAGE draft changes how the form behaves.
 * A manual draft — "Continue manually" — is the plain dialog with the name prefilled.
 */
describe('New agent — manual and triage drafts', () => {
  const MANUAL = manualDraft('AC-3461');
  const emptyWorkspace = (): WorkspaceSnapshot => snapshotWith({}, { projects: [], agents: [] });
  const startBox = (el: HTMLElement): HTMLInputElement => el.querySelector('input[type="checkbox"]') as HTMLInputElement;

  it('opens a manual draft as the plain dialog with the name filled in', async () => {
    const t = await withSnapshot({});
    const { el } = mount(<t.NewAgentDialog folderId={null} draft={MANUAL} />);
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('AC-3461');
    expect(picker(el, 'Project 1').value).toBe('p1');
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(1);
    expect(picker(el, 'Folder').value).toBe('');
    expect(startBox(el).checked).toBe(true);
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('shows a manual draft in an empty workspace the "No projects yet" hint, and seeds the first project added', async () => {
    const t = await withSnapshot({}, emptyWorkspace());
    const { el } = mount(<t.NewAgentDialog folderId={null} draft={MANUAL} />);
    expect(el.textContent).toContain('No projects yet');
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { agents: [] })));
    await flush();
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(1);
    expect(el.textContent).not.toContain('No projects yet');
  });

  it('keeps a row-less triage draft row-less when a project appears, hinting only while there are none', async () => {
    const t = await withSnapshot({}, emptyWorkspace());
    const { el } = mount(<t.NewAgentDialog folderId={null} draft={{ ...DRAFT, rows: [], droppedRepos: [] }} />);
    expect(el.textContent).toContain('No projects yet');
    expect(startBox(el).checked).toBe(false);
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { agents: [] })));
    await flush();
    expect(el.querySelectorAll('select[aria-label^="Project "]').length).toBe(0);
    expect(el.textContent).not.toContain('No projects yet');
  });

  // Nothing registered yet is the normal first use for a triage draft; its rows are the repos to add.
  it('shows no hint for a triage draft whose rows are all still to be added', async () => {
    const t = await withSnapshot({}, emptyWorkspace());
    const { el } = mount(<t.NewAgentDialog folderId={null} draft={{ ...DRAFT, rows: [{ kind: 'new', repoPath: '/repos/acme-frontend', name: 'acme-frontend' }] }} />);
    expect(el.textContent).toContain('will be added');
    expect(el.textContent).not.toContain('No projects yet');
  });
});

/**
 * Spec 2026-09-15 §5.1 and §6: `config.defaultPermissionMode` is where the Permission mode select
 * STARTS — for a manual create and for a draft alike. It is a dialog default, not a launch argument:
 * what reaches main is `agent:create`'s ordinary `permissionMode`, exactly as if the user had picked it.
 */
describe('New agent — the configured default permission mode', () => {
  const createStubs: Stubs = {
    'project:listBranches': { reply: { ok: true, value: { local: ['main'], remote: [] } } },
    'agent:create': { reply: { ok: true, value: CREATED } },
    'agent:markOpened': { reply: { ok: true, value: undefined } },
    'layout:set': { reply: { ok: true, value: undefined } },
  };

  async function withMode(mode: AppConfig['defaultPermissionMode']) {
    const t = await withSnapshot(createStubs);
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), defaultPermissionMode: mode } }));
    return t;
  }

  it('starts at the configured mode for a manual create and for a draft, and sends it', async () => {
    const t = await withMode('bypassPermissions');
    const manual = mount(<t.NewAgentDialog folderId={null} />);
    expect(picker(manual.el, 'Permission mode').value).toBe('bypassPermissions');
    const drafted = mount(<t.NewAgentDialog folderId={null} draft={{ ...DRAFT, rows: [{ kind: 'existing', projectId: 'p2' }] }} />);
    expect(picker(drafted.el, 'Permission mode').value).toBe('bypassPermissions');
    type(manual.el.querySelector('input') as HTMLInputElement, 'Smoke test');
    click(button(manual.el, 'Create'));
    await settle();
    expect(payloadsFor(t.calls, 'agent:create')).toMatchObject([{ permissionMode: 'bypassPermissions' }]);
  });

  it('starts at the "Default (ask for permissions)" option when it is null', async () => {
    const t = await withMode(null);
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    const select = picker(el, 'Permission mode');
    expect(select.value).toBe('');
    expect(select.options[select.selectedIndex]?.textContent).toBe('Default (ask for permissions)');
  });

  // `'default'` is a legal PermissionMode with no option of its own; it means what `''` means.
  it("starts a configured 'default' at the Default option and sends no mode", async () => {
    const t = await withMode('default');
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    expect(picker(el, 'Permission mode').value).toBe('');
    type(el.querySelector('input') as HTMLInputElement, 'Smoke test');
    click(button(el, 'Create'));
    await settle();
    expect(payloadsFor(t.calls, 'agent:create')).toMatchObject([{ permissionMode: null }]);
  });

  it('still lets the user choose another mode', async () => {
    const t = await withMode('bypassPermissions');
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    choose(picker(el, 'Permission mode'), 'plan');
    expect(picker(el, 'Permission mode').value).toBe('plan');
  });
});

/**
 * Spec 2026-09-15 §3 and §8: paste a link, look it up, get a filled-in New Agent dialog. Main's half —
 * the argv, the env, every failure mode of `claude -p` — is tested in `linear-triage.test.ts`; this is
 * the dialog: the repos-folder step, the lock and the seconds counter, cancel, the error text and its
 * hint, and the hand-over.
 */
describe('New agent from a Linear ticket', () => {
  const REPOS = '/Users/me/code';
  const linkField = (el: HTMLElement): HTMLInputElement => field(el, 'Linear link or ticket ID');
  const configWith = (reposDir: string | null): AppConfig => ({ ...defaultAppConfig('/bin/zsh'), reposDir });

  async function open(s: Stubs, reposDir: string | null = REPOS) {
    const t = await withSnapshot(s);
    act(() => t.config.useConfig.setState({ config: configWith(reposDir) }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    const { el } = mount(<t.DialogHost />);
    return { t, el };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the repos folder first, saves the one picked with config:set, then shows the field', async () => {
    const { t, el } = await open({
      'app:pickFolder': { reply: { ok: true, value: REPOS } },
      'config:set': { reply: { ok: true, value: configWith(REPOS) } },
    }, null);
    expect(el.querySelector('input[aria-label="Linear link or ticket ID"]')).toBeNull();
    click(button(el, 'Choose your repos folder…'));
    await settle();
    expect(payloadsFor(t.calls, 'app:pickFolder')).toEqual([{ title: 'Choose your repos folder' }]);
    expect(payloadsFor(t.calls, 'config:set')).toEqual([{ reposDir: REPOS }]);
    expect(linkField(el).placeholder).toBe('Linear link or ticket ID (AC-3461)');
    expect(el.textContent).toContain(`Repos folder: ${REPOS}`);
    // The folder step ends by mounting the field, after `initialFocus` has already been spent.
    expect(document.activeElement).toBe(linkField(el));
  });

  it('saves nothing when the folder picker is cancelled', async () => {
    const { t, el } = await open({ 'app:pickFolder': { reply: { ok: true, value: null } } }, null);
    click(button(el, 'Choose your repos folder…'));
    await settle();
    expect(payloadsFor(t.calls, 'config:set')).toEqual([]);
    expect(maybeButton(el, 'Choose your repos folder…')).toBeDefined();
  });

  it('changes the repos folder from the link under the field', async () => {
    const { t, el } = await open({
      'app:pickFolder': { reply: { ok: true, value: '/Users/me/elsewhere' } },
      'config:set': { reply: { ok: true, value: configWith('/Users/me/elsewhere') } },
    });
    expect(el.textContent).toContain(`Repos folder: ${REPOS}`);
    click(button(el, 'Change…'));
    await settle();
    expect(payloadsFor(t.calls, 'config:set')).toEqual([{ reposDir: '/Users/me/elsewhere' }]);
    expect(el.textContent).toContain('Repos folder: /Users/me/elsewhere');
  });

  // §8's first row: "inline, no request made".
  it('refuses input that is not a Linear link or ID without asking main, and still offers Continue manually', async () => {
    const { t, el } = await open({});
    type(linkField(el), 'https://linear.app/acme/project/payments-3f2a1b');
    click(button(el, 'Look up'));
    expect(el.textContent).toContain("That doesn't look like a Linear link or ticket ID.");
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([]);
    click(button(el, 'Continue manually'));
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null, draft: { name: '', folder: { kind: 'root' }, rows: [], notes: '', droppedRepos: [], fromTriage: false } });
  });

  it('looks the ticket up by its identifier, locking the field and counting the seconds', async () => {
    const gate = deferred();
    const { t, el } = await open({ 'linear:triage': { reply: { ok: true, value: DRAFT }, gate: gate.promise } });
    vi.useFakeTimers();
    type(linkField(el), 'https://linear.app/acme/issue/AC-3461/0-click-payments');
    click(button(el, 'Look up'));
    const sent = payloadsFor(t.calls, 'linear:triage') as { requestId: string; ref: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ref).toBe('AC-3461');
    expect(IpcSchemas['linear:triage'].safeParse(sent[0]).success).toBe(true);
    expect(linkField(el).disabled).toBe(true);
    expect(button(el, 'Look up').disabled).toBe(true);
    expect(el.textContent).toContain('Reading ticket… 0s');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(el.textContent).toContain('Reading ticket… 3s');
    vi.useRealTimers();
    gate.resolve();
    await settle();
  });

  // The counter is an interval; one left behind would tick into an unmounted component forever.
  it('stops the seconds counter when the look-up answers and when the dialog closes', async () => {
    const failing = deferred();
    const a = await open({
      'linear:triage': { reply: { ok: false, error: { code: 'TIMEOUT', message: 'Looking up the ticket took longer than 2 minutes.' } }, gate: failing.promise },
    });
    vi.useFakeTimers();
    type(linkField(a.el), 'AC-3461');
    click(button(a.el, 'Look up'));
    expect(vi.getTimerCount()).toBe(1);
    failing.resolve();
    await settle();
    // Still open, showing the failure — so it was the answer that stopped the counter, not an unmount.
    expect(a.el.textContent).toContain('Looking up the ticket took longer than 2 minutes.');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    const running = deferred();
    const b = await open({
      'linear:triage': { reply: { ok: true, value: DRAFT }, gate: running.promise },
      'linear:cancel': { reply: { ok: true, value: undefined } },
    });
    vi.useFakeTimers();
    type(linkField(b.el), 'AC-3461');
    click(button(b.el, 'Look up'));
    expect(vi.getTimerCount()).toBe(1);
    act(() => b.t.ui.useUi.getState().closeDialog());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    running.resolve();
    await settle();
  });

  it('replaces itself with the New Agent dialog, prefilled from the draft', async () => {
    const { t, el } = await open({
      'linear:triage': { reply: { ok: true, value: DRAFT } },
      'project:listBranches': { reply: { ok: true, value: { local: ['master'], remote: [] } } },
    });
    type(linkField(el), 'ac-3461');
    click(button(el, 'Look up'));
    await settle();
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null, draft: DRAFT });
    expect(el.querySelector('h2')?.textContent).toBe('New agent');
    expect((el.querySelector('input') as HTMLInputElement).value).toBe(DRAFT.name);
  });

  it('cancels by request id and unlocks without showing anything', async () => {
    const gate = deferred();
    const { t, el } = await open({
      'linear:triage': { reply: { ok: false, error: { code: 'CANCELLED', message: 'The look-up was cancelled.' } }, gate: gate.promise },
      'linear:cancel': { reply: { ok: true, value: undefined } },
    });
    type(linkField(el), 'AC-3461');
    click(button(el, 'Look up'));
    click(button(el, 'Cancel'));
    const [sent] = payloadsFor(t.calls, 'linear:triage') as { requestId: string }[];
    expect(payloadsFor(t.calls, 'linear:cancel')).toEqual([{ requestId: sent!.requestId }]);
    gate.resolve();
    await settle();
    expect(linkField(el).disabled).toBe(false);
    expect(el.textContent).not.toContain('Reading ticket');
    expect(el.textContent).not.toContain('cancelled');
    expect(maybeButton(el, 'Continue manually')).toBeUndefined();
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'linear' });
  });

  // The stub above answers CANCELLED, which a dialog that never recorded the cancel handles correctly
  // by accident. A draft already on its way when Cancel is pressed is the case that tells them apart.
  it('ignores a draft that answers after Cancel, and a fresh look-up still opens its own', async () => {
    const gate = deferred();
    const { t, el } = await open({
      'linear:triage': { reply: { ok: true, value: DRAFT }, gate: gate.promise },
      'linear:cancel': { reply: { ok: true, value: undefined } },
      'project:listBranches': { reply: { ok: true, value: { local: ['master'], remote: [] } } },
    });
    type(linkField(el), 'AC-3461');
    click(button(el, 'Look up'));
    click(button(el, 'Cancel'));
    gate.resolve();
    await settle();
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'linear' });
    expect(linkField(el).disabled).toBe(false);
    expect(el.textContent).not.toContain('Reading ticket');
    expect(maybeButton(el, 'Continue manually')).toBeUndefined();
    // Per request, not a latch: the next look-up is not mistaken for the cancelled one.
    click(button(el, 'Look up'));
    await settle();
    const sent = payloadsFor(t.calls, 'linear:triage') as { requestId: string }[];
    expect(sent).toHaveLength(2);
    expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null, draft: DRAFT });
  });

  /**
   * The field is `disabled` while a look-up runs, and Chromium's focus fixup drops focus from a control
   * that becomes disabled — so without a hand-back, typo → Enter → error → retype needs a click. jsdom
   * has no focus fixup, and its `blur()` is a no-op on a disabled control, so each case parks focus on
   * the footer's Cancel (the one control that stays enabled) where Chromium would have dropped it to
   * the body, and asserts the caret is back in the field once the look-up has settled.
   */
  it('puts the caret back in the link field when a look-up fails or is cancelled', async () => {
    const failing = deferred();
    const a = await open({
      'linear:triage': { reply: { ok: false, error: { code: 'TIMEOUT', message: 'Looking up the ticket took longer than 2 minutes.' } }, gate: failing.promise },
    });
    linkField(a.el).focus();
    type(linkField(a.el), 'AC-3461');
    click(button(a.el, 'Look up'));
    act(() => button(a.el, 'Cancel').focus());
    expect(document.activeElement).not.toBe(linkField(a.el));
    failing.resolve();
    await settle();
    expect(a.el.textContent).toContain('Looking up the ticket took longer than 2 minutes.');
    expect(document.activeElement).toBe(linkField(a.el));

    const cancelling = deferred();
    const b = await open({
      'linear:triage': { reply: { ok: false, error: { code: 'CANCELLED', message: 'The look-up was cancelled.' } }, gate: cancelling.promise },
      'linear:cancel': { reply: { ok: true, value: undefined } },
    });
    type(linkField(b.el), 'AC-3461');
    click(button(b.el, 'Look up'));
    button(b.el, 'Cancel').focus();
    click(button(b.el, 'Cancel'));
    cancelling.resolve();
    await settle();
    expect(document.activeElement).toBe(linkField(b.el));
  });

  it('shows why a look-up failed, with its hint, and Continue manually opens a draft named after the ticket', async () => {
    const { t, el } = await open({
      'linear:triage': { reply: { ok: false, error: { code: 'TRIAGE_FAILED', message: 'Couldn\'t read the ticket: MCP server "linear" is not connected', detail: 'Is Linear connected? Check with: claude mcp list' } } },
    });
    type(linkField(el), 'AC-3461');
    click(button(el, 'Look up'));
    await settle();
    expect(el.textContent).toContain('Couldn\'t read the ticket: MCP server "linear" is not connected');
    expect(el.textContent).toContain('Is Linear connected? Check with: claude mcp list');
    expect(t.ui.useUi.getState().toasts).toEqual([]);
    click(button(el, 'Continue manually'));
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null, draft: { name: 'AC-3461', folder: { kind: 'root' }, rows: [], notes: '', droppedRepos: [], fromTriage: false } });
  });

  it('cancels a running look-up when the dialog is closed, and opens nothing when it answers', async () => {
    const gate = deferred();
    const { t, el } = await open({
      'linear:triage': { reply: { ok: true, value: DRAFT }, gate: gate.promise },
      'linear:cancel': { reply: { ok: true, value: undefined } },
    });
    type(linkField(el), 'AC-3461');
    click(button(el, 'Look up'));
    click(el.querySelector('button[aria-label="Close"]'));
    expect(t.ui.useUi.getState().dialog).toBeNull();
    const [sent] = payloadsFor(t.calls, 'linear:triage') as { requestId: string }[];
    expect(payloadsFor(t.calls, 'linear:cancel')).toEqual([{ requestId: sent!.requestId }]);
    gate.resolve();
    await settle();
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });
});

describe('Project settings', () => {
  const stubs: Stubs = {
    'project:update': { reply: { ok: true, value: PROJECTS[0]! } },
    'project:remove': { reply: { ok: true, value: undefined } },
  };
  const area = (el: HTMLElement, i: number): HTMLTextAreaElement => el.querySelectorAll('textarea')[i] as HTMLTextAreaElement;
  const text = (el: HTMLElement, i: number): HTMLInputElement => el.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')[i] as HTMLInputElement;

  it('fills every field from the project and shows the repo path read-only', async () => {
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    expect(text(el, 0).value).toBe('hangar');
    expect(text(el, 1).value).toBe('/repos/hangar');
    expect(text(el, 1).readOnly).toBe(true);
    expect(text(el, 2).value).toBe('main');
    expect(area(el, 0).value).toBe('.env');
    expect(area(el, 1).value).toBe('node_modules');
    expect(text(el, 3).value).toBe('npm ci');
    // §15.4's actions round-trip back into the textarea in the form the parser accepts.
    expect(area(el, 3).value).toBe('Tests = npm test');
  });

  it('saves the whole setup, splitting the textareas and nulling an empty postCreate', async () => {
    const t = await withSnapshot(stubs);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'project-settings', projectId: 'p1' }));
    const { el } = mount(<t.DialogHost />);
    type(text(el, 0), '  hangar-main  ');
    type(area(el, 0), ' .env \n\n.claude/settings.local.json\n');
    type(area(el, 1), '');
    type(text(el, 3), '   ');
    type(area(el, 2), '--model\nopus');
    // Spec §15.4: first `=` splits, so a command may contain one; a blank line and a half-written
    // line are dropped rather than saved as a button that types nothing.
    type(area(el, 3), '  Tests = npm test  \n\nEnv = FOO=1 npm test\nBuild =\n');
    click(el.querySelector('input[type="checkbox"]'));
    click(button(el, 'Save'));
    await flush();
    expect(payloadsFor(t.calls, 'project:update')).toEqual([{
      id: 'p1',
      patch: {
        name: 'hangar-main',
        defaultBranch: 'main',
        setup: { fetchBeforeBranch: false, copyPatterns: ['.env', '.claude/settings.local.json'], cloneDirs: [], postCreate: null },
        claudeArgs: ['--model', 'opus'],
        actions: [{ label: 'Tests', command: 'npm test' }, { label: 'Env', command: 'FOO=1 npm test' }],
        // §11.9, untouched by this test: the click above lands on the FIRST checkbox (fetch), so
        // this rides along as the default. That it is present at all is the point — `false` is sent
        // explicitly, so turning the setting off is a save that clears it rather than a no-op.
        shareClaudeMemory: false,
      },
    }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /**
   * §11.9's opt-in. It is a FALLBACK — Claude Code already keys auto-memory by the canonical git
   * repository root and resolves a worktree back to its main checkout — so the box is off unless
   * the project says otherwise, and it must round-trip in both directions: a project that has it on
   * shows it on, and toggling it sends the new value rather than the stored one.
   */
  it('round-trips the auto-memory checkbox', async () => {
    const shared = { ...PROJECTS[0]!, shareClaudeMemory: true };
    const t = await withSnapshot(stubs, snapshotWith({}, { projects: [shared, PROJECTS[1]!] }));
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    const boxes = (): HTMLInputElement[] => [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    // Two checkboxes now: [0] is fetch-before-branch, [1] is the memory opt-in.
    expect(boxes()).toHaveLength(2);
    expect(boxes()[1]!.checked).toBe(true);
    click(boxes()[1]);
    click(button(el, 'Save'));
    await flush();
    expect(payloadsFor(t.calls, 'project:update')[0]).toMatchObject({ patch: { shareClaudeMemory: false } });
  });

  it('sends the opt-in when a project that had it off turns it on', async () => {
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    const box = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!;
    expect(box.checked).toBe(false);
    click(box);
    click(button(el, 'Save'));
    await flush();
    expect(payloadsFor(t.calls, 'project:update')[0]).toMatchObject({ patch: { shareClaudeMemory: true } });
  });

  /**
   * `project:update` validates `name` with `DirSegmentSchema` because it becomes a directory
   * segment under HANGAR_HOME/worktrees (spec §6.2) — so `../..` would put worktrees outside the
   * profile. Reusing the schema is what makes the button say so before the round trip.
   */
  it('will not save a name that is not a single directory segment', async () => {
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    for (const bad of ['', '  ', 'a/b', '..', 'x'.repeat(81)]) {
      type(text(el, 0), bad);
      expect(button(el, 'Save').disabled).toBe(true);
    }
    type(text(el, 0), 'hangar');
    expect(button(el, 'Save').disabled).toBe(false);
    type(text(el, 2), '  ');
    expect(button(el, 'Save').disabled).toBe(true);
  });

  /**
   * The command is user-authored and is TYPED into a live `$SHELL -il`, so the dialog is the first
   * of three boundaries that must not let a submitting byte through (the others are
   * `IpcSchemas['project:update']` and `actionKeystrokes`, both tested where they live). A `\r`
   * here would press Enter on a command the user was supposed to read first.
   */
  it('sanitises a control character out of an action rather than sending it', async () => {
    const t = await withSnapshot(stubs);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'project-settings', projectId: 'p1' }));
    const { el } = mount(<t.DialogHost />);
    type(area(el, 3), 'Tests = npm test\u0003 && rm -rf ~\u0015');
    click(button(el, 'Save'));
    await flush();
    const sent = payloadsFor(t.calls, 'project:update')[0] as { patch: { actions: { command: string }[] } };
    expect(sent.patch.actions).toEqual([{ label: 'Tests', command: 'npm test  && rm -rf ~' }]);
    // The whole point: what leaves the dialog is something `project:update` will accept, and the
    // schema refuses control characters outright.
    expect(IpcSchemas['project:update'].safeParse(sent).success).toBe(true);
  });

  // An over-long command is REFUSED, not truncated: running the first 500 characters of a command
  // line is a different command. Same shape as the name gate above.
  it('refuses to save an action that is over a bound, and says which', async () => {
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    type(area(el, 3), `Tests = ${'y'.repeat(ACTION_COMMAND_MAX + 1)}`);
    expect(button(el, 'Save').disabled).toBe(true);
    expect(el.textContent).toContain('longer than');
    type(area(el, 3), 'Tests = npm test');
    expect(button(el, 'Save').disabled).toBe(false);
  });

  it('blocks Remove while agents use the project, and says how many', async () => {
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    const remove = button(el, 'Remove project');
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe('used by 2 agent(s)');
  });

  it('removes an unused project and closes', async () => {
    const t = await withSnapshot(stubs);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'project-settings', projectId: 'p2' }));
    const { el } = mount(<t.DialogHost />);
    expect(button(el, 'Remove project').disabled).toBe(false);
    click(button(el, 'Remove project'));
    await flush();
    expect(payloadsFor(t.calls, 'project:remove')).toEqual([{ id: 'p2' }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  // `project:remove` has `res: void`, so `run` resolves `undefined` on success — the plan's
  // `if (r)` would never have closed the dialog. Reverting `!== null` to `if (result)` fails the
  // close assertion in the test above; this one is the other side of it.
  it('stays open when the remove fails', async () => {
    const t = await withSnapshot({});
    act(() => t.ui.useUi.getState().openDialog({ kind: 'project-settings', projectId: 'p2' }));
    const { el } = mount(<t.DialogHost />);
    click(button(el, 'Remove project'));
    await flush();
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
  });

  it('renders nothing for a project that is gone', async () => {
    const t = await withSnapshot(stubs);
    const { el } = mount(<t.ProjectSettingsDialog projectId="nope" />);
    expect(el.querySelector('dialog')).toBeNull();
  });
});

/**
 * Spec §12.6's delete dialog. The typed-name gate is the only thing standing between a mis-click
 * and lost work, so most of this block is about when it arms and when it lets go.
 */
describe('Delete agent', () => {
  const stubs = (insp: DeleteInspection = inspection()): Stubs => ({
    'agent:inspectDelete': { reply: { ok: true, value: insp } },
    'agent:delete': { reply: { ok: true, value: undefined } },
    'layout:set': { reply: { ok: true, value: undefined } },
  });

  const confirmBox = (el: HTMLElement): HTMLInputElement | null => el.querySelector('input[aria-label="Type the agent\'s name to confirm"]');
  const checkbox = (el: HTMLElement, i: number): HTMLInputElement => el.querySelectorAll('input[type="checkbox"]')[i] as HTMLInputElement;

  async function open(s: Stubs) {
    const t = await withSnapshot(s, snapshotWith({ panes: ['a1', 'a2'], focusedIndex: 0 }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'delete-agent', agentId: 'a1' }));
    const { el } = mount(<t.DialogHost />);
    await flush();
    return { t, el };
  }

  it('shows the branch, the worktree path and both counts per workspace', async () => {
    const { el } = await open(stubs(inspection({ dirtyFiles: 3, unmergedCommits: 7 })));
    expect(el.textContent).toContain('agent/alpha');
    expect(el.textContent).toContain('/wt/alpha');
    expect(el.textContent).toContain('3 uncommitted change(s)');
    expect(el.textContent).toContain('7 unmerged commit(s)');
    expect(el.textContent).toContain('The Claude session will be stopped first.');
  });

  // The checkboxes default on, so a click landing before the inspection answers would delete under
  // numbers nobody had seen.
  it('keeps Delete disabled while the inspection is in flight', async () => {
    const gate = deferred();
    const t = await withSnapshot({ ...stubs(), 'agent:inspectDelete': { reply: { ok: true, value: inspection() }, gate: gate.promise } });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'delete-agent', agentId: 'a1' }));
    const { el } = mount(<t.DialogHost />);
    expect(el.textContent).toContain('Inspecting worktrees…');
    expect(button(el, 'Delete').disabled).toBe(true);
    gate.resolve();
    await flush();
    expect(button(el, 'Delete').disabled).toBe(false);
  });

  it('deletes a clean agent straight away, without forcing, and frees its pane', async () => {
    const { t, el } = await open(stubs());
    expect(confirmBox(el)).toBeNull();
    click(button(el, 'Delete'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:delete')).toEqual([
      { id: 'a1', options: { removeWorktrees: true, deleteBranches: false, force: false } },
    ]);
    expect(t.layout.layoutStore.getState().layout.panes).toEqual([null, 'a2']);
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  it('arms the typed-name gate on uncommitted changes, and forces once it is satisfied', async () => {
    const { t, el } = await open(stubs(inspection({ dirtyFiles: 2 })));
    expect(el.textContent).toContain("Type the agent's name (alpha)");
    expect(button(el, 'Delete').disabled).toBe(true);
    type(confirmBox(el)!, 'alph');
    expect(button(el, 'Delete').disabled).toBe(true);
    type(confirmBox(el)!, 'Alpha');
    expect(button(el, 'Delete').disabled).toBe(true);
    type(confirmBox(el)!, 'alpha');
    expect(button(el, 'Delete').disabled).toBe(false);
    click(button(el, 'Delete'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:delete')).toEqual([
      { id: 'a1', options: { removeWorktrees: true, deleteBranches: false, force: true } },
    ]);
  });

  // "…and the corresponding checkbox is on" (§12.6). Leaving the directory in place loses nothing.
  it('disarms when the checkbox that would discard the work is turned off', async () => {
    const { el } = await open(stubs(inspection({ dirtyFiles: 2 })));
    expect(confirmBox(el)).not.toBeNull();
    click(checkbox(el, 0));
    expect(confirmBox(el)).toBeNull();
    expect(button(el, 'Delete').disabled).toBe(false);
  });

  it('arms on unmerged commits only once branch deletion is asked for', async () => {
    const { el } = await open(stubs(inspection({ unmergedCommits: 4 })));
    expect(confirmBox(el)).toBeNull();
    click(checkbox(el, 1));
    expect(confirmBox(el)).not.toBeNull();
    expect(button(el, 'Delete').disabled).toBe(true);
  });

  /**
   * Plan 06 Task 10, from the Task 9 review: git refuses to delete a branch that a kept worktree still
   * has checked out, so "keep the directories, delete the branches" could only ever fail. The same
   * rule as the Remove project dialog: Delete branch(es) is disabled and cleared while the worktrees
   * are kept.
   */
  it('cannot delete branches while the worktrees are kept, and says why', async () => {
    const { t, el } = await open(stubs(inspection({ unmergedCommits: 4 })));
    click(checkbox(el, 1));
    expect(confirmBox(el)).not.toBeNull();
    click(checkbox(el, 0));
    expect(checkbox(el, 1).disabled).toBe(true);
    expect(checkbox(el, 1).checked).toBe(false);
    expect(el.textContent).toContain('still has it checked out');
    expectBranchHint(checkbox(el, 1), true);
    expect(confirmBox(el)).toBeNull();
    click(button(el, 'Delete'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:delete')).toEqual([
      { id: 'a1', options: { removeWorktrees: false, deleteBranches: false, force: false } },
    ]);
  });

  it('gives Delete branch(es) back, still unticked, once the worktrees are removed again', async () => {
    const { el } = await open(stubs());
    click(checkbox(el, 0));
    click(checkbox(el, 0));
    expect(checkbox(el, 1).disabled).toBe(false);
    expect(checkbox(el, 1).checked).toBe(false);
    expect(el.textContent).not.toContain('still has it checked out');
    expectBranchHint(checkbox(el, 1), false);
  });

  /**
   * The trap the contract's comment on `inspectionFailed` describes: a broken `.git` link answers
   * "not a git repository", so both counts read 0 and `worktreeMissing` is false while real files
   * sit in the directory. An unanswered question must arm the gate, not disarm it.
   */
  it('arms on a workspace git could not inspect, even though its counts read zero', async () => {
    const { el } = await open(stubs(inspection({ inspectionFailed: true })));
    expect(el.textContent).toContain('could not be inspected');
    expect(el.textContent).toContain('unmerged commits unknown');
    expect(confirmBox(el)).not.toBeNull();
  });

  it('arms, and says why, when the inspect call itself failed', async () => {
    const { el } = await open({ 'agent:delete': { reply: { ok: true, value: undefined } } });
    expect(el.textContent).toContain('could not be inspected, so there is no way to tell what would be lost');
    expect(confirmBox(el)).not.toBeNull();
    expect(button(el, 'Delete').disabled).toBe(true);
    type(confirmBox(el)!, 'alpha');
    expect(button(el, 'Delete').disabled).toBe(false);
  });

  it('says the directory is missing rather than reporting zero changes', async () => {
    const { el } = await open(stubs(inspection({ worktreeMissing: true })));
    expect(el.textContent).toContain('directory missing');
    expect(confirmBox(el)).toBeNull();
  });

  it('stays open, and stops saying "Deleting…", when the delete fails', async () => {
    const { t, el } = await open({ 'agent:inspectDelete': { reply: { ok: true, value: inspection() } } });
    click(button(el, 'Delete'));
    await flush();
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
    expect(t.layout.layoutStore.getState().layout.panes).toEqual(['a1', 'a2']);
    expect(maybeButton(el, 'Delete')).toBeDefined();
  });

  it('renders nothing for an agent that is already gone', async () => {
    const t = await withSnapshot(stubs());
    const { el } = mount(<t.DeleteAgentDialog agentId="nope" />);
    expect(el.querySelector('dialog')).toBeNull();
  });
});

/**
 * Spec §12.6: "Name (required, autofocus)". It was not implemented, and the way it failed was
 * worse than a missing convenience.
 *
 * Measured in the built app over CDP: pressing ⌘N and typing "smoke test agent" made the dialog
 * VANISH. Focus was on the header's Close `IconButton` — the first focusable element in
 * `ui/Dialog.tsx`'s DOM — and the first space activated it. Reproduced in Chrome 152 against a
 * reduction of that DOM: one Space keyUp with Close focused fired its click and left
 * `dialog.open === false`.
 *
 * ── What these tests can and cannot prove ──────────────────────────────────────────────────────
 *
 * jsdom 30 implements NO `HTMLDialogElement` methods at all (`prototype` is exactly
 * `['constructor', 'open']`, measured in Task 8), so `test-setup.ts` stubs `showModal` as an
 * attribute flip. That stub does not run the HTML "dialog focusing steps", so in the default
 * environment focus simply stays wherever it was and the bug is INVISIBLE — which is precisely why
 * 913 tests were green while ⌘N was unusable.
 *
 * So these tests install a `showModal` that does the one thing Chrome was measured to do: focus
 * the first focusable descendant. `simulates the focus steps it depends on` below is the control —
 * it fails if that installation is inert, so "the name field is focused" cannot pass by accident.
 *
 * They still do NOT prove: that a Space keypress activates a focused button (jsdom has no
 * keyboard activation behaviour), that the top layer traps focus, or that Chromium's real focusing
 * steps match the simulation in any case beyond the one measured here. The real app over CDP is
 * the only authority on those.
 */
describe('initial focus', () => {
  // An independent copy of `ui/Dialog.tsx`'s list on purpose: sharing it would make the
  // "Close is last" test pass whenever the production selector is wrong in the same way.
  const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const focusables = (el: HTMLElement): HTMLElement[] =>
    [...(el.querySelector('dialog') as HTMLDialogElement).querySelectorAll<HTMLElement>(FOCUSABLE)];

  let restore: (() => void) | null = null;

  /** Replaces the `test-setup.ts` stub with one that also runs Chromium's dialog focusing steps. */
  function chromiumLikeShowModal(): void {
    const real = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function patched(this: HTMLDialogElement): void {
      real.call(this);
      // Chrome takes the first element carrying the `autofocus` ATTRIBUTE, else the first
      // focusable descendant. React never emits that attribute for its `autoFocus` prop, so the
      // first branch is unreachable from this codebase and only the second is modelled.
      this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
    restore = () => { HTMLDialogElement.prototype.showModal = real; };
  }

  afterEach(() => {
    restore?.();
    restore = null;
  });

  /** Types the way a user does — into whatever actually has focus, not into a queried field. */
  function typeIntoFocused(value: string): HTMLInputElement {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) {
      throw new Error(`focus is on ${active?.tagName ?? 'nothing'}${active instanceof HTMLElement && active.getAttribute('aria-label') ? `[${active.getAttribute('aria-label')}]` : ''}, so there is nowhere to type`);
    }
    type(active, value);
    return active;
  }

  /**
   * The control. If the patched `showModal` above did not really move focus, every "the name
   * field is focused" assertion below would pass on a component that never focused anything.
   */
  it('simulates the focus steps it depends on', () => {
    chromiumLikeShowModal();
    const d = document.createElement('dialog');
    d.innerHTML = '<button type="button" id="first">x</button><input id="second">';
    document.body.appendChild(d);
    (d.querySelector('#second') as HTMLInputElement).focus();
    d.showModal();
    expect(document.activeElement?.id).toBe('first');
    d.remove();
  });

  /**
   * The ordering claim, isolated. `ui/Dialog.tsx` focuses AFTER `showModal()` because `showModal()`
   * moves focus itself; a `.focus()` that runs before it — which is exactly what React's
   * `autoFocus` prop does, during commit — is overwritten.
   *
   * The three form dialogs would land on their name field from DOM order alone, so this test
   * models a `showModal` that focuses the LAST focusable instead of the first. Nothing but an
   * explicit focus applied after it can pass.
   */
  it('applies its focus after showModal, whatever showModal did with focus', async () => {
    const real = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function patched(this: HTMLDialogElement): void {
      real.call(this);
      const all = [...this.querySelectorAll<HTMLElement>(FOCUSABLE)];
      all[all.length - 1]?.focus();
    };
    restore = () => { HTMLDialogElement.prototype.showModal = real; };
    const t = await withSnapshot({ 'project:listBranches': { reply: { ok: true, value: { local: ['main'], remote: [] } } } });
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    expect(document.activeElement).not.toBe(el.querySelector('button[aria-label="Close"]'));
    expect(typeIntoFocused('after showModal').value).toBe('after showModal');
    expect(el.textContent).toContain('branch: agent/after-showmodal');
  });

  /**
   * The regression that matters. Not "is the input focused" but "does typing a name with SPACES
   * survive" — the failure the owner hit was a space reaching a focused Close button.
   */
  it('New agent: typing a name with spaces fills the Name field and leaves the dialog open', async () => {
    chromiumLikeShowModal();
    const t = await withSnapshot({ 'project:listBranches': { reply: { ok: true, value: { local: ['main'], remote: [] } } } });
    const { el } = mount(<t.NewAgentDialog folderId={null} />);
    const typed = typeIntoFocused('smoke test agent');
    expect(typed.value).toBe('smoke test agent');
    expect(el.querySelector('dialog')?.open).toBe(true);
    // Proves the focused field was the NAME field and not some other input: only the name drives
    // the branch preview and only the name unlocks Create.
    expect(el.textContent).toContain('branch: agent/smoke-test-agent');
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('New folder: typing a name with spaces fills the Name field and leaves the dialog open', async () => {
    chromiumLikeShowModal();
    const t = await withSnapshot({});
    const { el } = mount(<t.NewFolderDialog parentId={null} />);
    expect(typeIntoFocused('my folder').value).toBe('my folder');
    expect(el.querySelector('dialog')?.open).toBe(true);
    expect(button(el, 'Create').disabled).toBe(false);
  });

  it('Project settings: focus starts in the Name field, not on Remove project', async () => {
    chromiumLikeShowModal();
    const t = await withSnapshot({});
    const { el } = mount(<t.ProjectSettingsDialog projectId="p1" />);
    const typed = typeIntoFocused('renamed');
    expect(typed.value).toBe('renamed');
    expect(el.querySelectorAll('input')[0]).toBe(typed);
  });

  /**
   * Delete is the one dialog whose right answer changes while it is open. The inspection is in
   * flight when it mounts, so nothing is yet known to be at risk and focus belongs on the least
   * destructive control; when the answer says work would be lost, the typed-name box appears and
   * is the only control that can unlock Delete.
   */
  it('Delete agent: focus starts on Cancel while the inspection is pending', async () => {
    chromiumLikeShowModal();
    const gate = deferred();
    const t = await withSnapshot({ 'agent:inspectDelete': { reply: { ok: true, value: inspection({ dirtyFiles: 3 }) }, gate: gate.promise } });
    const { el } = mount(<t.DeleteAgentDialog agentId="a1" />);
    expect(document.activeElement).toBe(button(el, 'Cancel'));
    gate.resolve();
    await flush();
    expect(document.activeElement).toBe(field(el, "Type the agent's name to confirm"));
  });

  it('Delete agent: focus stays on Cancel when nothing is at risk', async () => {
    chromiumLikeShowModal();
    const t = await withSnapshot({ 'agent:inspectDelete': { reply: { ok: true, value: inspection() } } });
    const { el } = mount(<t.DeleteAgentDialog agentId="a1" />);
    await flush();
    expect(el.querySelector('input[aria-label="Type the agent\'s name to confirm"]')).toBeNull();
    expect(document.activeElement).toBe(button(el, 'Cancel'));
  });

  // The first focusable element in this dialog's body is the "Remove worktree directory" checkbox, so
  // the simulated focusing steps land THERE; only `initialFocus` can put focus on Cancel.
  it('Remove project: focus starts on Cancel, not on the first checkbox', async () => {
    chromiumLikeShowModal();
    const t = await withSnapshot({ 'agent:inspectRemoveWorkspace': { reply: { ok: true, value: secondInspection() } } }, snapshotWith({}, { agents: [...AGENTS, GAMMA] }));
    const { el } = mount(<t.RemoveWorkspaceDialog agentId="a3" workspaceId="w2" />);
    expect(document.activeElement).toBe(button(el, 'Cancel'));
    await flush();
    expect(document.activeElement).toBe(button(el, 'Cancel'));
  });

  // With no repos folder the simulated focusing steps land on the first focusable, Cancel, so only
  // `initialFocus` can put focus on the folder button — that half is the proof. With a folder the link
  // field is ALSO first in DOM order, so the second half would pass without `initialFocus`; it is kept
  // because it is the state the user types into, not because it can tell the two apart. jsdom has no
  // focusability rule (G66), so neither half proves a real Chromium would agree the button can take focus.
  it('Linear: focus starts on the folder button with no repos folder, and in the link field with one', async () => {
    chromiumLikeShowModal();
    const bare = await withSnapshot({});
    const a = mount(<bare.LinearDialog />);
    expect(document.activeElement).toBe(button(a.el, 'Choose your repos folder…'));
    const ready = await withSnapshot({});
    act(() => ready.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: '/Users/me/code' } }));
    const b = mount(<ready.LinearDialog />);
    expect(document.activeElement).toBe(field(b.el, 'Linear link or ticket ID'));
  });

  /**
   * The tab-order half of the fix, and the one that holds even for a dialog that forgets to name
   * a focus target. Tab order follows the DOM and CSS `order` / `flex-row-reverse` do not change
   * it, so the header's Close button is positioned back into the header from the END of the DOM.
   * While it was first, it was both `showModal()`'s default target and the first Tab stop.
   */
  it('puts the header Close button last in the DOM, never first', async () => {
    const t = await withSnapshot(
      { 'agent:inspectDelete': { reply: { ok: true, value: inspection() } }, 'agent:inspectRemoveWorkspace': { reply: { ok: true, value: secondInspection() } } },
      snapshotWith({}, { agents: [...AGENTS, GAMMA] }),
    );
    const cases: [string, ReactNode][] = [
      ['new agent', <t.NewAgentDialog folderId={null} />],
      ['new folder', <t.NewFolderDialog parentId={null} />],
      ['project settings', <t.ProjectSettingsDialog projectId="p1" />],
      ['delete agent', <t.DeleteAgentDialog agentId="a1" />],
      ['add workspace', <t.AddWorkspaceDialog agentId="a1" />],
      ['remove workspace', <t.RemoveWorkspaceDialog agentId="a3" workspaceId="w2" />],
      ['linear', <t.LinearDialog />],
    ];
    for (const [label, node] of cases) {
      const { el } = mount(node);
      const order = focusables(el);
      const close = el.querySelector<HTMLElement>('button[aria-label="Close"]');
      expect(close, label).not.toBeNull();
      expect(order.indexOf(close as HTMLElement), label).toBe(order.length - 1);
      expect(order[0], label).not.toBe(close);
    }
  });
});

/**
 * Spec §10.3 / §12.6: adding a second project to an agent that already has one.
 *
 * The provisioning is `agent-service.addWorkspace`, which existed before this dialog and is tested
 * in `src/main/services/agent-service.test.ts` — including the two things this UI must not
 * contradict: it APPENDS (so `workspaces[0]`, the PTY's cwd, stays primary) and it reuses the
 * agent's own slug rather than colliding with itself. What is tested here is the renderer's half:
 * which projects it offers, what it sends, and what it does about a session that is already
 * running when the worktree appears.
 */
describe('Add a project to an agent', () => {
  const WORKSPACE: Workspace = {
    id: 'w-new', projectId: 'p2', branch: 'agent/alpha', worktreePath: '/wt/acmeapi/alpha',
    baseRef: 'origin/master', createdAt: ISO,
  };

  const okStubs = (gate?: Promise<unknown>): Stubs => ({
    'project:listBranches': { reply: { ok: true, value: { local: ['master'], remote: ['origin/master'] } } },
    'agent:addWorkspace': { reply: { ok: true, value: WORKSPACE }, gate },
    'session:write': { reply: { ok: true, value: undefined } },
  });

  /** `stopped` is the default; this is the same state with a PTY behind it (§6.5). */
  const running = (): SessionState => ({ ...initialSessionState('a1'), activity: 'idle', pid: 4242 });

  async function open(stubs: Stubs, session: SessionState | null = null, snap = snapshotWith()) {
    const t = await withSnapshot(stubs, snap);
    if (session) act(() => t.sessions.useSessions.getState().setOne('a1', session));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'add-workspace', agentId: 'a1' }));
    const { el } = mount(<t.DialogHost />);
    return { t, el };
  }

  const steps = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('li[data-step]')].map((li) => `${li.getAttribute('data-status')} ${li.getAttribute('data-step')}`);

  it('offers only the projects this agent does not already have', async () => {
    const { el } = await open(okStubs());
    // `alpha` already has a workspace on p1 (hangar), so the one addable project is acmeapi.
    expect([...picker(el, 'Project').options].map((o) => o.textContent)).toEqual(['acmeapi']);
    expect(el.querySelector('h2')?.textContent).toBe('Add a project to alpha');
  });

  /**
   * The duplicate rule from the other side. `agent-service.addWorkspace` throws INVALID for a
   * project the agent already has; with one `<select>` there is nowhere to show that rejection, so
   * the option is removed instead and the dialog says why it is empty.
   */
  it('says every project is taken rather than showing an empty picker', async () => {
    const both = agent('a3', 'gamma', {
      workspaces: [
        { id: 'w1', projectId: 'p1', branch: 'agent/gamma', worktreePath: '/wt/g1', baseRef: 'main', createdAt: ISO },
        { id: 'w2', projectId: 'p2', branch: 'agent/gamma', worktreePath: '/wt/g2', baseRef: 'main', createdAt: ISO },
      ],
    });
    const t = await withSnapshot(okStubs(), snapshotWith({}, { agents: [...AGENTS, both] }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'add-workspace', agentId: 'a3' }));
    const { el } = mount(<t.DialogHost />);
    expect(el.textContent).toContain('Every project is already part of gamma.');
    expect(el.querySelector('select')).toBeNull();
    expect(maybeButton(el, 'Add')).toBeUndefined();
  });

  /**
   * The cap, from the renderer's side. `agent-service.addWorkspace` throws WORKSPACE_LIMIT and the
   * persisted `AgentSchema` refuses the record, so a picker here could only ever produce a failed
   * round trip. Note the difference from the test above: there ARE addable projects, so the empty
   * `options` branch cannot be what is showing the panel — only the length check can.
   */
  it('refuses to offer a picker to an agent that already has the maximum number of projects', async () => {
    const workspaces = Array.from({ length: AGENT_WORKSPACES_MAX }, (_, i) => ({
      id: `wf${i}`, projectId: `unlisted-${i}`, branch: `agent/full-${i}`,
      worktreePath: `/wt/full-${i}`, baseRef: 'main', createdAt: ISO,
    }));
    const t = await withSnapshot(okStubs(), snapshotWith({}, { agents: [...AGENTS, agent('a4', 'full', { workspaces })] }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'add-workspace', agentId: 'a4' }));
    const { el } = mount(<t.DialogHost />);
    expect(el.textContent).toContain(`already has the maximum of ${AGENT_WORKSPACES_MAX} projects`);
    // It used to say "Remove one" with no way to do so; now it names where.
    expect(el.textContent).toContain('Remove project from this agent');
    expect(el.querySelector('select')).toBeNull();
    expect(maybeButton(el, 'Add')).toBeUndefined();
  });

  // The control for the test above: one under the cap, same shape of agent, and the form is there.
  it('still offers the picker one workspace below the cap', async () => {
    const workspaces = Array.from({ length: AGENT_WORKSPACES_MAX - 1 }, (_, i) => ({
      id: `wn${i}`, projectId: `unlisted-${i}`, branch: `agent/near-${i}`,
      worktreePath: `/wt/near-${i}`, baseRef: 'main', createdAt: ISO,
    }));
    const t = await withSnapshot(okStubs(), snapshotWith({}, { agents: [...AGENTS, agent('a5', 'near', { workspaces })] }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'add-workspace', agentId: 'a5' }));
    const { el } = mount(<t.DialogHost />);
    expect(el.querySelector('select')).not.toBeNull();
    expect(button(el, 'Add').disabled).toBe(false);
  });

  /**
   * The pre-bootstrap open, and the only test that can see the repair effect: `workspace:get` has
   * not answered, so there is no agent and the dialog renders nothing at all; when the snapshot
   * lands the picker has to fill itself. Seeding `useState` alone leaves this case on `''` forever
   * — a populated `<select>` with Add disabled.
   */
  it('fills its picker when the snapshot arrives after it opened', async () => {
    const t = await load(okStubs());
    act(() => t.ui.useUi.getState().openDialog({ kind: 'add-workspace', agentId: 'a1' }));
    const { el } = mount(<t.DialogHost />);
    expect(el.querySelector('dialog')).toBeNull();
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith()));
    expect(picker(el, 'Project').value).toBe('p2');
    expect(button(el, 'Add').disabled).toBe(false);
  });

  it('sends the chosen project with a trimmed base branch, and null for an empty one', async () => {
    const a = await open(okStubs());
    type(field(a.el, 'Base branch'), '  feature/x  ');
    click(button(a.el, 'Add'));
    await flush();
    expect(payloadsFor(a.t.calls, 'agent:addWorkspace')).toEqual([{ id: 'a1', projectId: 'p2', baseBranch: 'feature/x' }]);

    const b = await open(okStubs());
    click(button(b.el, 'Add'));
    await flush();
    expect(payloadsFor(b.t.calls, 'agent:addWorkspace')).toEqual([{ id: 'a1', projectId: 'p2', baseBranch: null }]);
  });

  /**
   * The base-branch suggestions the plan got wrong for this dialog exactly as it did for New Agent:
   * `[...local, ...remote]` offers `origin/master`, which `baseRefFor` then resolves as
   * `refs/remotes/origin/origin/master` and fails with BASE_NOT_FOUND. `branchOptions` is the one
   * transform, shared with New Agent so the two lists cannot drift.
   */
  it('suggests bare branch names, never origin/…', async () => {
    const { el } = await open(okStubs());
    await flush();
    expect([...el.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['master']);
  });

  /**
   * §11.1's `--add-dir` list is composed at LAUNCH from `workspaces.slice(1)`, so a session that is
   * already running cannot be given the new directory by adding it — the argv is fixed. The dialog
   * types Claude Code's own `/add-dir` at the prompt instead and stops there, which is §15.4's
   * model: the bytes cannot submit themselves, and the user presses Enter.
   */
  it('types /add-dir at a running session prompt, with nothing that could submit it', async () => {
    const { t, el } = await open(okStubs(), running());
    click(button(el, 'Add'));
    await flush();
    expect(payloadsFor(t.calls, 'session:write')).toEqual([{ agentId: 'a1', data: '/add-dir /wt/acmeapi/alpha' }]);
    const detail = t.ui.useUi.getState().toasts[0]?.detail ?? '';
    expect(detail).toContain('press Enter');
    // The toast must not claim the running session HAS the directory — nothing on this side can
    // observe whether Claude accepted it.
    expect(detail).not.toContain('added to the running session');
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /**
   * The reason the dialog calls `addDirKeystrokes` instead of interpolating the path itself. A
   * worktree path is `worktreesDir/<project.name>/<slug>`, and `project.name` is a repo BASENAME —
   * whatever the filesystem allowed, which on macOS is any byte but `/` and NUL. A `\r` in there
   * would press Enter on the user's behalf in a live session (G33). Without this case the naive
   * template literal passes every other assertion in this file.
   */
  it('sanitises the path it types rather than trusting it', async () => {
    const { t, el } = await open({
      ...okStubs(),
      'agent:addWorkspace': { reply: { ok: true, value: { ...WORKSPACE, worktreePath: '/wt/acmeapi/al\rpha' } } },
    }, running());
    click(button(el, 'Add'));
    await flush();
    expect(payloadsFor(t.calls, 'session:write')).toEqual([{ agentId: 'a1', data: '/add-dir /wt/acmeapi/al pha' }]);
  });

  it('writes nothing to a stopped agent, and says when Claude will get it', async () => {
    // No `setOne`, so `useSession` falls back to `initialSessionState` — activity `stopped`, the
    // state an agent that has never been started is in (§6.5's "absent = stopped").
    const { t, el } = await open(okStubs());
    click(button(el, 'Add'));
    await flush();
    expect(payloadsFor(t.calls, 'session:write')).toEqual([]);
    expect(t.ui.useUi.getState().toasts[0]?.detail).toContain('--add-dir the next time this agent starts');
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /**
   * A failed add leaves NOTHING: `addWorkspace` rolls the worktree and branch back and writes the
   * agent record only on success. So the form stays open with its values intact and pressing Add
   * again is the retry — there is no half-added workspace to clean up first, and no `session:write`
   * for a worktree that does not exist.
   */
  it('keeps the form on a failure, marks the stalled step, and types nothing', async () => {
    const gate = deferred();
    const { t, el } = await open({
      ...okStubs(gate.promise),
      'agent:addWorkspace': {
        reply: { ok: false, error: { code: 'BASE_NOT_FOUND', message: 'acmeapi: branch "nope" was not found locally or on origin' } },
        gate: gate.promise,
      },
    }, running());
    click(button(el, 'Add'));
    t.emit('agent:progress', ev('acmeapi: worktree', 'running', { agentId: 'a1' }));
    expect(steps(el)).toEqual(['running acmeapi: worktree']);
    gate.resolve();
    await flush();
    expect(steps(el)).toEqual(['error acmeapi: worktree']);
    expect(el.textContent).toContain('branch "nope" was not found');
    expect(payloadsFor(t.calls, 'session:write')).toEqual([]);
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
    expect(button(el, 'Add').disabled).toBe(false);
    expect(field(el, 'Base branch')).not.toBeNull();
  });

  /**
   * `agent:progress` is a broadcast: another agent being created while this dialog is open emits
   * into the same channel, and `reduceProgress` keys on `(opId, step)` so nothing else would keep
   * those lines out of this list.
   */
  it('ignores progress belonging to another agent', async () => {
    const gate = deferred();
    const { t, el } = await open(okStubs(gate.promise));
    click(button(el, 'Add'));
    t.emit('agent:progress', ev('hangar: worktree', 'running', { agentId: 'a2' }));
    t.emit('agent:progress', ev('acmeapi: worktree', 'running', { agentId: 'a1' }));
    expect(steps(el)).toEqual(['running acmeapi: worktree']);
    gate.resolve();
    await flush();
  });
});

/**
 * Spec 2026-09-15 §11: taking a non-primary project back off an agent. Main's half — PRIMARY_WORKSPACE,
 * the record-drop rule, REMOVE_INCOMPLETE — is tested in `agent-service.test.ts`. What is tested here
 * is the dialog: the same inspection line and typed-name gate as Delete, what it sends, and what it
 * does when the workspace changes under it.
 */
describe('Remove a project from an agent', () => {
  const stubs = (insp: DeleteInspection = secondInspection()): Stubs => ({
    'agent:inspectRemoveWorkspace': { reply: { ok: true, value: insp } },
    'agent:removeWorkspace': { reply: { ok: true, value: undefined } },
  });
  const confirmBox = (el: HTMLElement): HTMLInputElement | null => el.querySelector('input[aria-label="Type the agent\'s name to confirm"]');
  const checkbox = (el: HTMLElement, i: number): HTMLInputElement => el.querySelectorAll('input[type="checkbox"]')[i] as HTMLInputElement;
  const running = (): SessionState => ({ ...initialSessionState('a3'), activity: 'idle', pid: 4242 });
  const withoutW2 = (): WorkspaceSnapshot => snapshotWith({}, { agents: [...AGENTS, { ...GAMMA, workspaces: [GAMMA.workspaces[0]!] }] });

  async function open(s: Stubs, session: SessionState | null = null) {
    const t = await withSnapshot(s, snapshotWith({}, { agents: [...AGENTS, GAMMA] }));
    if (session) act(() => t.sessions.useSessions.getState().setOne('a3', session));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'remove-workspace', agentId: 'a3', workspaceId: 'w2' }));
    const { el } = mount(<t.DialogHost />);
    await flush();
    return { t, el };
  }

  it('inspects the one workspace and shows the line the Delete dialog shows', async () => {
    const { t, el } = await open(stubs(secondInspection({ dirtyFiles: 2, unmergedCommits: 5 })));
    expect(el.querySelector('h2')?.textContent).toBe('Remove acmeapi from gamma');
    expect(payloadsFor(t.calls, 'agent:inspectRemoveWorkspace')).toEqual([{ id: 'a3', workspaceId: 'w2' }]);
    expect(el.textContent).toContain('agent/gamma');
    expect(el.textContent).toContain('/wt/g2');
    expect(el.textContent).toContain('2 uncommitted change(s)');
    expect(el.textContent).toContain('5 unmerged commit(s)');
  });

  it('defaults to removing the directory and keeping the branch, and removes a clean workspace without forcing', async () => {
    const { t, el } = await open(stubs());
    expect(el.textContent).toContain('Remove worktree directory');
    expect(checkbox(el, 0).checked).toBe(true);
    expect(el.textContent).toContain('Delete branch');
    expect(checkbox(el, 1).checked).toBe(false);
    expect(confirmBox(el)).toBeNull();
    click(button(el, 'Remove'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:removeWorkspace')).toEqual([{ id: 'a3', workspaceId: 'w2', options: { removeWorktrees: true, deleteBranches: false, force: false } }]);
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Removed acmeapi from gamma']);
  });

  it('arms the gate by Delete’s rule, is confirmed by the AGENT’s name, and then forces', async () => {
    const { t, el } = await open(stubs(secondInspection({ dirtyFiles: 1 })));
    expect(confirmBox(el)).not.toBeNull();
    expect(button(el, 'Remove').disabled).toBe(true);
    type(confirmBox(el)!, 'acmeapi');
    expect(button(el, 'Remove').disabled).toBe(true);
    type(confirmBox(el)!, 'gamma');
    expect(button(el, 'Remove').disabled).toBe(false);
    click(button(el, 'Remove'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:removeWorkspace')).toEqual([{ id: 'a3', workspaceId: 'w2', options: { removeWorktrees: true, deleteBranches: false, force: true } }]);
  });

  it('arms on unmerged commits only once Delete branch is ticked', async () => {
    const { el } = await open(stubs(secondInspection({ unmergedCommits: 3 })));
    expect(confirmBox(el)).toBeNull();
    click(checkbox(el, 1));
    expect(confirmBox(el)).not.toBeNull();
  });

  /**
   * Measured in the Task 9 review: with the worktree kept, git always refuses the branch delete — the
   * kept worktree still has the branch checked out — so that combination could only ever fail. The
   * checkbox is disabled and cleared instead, which also disarms a gate the branch alone had armed.
   */
  it('cannot delete the branch while the worktree is kept, and says why', async () => {
    const { t, el } = await open(stubs(secondInspection({ unmergedCommits: 3 })));
    click(checkbox(el, 1));
    expect(confirmBox(el)).not.toBeNull();
    click(checkbox(el, 0));
    expect(checkbox(el, 1).disabled).toBe(true);
    expect(checkbox(el, 1).checked).toBe(false);
    expect(el.textContent).toContain('still has it checked out');
    expectBranchHint(checkbox(el, 1), true);
    expect(confirmBox(el)).toBeNull();
    click(button(el, 'Remove'));
    await flush();
    expect(payloadsFor(t.calls, 'agent:removeWorkspace')).toEqual([{ id: 'a3', workspaceId: 'w2', options: { removeWorktrees: false, deleteBranches: false, force: false } }]);
  });

  it('gives Delete branch back, still unticked, once the worktree is removed again', async () => {
    const { el } = await open(stubs());
    click(checkbox(el, 0));
    click(checkbox(el, 0));
    expect(checkbox(el, 1).disabled).toBe(false);
    expect(checkbox(el, 1).checked).toBe(false);
    expect(el.textContent).not.toContain('still has it checked out');
    expectBranchHint(checkbox(el, 1), false);
  });

  it('says a running session keeps the folder, and says nothing for a stopped one', async () => {
    const live = await open(stubs(), running());
    expect(live.el.textContent).toContain('The running session was launched with this folder and keeps it until it restarts.');
    const stopped = await open(stubs());
    expect(stopped.el.textContent).not.toContain('The running session was launched');
  });

  // Delete's dialog keeps its first inspection after a failure, so its counts can go stale — a known
  // gap spec §11.3 deliberately does not copy. This one asks again.
  it('shows a failure inline and re-runs the inspection', async () => {
    const { t, el } = await open({
      ...stubs(),
      'agent:removeWorkspace': { reply: { ok: false, error: { code: 'REMOVE_INCOMPLETE', message: 'acmeapi (agent/gamma): device is busy' } } },
    });
    click(button(el, 'Remove'));
    await flush();
    expect(el.textContent).toContain('acmeapi (agent/gamma): device is busy');
    expect(payloadsFor(t.calls, 'agent:inspectRemoveWorkspace')).toHaveLength(2);
    expect(t.ui.useUi.getState().dialog).not.toBeNull();
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  it('closes when the workspace disappears while it is open', async () => {
    const { t } = await open(stubs());
    act(() => t.workspace.useWorkspace.getState().setSnapshot(withoutW2()));
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /**
   * REMOVE_INCOMPLETE after main dropped the record anyway (§11.2 step 3: the branch delete failed once
   * the directory was already gone). The workspace vanishes while the error is on screen, so "close
   * when it vanishes" would swallow the error; it becomes a sticky toast instead.
   */
  it('turns a failure into a toast when the workspace vanished anyway', async () => {
    const gate = deferred();
    const { t, el } = await open({
      ...stubs(),
      'agent:removeWorkspace': { reply: { ok: false, error: { code: 'REMOVE_INCOMPLETE', message: 'acmeapi (agent/gamma): branch is checked out elsewhere' } }, gate: gate.promise },
    });
    click(button(el, 'Remove'));
    act(() => t.workspace.useWorkspace.getState().setSnapshot(withoutW2()));
    expect(t.ui.useUi.getState().dialog).not.toBeNull(); // still busy
    // …and still ON SCREEN: `ui.dialog` set with nothing rendered would be a blank modal state that
    // stands every shortcut down (installKeymap) with no visible reason.
    expect(el.querySelector('h2')?.textContent).toBe('Remove acmeapi from gamma');
    expect(maybeButton(el, 'Removing…')).toBeDefined();
    gate.resolve();
    await flush();
    expect(t.ui.useUi.getState().dialog).toBeNull();
    const toast = t.ui.useUi.getState().toasts[0];
    expect(toast).toMatchObject({ level: 'error', title: 'The project was removed, but not cleanly', sticky: true });
    expect(toast?.detail).toContain('branch is checked out elsewhere');
    // No re-inspection of a workspace that is already gone — main could only answer NOT_FOUND.
    expect(payloadsFor(t.calls, 'agent:inspectRemoveWorkspace')).toHaveLength(1);
  });

  /**
   * The failure kept the record (the worktree removal itself failed), so its error sits inline. If
   * the workspace is then removed from ELSEWHERE, the dialog closes — but that error was not about
   * this removal, and a sticky "removed, but not cleanly" would misreport it.
   */
  it('closes silently when a failure kept the workspace and it is then removed elsewhere', async () => {
    const { t, el } = await open({
      ...stubs(),
      'agent:removeWorkspace': { reply: { ok: false, error: { code: 'REMOVE_INCOMPLETE', message: 'acmeapi (agent/gamma): device is busy' } } },
    });
    click(button(el, 'Remove'));
    await flush();
    expect(el.textContent).toContain('device is busy');
    act(() => t.workspace.useWorkspace.getState().setSnapshot(withoutW2()));
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  // The other order: the reply lands while the workspace is still in the renderer's snapshot, and the
  // record's removal follows. The re-inspection main answers NOT_FOUND to is what keeps the report.
  it('still reports the failure when the workspace vanishes just after the reply', async () => {
    const s: Stubs = {
      ...stubs(),
      'agent:removeWorkspace': { reply: { ok: false, error: { code: 'REMOVE_INCOMPLETE', message: 'acmeapi (agent/gamma): branch is checked out elsewhere' } } },
    };
    const { t, el } = await open(s);
    s['agent:inspectRemoveWorkspace'] = { reply: { ok: false, error: { code: 'NOT_FOUND', message: 'no such workspace' } } };
    click(button(el, 'Remove'));
    await flush();
    act(() => t.workspace.useWorkspace.getState().setSnapshot(withoutW2()));
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(t.ui.useUi.getState().toasts[0]).toMatchObject({ level: 'error', title: 'The project was removed, but not cleanly', sticky: true });
  });

  // While the re-inspection is in flight nothing is known either way, so the red "could not be
  // inspected" note from the FIRST inspection must not sit beside "Inspecting the worktree…".
  it('clears an earlier inspect failure while it inspects again', async () => {
    const s: Stubs = { 'agent:removeWorkspace': { reply: { ok: false, error: { code: 'REMOVE_INCOMPLETE', message: 'acmeapi (agent/gamma): device is busy' } } } };
    const { el } = await open(s);
    expect(el.textContent).toContain('could not be inspected, so there is no way to tell what would be lost');
    type(confirmBox(el)!, 'gamma');
    const again = deferred();
    s['agent:inspectRemoveWorkspace'] = { reply: { ok: true, value: secondInspection() }, gate: again.promise };
    click(button(el, 'Remove'));
    await flush();
    expect(el.textContent).toContain('Inspecting the worktree…');
    expect(el.textContent).not.toContain('could not be inspected, so there is no way to tell what would be lost');
    again.resolve();
    await flush();
    expect(el.textContent).toContain('0 uncommitted change(s)');
  });
});

/**
 * G59. Every dialog here subscribes to a zustand store, and every one of them derives a list —
 * projects, folders, branches, workspaces, "how many agents use this project". zustand 5 hands the
 * selector to `useSyncExternalStore`, which re-runs it after each commit and commits again when
 * the identity differs, so a `.filter(...)`, `.map(...)` or `?? []` INSIDE a selector is an
 * infinite loop. Measured three times on this project at ~55 renders before React throws, with
 * `tsc`, `eslint` and every pure unit test green throughout.
 */
describe('render counts', () => {
  const stubs: Stubs = {
    'project:listBranches': { reply: { ok: true, value: { local: ['main'], remote: ['origin/main'] } } },
    'agent:inspectDelete': { reply: { ok: true, value: inspection() } },
    'agent:inspectRemoveWorkspace': { reply: { ok: true, value: inspection() } },
  };

  const cases: [string, (t: Awaited<ReturnType<typeof withSnapshot>>) => ReactNode][] = [
    ['new agent', (t) => <t.NewAgentDialog folderId="f1" />],
    ['new agent from a ticket draft', (t) => <t.NewAgentDialog folderId={null} draft={DRAFT} />],
    ['new agent from a manual draft', (t) => <t.NewAgentDialog folderId={null} draft={manualDraft('AC-3461')} />],
    ['new folder', (t) => <t.NewFolderDialog parentId="f1" />],
    ['project settings', (t) => <t.ProjectSettingsDialog projectId="p1" />],
    ['delete agent', (t) => <t.DeleteAgentDialog agentId="a1" />],
    ['add workspace', (t) => <t.AddWorkspaceDialog agentId="a1" />],
    // The dialog itself does not refuse a primary (main does, and the menu never offers one), so the
    // default snapshot's one-workspace agent is enough to count commits.
    ['remove workspace', (t) => <t.RemoveWorkspaceDialog agentId="a1" workspaceId="w-a1" />],
    ['linear', (t) => <t.LinearDialog />],
  ];

  for (const [label, render] of cases) {
    it(`commits once for ${label}, and does not loop under StrictMode`, async () => {
      const t = await withSnapshot(stubs);
      const plain = mount(render(t));
      expect(plain.commits()).toBe(1);
      const strict = mountStrict(render(t));
      expect(strict.commits()).toBeLessThanOrEqual(2);
      // The async work each of these kicks off (branch lists, the delete inspection) settles into
      // a bounded number of commits rather than a cascade.
      await flush();
      expect(plain.commits()).toBeLessThanOrEqual(3);
    });
  }

  // The loop above mounts it with no repos folder (the store default); this is its other branch.
  it('commits once for the Linear dialog with a repos folder chosen, and does not loop under StrictMode', async () => {
    const t = await withSnapshot(stubs);
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: '/Users/me/code' } }));
    expect(mount(<t.LinearDialog />).commits()).toBe(1);
    expect(mountStrict(<t.LinearDialog />).commits()).toBeLessThanOrEqual(2);
  });

  /**
   * G65's double MOUNT against the Linear dialog's unmount cleanup, which cancels whatever look-up is
   * pending. StrictMode's simulated unmount runs that cleanup once before the dialog is really in use;
   * a look-up started afterwards must be the dialog's own, not cancelled by a cleanup left over from it.
   */
  it('does not cancel a look-up started after a StrictMode double mount', async () => {
    const gate = deferred();
    const t = await withSnapshot({ 'linear:triage': { reply: { ok: true, value: DRAFT }, gate: gate.promise } });
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: '/Users/me/code' } }));
    const { el } = mountStrict(<t.LinearDialog />);
    type(field(el, 'Linear link or ticket ID'), 'AC-3461');
    click(button(el, 'Look up'));
    expect(payloadsFor(t.calls, 'linear:triage')).toHaveLength(1);
    expect(payloadsFor(t.calls, 'linear:cancel')).toEqual([]);
    gate.resolve();
    await settle();
    expect(payloadsFor(t.calls, 'linear:cancel')).toEqual([]);
  });

  /**
   * The half of StrictMode the loop above cannot see, and the reason `mountStrict` exists.
   *
   * Loop detection rides on RENDER double-invocation, which survives any nesting. The double
   * MOUNT does not — with the old `mount(<StrictMode>…</StrictMode>)` spelling the mount effect
   * ran once (G65), so nothing above was ever exercising `NewAgentDialog`'s `requested` ref.
   * Measured on this file with the corrected nesting: `project:listBranches` is sent ONCE across
   * the two mount invocations, because the ref is a `useRef` and survives the simulated remount.
   * Deleting the ref sends it twice here, which is this test's whole reason to exist — and in the
   * real app is the re-fetch loop the ref was added to stop.
   *
   * Not every dialog dedupes: `DeleteAgentDialog`'s inspection genuinely fires twice under a
   * double mount (measured). That is StrictMode behaving as designed against an idempotent
   * read guarded by its own `live` flag, not a defect, and the app does not run under StrictMode
   * anyway (G26).
   */
  it('asks for a project\'s branches once across a StrictMode double mount', async () => {
    const t = await withSnapshot(stubs);
    mountStrict(<t.NewAgentDialog folderId="f1" />);
    await flush();
    expect(payloadsFor(t.calls, 'project:listBranches')).toEqual([{ id: 'p1' }]);
  });

  /**
   * The case where `stores/workspace.ts`'s hoisted `EMPTY_PROJECTS`/`EMPTY_FOLDERS` are the whole
   * fix, and the one a snapshot-loaded test cannot reach.
   *
   * Measured while writing this: with a snapshot in the store,
   * `useWorkspace((s) => s.snapshot?.workspace.projects ?? [])` does NOT loop — `??` returns the
   * stored array and allocates nothing, so that "obviously wrong" selector passes every test
   * above. It allocates exactly when the left side is nullish, which is this test: ⌘N pressed
   * before `bootstrap()`'s `workspace:get` has answered. Replacing `useProjects()`/`useFolders()`
   * with their inline `?? []` forms fails here alone.
   */
  it('commits once with no snapshot at all — the pre-bootstrap ⌘N', async () => {
    const t = await load(stubs);
    for (const [, render] of cases) {
      const { commits } = mount(render(t));
      expect(commits()).toBe(1);
    }
  });

  it('commits once for the whole DialogHost with a dialog open', async () => {
    const t = await withSnapshot(stubs);
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null }));
    const { commits } = mount(<t.DialogHost />);
    expect(commits()).toBe(1);
  });

  it('costs a closed DialogHost nothing when an unrelated snapshot arrives', async () => {
    const t = await withSnapshot(stubs);
    const { commits } = mount(<t.DialogHost />);
    const before = commits();
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({ panes: ['a2'] })));
    expect(commits() - before).toBe(0);
  });

  /**
   * The control. Without it, "commits === 1" above could just mean the probe is blind — Task 4 and
   * Task 5 both shipped selector loops past green suites. Measured on this tree with React 19.2.8:
   * ~55 renders, then React throws "Maximum update depth exceeded".
   *
   * The selector is the exact shape a dialog invites: "the projects, or an empty list".
   */
  it('catches a selector that allocates — exactly what these dialogs must not do', async () => {
    const t = await withSnapshot(stubs);
    const Looping = (): ReactNode => {
      const projects = t.workspace.useWorkspace((s) => s.snapshot?.workspace.projects.map((p) => p.name) ?? []);
      return <span>{projects.join(',')}</span>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => mount(<Looping />)).toThrow(/Maximum update depth exceeded/);
    } finally {
      errors.mockRestore();
    }
  });
});

/**
 * G60. Task 4 shipped with right-click broken on every sidebar row while 633 tests — 8 of which
 * mounted that exact sidebar — stayed green, because not one dispatched a REAL bubbling event
 * through the real tree. These do, from the app root.
 *
 * Measured for this task: `DialogHost` is a SIBLING of `Sidebar` and `<main>` under App's root
 * `<div>`, and that root `<div>` carries no handlers of its own — so nothing above a dialog
 * handles `contextmenu`, `mousedown`, `click`, `input` or `keydown`. The dialogs therefore add NO
 * `stopPropagation()` guard: there is nothing to stop, and an untested guard here would be the
 * blind capture-phase pair Task 6 found and deleted. These tests are what keeps that true, and
 * both halves were measured by moving it: `<DialogHost />` inside `<main>` fails the placement
 * test below, and nested inside `Sidebar`'s own `<aside>` it fails the placement test AND the
 * borrowed-menu one, because `Sidebar`'s `onContextMenu` then really is an ancestor.
 */
describe('event routing through the real App', () => {
  async function mountApp(layout: Partial<Layout> = {}) {
    const t = await load({
      'workspace:get': { reply: { ok: true, value: snapshotWith(layout) } },
      'config:get': { reply: { ok: true, value: defaultAppConfig('/bin/zsh') } },
      'layout:set': { reply: { ok: true, value: undefined } },
      'app:windowFocused': { reply: { ok: true, value: undefined } },
      'agent:markOpened': { reply: { ok: true, value: undefined } },
      'project:listBranches': { reply: { ok: true, value: { local: ['main'], remote: [] } } },
      'agent:inspectDelete': { reply: { ok: true, value: inspection({ dirtyFiles: 1 }) } },
      'folder:create': { reply: { ok: true, value: FOLDERS[0]! } },
    });
    const { el } = mount(<t.App />);
    await flush();
    return { t, el };
  }

  it('mounts the dialog beside the pane grid and the sidebar, not inside either', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    const dialog = el.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect((el.querySelector('main') as HTMLElement).querySelector('dialog')).toBeNull();
    expect((el.querySelector('aside') as HTMLElement).querySelector('dialog')).toBeNull();
  });

  // The exact shape that broke the sidebar: an ancestor with its own handler for the same event.
  it('does not borrow the sidebar background menu on a right-click inside a dialog', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    const input = el.querySelector('dialog input') as HTMLElement;
    act(() => void input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })));
    expect(t.ui.useUi.getState().contextMenu).toBeNull();
  });

  it('lets typing and clicking reach the dialog through the whole tree', async () => {
    const { t, el } = await mountApp({ panes: ['a1'], focusedIndex: 0 });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-folder', parentId: null }));
    const input = el.querySelector('dialog input') as HTMLInputElement;
    act(() => input.focus());
    type(input, 'Experiments');
    expect(input.value).toBe('Experiments');
    click(button(el, 'Create'));
    await flush();
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([{ name: 'Experiments', parentId: null }]);
    expect(t.ui.useUi.getState().toasts).toEqual([]);
    // Clicking inside the dialog must not move pane focus — `Pane`'s `onMouseDownCapture` is
    // scoped to `<main>`, and this is what says the dialog is not inside it.
    expect(t.layout.layoutStore.getState().layout.focusedIndex).toBe(0);
  });

  /**
   * A modal owns the keyboard. `installKeymap`'s mode guard is what makes this true; `keymap.ts`
   * measures the guard directly, and this measures it through the real tree, with the events aimed
   * at the dialog's own input the way a user's would be.
   *
   * ⌘N is in the list and is inert here for the *second* reason, not the mode guard: since the
   * toggle rule a dialog-opener does close its own dialog, but `WORKS_IN_TEXT_FIELD['new-agent']`
   * is false and these events are aimed at the dialog's focused name field, which is where
   * `initialFocus` puts the caret. `keymap.test.ts` pins both surfaces of that.
   */
  it('leaves every Hangar shortcut inert while a dialog is up', async () => {
    const { t, el } = await mountApp({ panes: ['a1', 'a2'], focusedIndex: 0, sidebarVisible: true, drawerOpen: false });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'new-agent', folderId: null }));
    const input = el.querySelector('dialog input') as HTMLElement;
    act(() => input.focus());
    for (const init of [
      { key: 'n', metaKey: true },
      { key: 'W', metaKey: true, shiftKey: true },
      { key: 'b', metaKey: true },
      { key: 'e', metaKey: true },
      { key: '2', metaKey: true },
    ]) {
      act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
    }
    const layout = t.layout.layoutStore.getState().layout;
    expect(layout.panes).toEqual(['a1', 'a2']);
    expect(layout.focusedIndex).toBe(0);
    expect(layout.sidebarVisible).toBe(true);
    expect(layout.drawerOpen).toBe(false);
    expect(t.ui.useUi.getState().dialog).toEqual({ kind: 'new-agent', folderId: null });
  });

  // The gate is worth nothing if a keystroke aimed at the confirm box never arrives.
  it('routes the delete confirm box\'s keystrokes through the whole tree', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    act(() => t.ui.useUi.getState().openDialog({ kind: 'delete-agent', agentId: 'a1' }));
    await flush();
    const box = el.querySelector('dialog input[aria-label="Type the agent\'s name to confirm"]') as HTMLInputElement;
    expect(button(el, 'Delete').disabled).toBe(true);
    type(box, 'alpha');
    expect(button(el, 'Delete').disabled).toBe(false);
  });

  // The whole point of the task: these menu entries set `ui.dialog` and, until now, nothing
  // rendered it. Driven from the real sidebar context menu rather than from the store.
  it('opens a real dialog from the sidebar background menu', async () => {
    const { t, el } = await mountApp({ panes: ['a1'] });
    const aside = el.querySelector('aside') as HTMLElement;
    act(() => void aside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const items = t.ui.useUi.getState().contextMenu?.items ?? [];
    act(() => items.find((i) => i.label === 'New agent')?.onSelect?.());
    expect(el.querySelector('dialog')).not.toBeNull();
    expect(el.querySelector('h2')?.textContent).toBe('New agent');
  });

  /**
   * Spec §12.6: the folder select defaults to "the folder of the currently focused agent, or
   * Root". `alpha` is in `Work`, and the sidebar background menu carries no folder of its own.
   */
  it('defaults the new-agent folder to the focused agent\'s', async () => {
    const { t, el } = await mountApp({ panes: ['a1'], focusedIndex: 0 });
    const aside = el.querySelector('aside') as HTMLElement;
    act(() => void aside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    act(() => (t.ui.useUi.getState().contextMenu?.items ?? []).find((i) => i.label === 'New agent')?.onSelect?.());
    expect(picker(el, 'Folder').value).toBe('f1');
    act(() => t.ui.useUi.getState().closeDialog());
    // …and Root when the focused pane is empty.
    act(() => t.layout.layoutStore.getState().closePane(0));
    act(() => (t.ui.useUi.getState().contextMenu?.items ?? []).find((i) => i.label === 'New agent')?.onSelect?.());
    expect(picker(el, 'Folder').value).toBe('');
  });
});

/**
 * Spec 2026-09-16 §4. The list is the second way into the same look-up, so most of what matters is
 * that picking a row does EXACTLY what pasting its link does — and that a list failure costs the
 * owner nothing, because the field they already had still works.
 */
describe('LinearDialog — the ticket list (Plan 07)', () => {
  const REPOS = '/repos';

  const listed = (reply: { issues: LinearIssue[]; nextCursor: string | null }): Stub<'linear:myIssues'> => ({ reply: { ok: true, value: reply } });

  const rows = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('button[data-ticket]')];

  /**
   * The list lives past the repos-folder gate, so every test here starts with a folder chosen — the
   * plan's snippets left it at the store default (null), which renders the "Choose your repos
   * folder…" step and no list at all. `setState`, the spelling the Plan 06 block already uses:
   * `useConfig` has `load` and `set` (both of which invoke main) and no local setter.
   */
  async function openList(stubs: Stubs, snap?: WorkspaceSnapshot) {
    const t = snap === undefined ? await withSnapshot(stubs) : await withSnapshot(stubs, snap);
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: REPOS } }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    return { t, ...mount(<t.DialogHost />) };
  }

  it('fetches on open, draws a row per ticket and dims Done and Cancelled', async () => {
    const { t, el } = await openList({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }) });
    await flush();

    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}]);
    expect(rows(el).map((r) => r.getAttribute('data-ticket'))).toEqual(['AC-3461', 'AC-3400', 'AC-3399']);
    expect(rows(el)[0]?.textContent).toContain('0 Click Payments');
    expect(rows(el)[0]?.textContent).toContain('Todo');
    expect(rows(el)[0]?.textContent).toContain('cycle 32');
    expect(rows(el)[0]?.className).not.toContain('opacity-50');
    expect(rows(el)[1]?.className).toContain('opacity-50');
    expect(rows(el)[2]?.className).toContain('opacity-50');
  });

  it('picking a row runs the look-up for that ticket, exactly as Look up does', async () => {
    const { t, el } = await openList({
      'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }),
      'linear:triage': { reply: { ok: true, value: DRAFT } },
      'project:listBranches': { reply: { ok: true, value: { local: ['master'], remote: [] } } },
    });
    await flush();

    click(rows(el)[0]);
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([{ requestId: expect.stringMatching(/^triage-/) as unknown as string, ref: 'AC-3461' }]);
    // And the answer replaces this dialog with the prefilled New Agent one, as a paste does.
    expect(t.ui.useUi.getState().dialog).toMatchObject({ kind: 'new-agent', draft: DRAFT });
  });

  it('marks a ticket that already has an agent and focuses it instead of looking up again', async () => {
    const snap = snapshotWith({}, { agents: [...AGENTS, agent('a9', 'AC-3461 0 click payments')] });
    const { t, el } = await openList({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }), 'agent:markOpened': { reply: { ok: true, value: undefined } } }, snap);
    await flush();

    expect(rows(el)[0]?.textContent).toContain('agent exists');
    click(rows(el)[0]);
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([]);
    expect(t.layout.layoutStore.getState().layout.panes[0]).toBe('a9');
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  /**
   * A pick used to write the identifier into the link field, which IS the filter query — so the
   * list collapsed to the one row picked (measured: 3 rows → 1) and stayed collapsed after the
   * look-up failed, with nothing on screen saying why the other tickets had gone.
   */
  it('keeps every row in the list after a pick, and after a pick that fails', async () => {
    const { t, el } = await openList({
      'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }),
      'linear:triage': { reply: { ok: false, error: { code: 'TRIAGE_FAILED', message: "Couldn't read the ticket." } } },
    });
    await flush();

    click(rows(el)[0]);
    await settle();
    expect(el.textContent).toContain("Couldn't read the ticket.");
    expect(rows(el).map((r) => r.getAttribute('data-ticket'))).toEqual(['AC-3461', 'AC-3400', 'AC-3399']);
    expect(field(el, 'Linear link or ticket ID').value).toBe('');
    // And Continue manually still knows WHICH ticket was picked, though the field never held it.
    click(button(el, 'Continue manually'));
    expect(t.ui.useUi.getState().dialog).toMatchObject({ kind: 'new-agent', draft: { name: 'AC-3461' } });
  });

  /**
   * The rows stay on screen while a look-up runs, so they have to stop being pressable: a second
   * pick starts nothing (one look-up at a time) but must not quietly move what `Continue manually`
   * drafts onto the ticket that was never looked up.
   */
  it('ignores a second pick while a look-up runs, so Continue manually still means the first ticket', async () => {
    const gate = deferred();
    const { t, el } = await openList({
      'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }),
      'linear:triage': { reply: { ok: false, error: { code: 'TRIAGE_FAILED', message: "Couldn't read the ticket." } }, gate: gate.promise },
    });
    await flush();

    click(rows(el)[0]);
    expect(rows(el)).toHaveLength(3);
    expect(rows(el)[1]?.disabled).toBe(true);
    click(rows(el)[1]);
    expect(payloadsFor(t.calls, 'linear:triage')).toHaveLength(1);
    gate.resolve();
    await settle();
    click(button(el, 'Continue manually'));
    expect(t.ui.useUi.getState().dialog).toMatchObject({ kind: 'new-agent', draft: { name: 'AC-3461' } });
  });

  it('keeps Load more reachable while the filter hides every loaded row', async () => {
    const { t, el } = await openList({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: 'c2' }) });
    await flush();

    type(field(el, 'Linear link or ticket ID'), 'older');
    expect(rows(el)).toEqual([]);
    expect(el.textContent).toContain('No ticket matches that');
    // The ticket being filtered for is on page 2, and hiding the only button that fetches page 2
    // when the filter matches nothing is exactly when it cannot be reached.
    t.setStub('linear:myIssues', listed({ issues: MORE, nextCursor: null }));
    click(button(el, 'Load more'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}, { cursor: 'c2' }]);
    expect(rows(el).map((r) => r.getAttribute('data-ticket'))).toEqual(['AC-3200']);
  });

  it('filters as you type, and a pasted link narrows to that ticket rather than emptying the list', async () => {
    const { t, el } = await openList({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }) });
    await flush();

    type(field(el, 'Linear link or ticket ID'), 'refund');
    expect(rows(el).map((r) => r.getAttribute('data-ticket'))).toEqual(['AC-3400']);
    type(field(el, 'Linear link or ticket ID'), 'https://linear.app/acme/issue/AC-3461/zero-click');
    expect(rows(el).map((r) => r.getAttribute('data-ticket'))).toEqual(['AC-3461']);
    type(field(el, 'Linear link or ticket ID'), 'nothing matches this');
    expect(rows(el)).toEqual([]);
    expect(el.textContent).toContain('No ticket matches that');
    // Filtering never asks Linear anything — §2's rule.
    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}]);
  });

  it('Load more appends with the cursor, and disappears when there is no next page', async () => {
    const { t, el } = await openList({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: 'c2' }) });
    await flush();
    expect(rows(el)).toHaveLength(3);

    t.setStub('linear:myIssues', listed({ issues: MORE, nextCursor: null }));
    click(button(el, 'Load more'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}, { cursor: 'c2' }]);
    expect(rows(el)).toHaveLength(4);
    expect(maybeButton(el, 'Load more')).toBeUndefined();
  });

  it('Refresh re-fetches from scratch', async () => {
    const { t, el } = await openList({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }) });
    await flush();
    click(button(el, 'Refresh'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}, { refresh: true }]);
  });

  it('a list failure is one line above the list, and the link field still works', async () => {
    const { t, el } = await openList({
      'linear:myIssues': { reply: { ok: false, error: { code: 'LINEAR_NOT_CONNECTED', message: "Linear isn't connected in Claude Code. Run /mcp in any agent to connect it." } } },
      'linear:triage': { reply: { ok: true, value: DRAFT } },
      'project:listBranches': { reply: { ok: true, value: { local: ['master'], remote: [] } } },
    });
    await flush();

    expect(el.textContent).toContain("Linear isn't connected in Claude Code");
    // Announced, not a silent red line: the spinner beside the heading is `aria-hidden`, so the
    // error is the only thing that can carry the news to a screen reader.
    expect([...el.querySelectorAll('[role="status"]')].map((n) => n.textContent))
      .toContain("Linear isn't connected in Claude Code. Run /mcp in any agent to connect it.");
    expect(field(el, 'Linear link or ticket ID').disabled).toBe(false);
    // The dialog is not blocked: the Plan 06 path is untouched by a list that could not load.
    type(field(el, 'Linear link or ticket ID'), 'AC-3461');
    click(button(el, 'Look up'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage')).toHaveLength(1);
    // And the failure is NOT a toast: it belongs beside the list it describes.
    expect(t.ui.useUi.getState().toasts).toEqual([]);
  });

  it('does not loop when it mounts with no snapshot at all (G59/G61)', async () => {
    const t = await load({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }) });
    // With a repos folder, so the list — and with it the agents selector `?? EMPTY_AGENTS` this
    // test exists for — is actually rendered. `load` alone leaves `snapshot` null, which is the one
    // path where an inline `?? []` allocates and zustand 5 re-renders forever.
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: REPOS } }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    const { el, commits } = mount(<t.DialogHost />);
    await flush();
    expect(rows(el)).toHaveLength(3);
    expect(commits()).toBeLessThan(10);
  });

  /**
   * G65's double MOUNT against the list. StrictMode's simulated unmount runs the cleanup that marks
   * the dialog dead, so a `alive` ref left false there would drop the answer to the fetch the REAL
   * mount then makes, and the list would stay empty for ever. The app does not run under StrictMode
   * (G26), but this is the cheapest proof the flag is per-mount rather than a one-way latch.
   */
  it('still fills the list across a StrictMode double mount', async () => {
    const t = await withSnapshot({ 'linear:myIssues': listed({ issues: ISSUES, nextCursor: null }) });
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: REPOS } }));
    const { el } = mountStrict(<t.LinearDialog />);
    await flush();
    expect(rows(el)).toHaveLength(3);
  });
});

/**
 * Spec 2026-09-16 §5. The form's one hard rule is the one the tests spend the most on: `Draft with
 * Claude` fills what is EMPTY and touches nothing the owner typed, and a failed save keeps every
 * word of it.
 *
 * The three additions Task 7 makes beyond the plan's text are tested here too, because each of them
 * is about what the owner is allowed to lose: a create that Linear never confirmed must not offer
 * another Save as the obvious next press, a title that CLEANS to nothing must be refused before it
 * costs a model run, and a failure has to leave the caret somewhere it can be typed from.
 */
describe('LinearDialog — the New ticket form (Plan 07)', () => {
  const TEAMS = { teams: [{ id: 't1', name: 'Acme' }, { id: 't2', name: 'Infra' }] };
  /** A zero-width space, BUILT rather than typed: a literal escape in a written file is G51. */
  const ZERO_WIDTH = String.fromCodePoint(0x200b);
  const UNCONFIRMED = "Linear didn't answer in time, so the ticket may or may not have been created. Check Linear before saving again.";

  const base = (): Stubs => ({
    'linear:myIssues': { reply: { ok: true, value: { issues: ISSUES, nextCursor: null } } },
    'linear:teams': { reply: { ok: true, value: TEAMS } },
  });

  const description = (el: HTMLElement): HTMLTextAreaElement => {
    const found = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');
    if (!found) throw new Error('no Description box');
    return found;
  };

  const rows = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('button[data-ticket]')];

  /** Submits the form the way Enter in a text field does, rather than by clicking a button. */
  const pressEnter = (el: HTMLElement): void => {
    const form = el.querySelector('form');
    if (form === null) throw new Error('no form to submit');
    act(() => void form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };

  /**
   * Opens ⌘⇧L past the repos-folder gate and presses `New ticket`. `setState` on the config store,
   * as the ticket-list block does: `useConfig` has `load` and `set` (both of which invoke main) and
   * no local setter.
   */
  async function openForm(stubs: Stubs) {
    const t = await withSnapshot(stubs);
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: '/repos' } }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    const mounted = mount(<t.DialogHost />);
    await flush();
    click(button(mounted.el, 'New ticket'));
    await flush();
    return { t, ...mounted };
  }

  it('offers the fields, fixes assignee and state, and keeps Save off until there is a title and a team', async () => {
    const { t, el } = await openForm(base());
    expect(el.textContent).toContain('Assignee: you');
    expect(el.textContent).toContain('State: Backlog');
    expect(button(el, 'Save').disabled).toBe(true);

    type(field(el, 'Title'), 'Zero click payments');
    expect(button(el, 'Save').disabled).toBe(true);
    choose(picker(el, 'Team'), 't1');
    expect(button(el, 'Save').disabled).toBe(false);
    // Teams were fetched once, when the form opened — not when the dialog did.
    expect(payloadsFor(t.calls, 'linear:teams')).toHaveLength(1);
  });

  it('Draft with Claude fills only the empty fields, and never runs on its own', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:draftTicket': { reply: { ok: true, value: { description: 'Charge the saved card.', estimate: 5, priority: 4, teamId: 't2', projectId: 'Payments' } } },
    });
    // Nothing has been drafted yet: pressing nothing spends nothing (§2).
    expect(payloadsFor(t.calls, 'linear:draftTicket')).toEqual([]);

    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Priority'), '1');
    click(button(el, 'Draft with Claude'));
    await settle();

    expect(payloadsFor(t.calls, 'linear:draftTicket')).toEqual([{ requestId: expect.stringMatching(/^draft-/) as unknown as string, title: 'Zero click payments' }]);
    expect(description(el).value).toBe('Charge the saved card.');
    expect(field(el, 'Estimate').value).toBe('5');
    expect(picker(el, 'Team').value).toBe('t2');
    expect(field(el, 'Project').value).toBe('Payments');
    // The one field the owner set themselves is untouched.
    expect(picker(el, 'Priority').value).toBe('1');
    // And the title they typed is still theirs.
    expect(field(el, 'Title').value).toBe('Zero click payments');
  });

  it('a failed draft leaves every field exactly as it was, says why, and leaves the caret in the title', async () => {
    const { t, el } = await openForm({ ...base(), 'linear:draftTicket': { reply: { ok: false, error: { code: 'DRAFT_FAILED', message: "Couldn't draft the ticket: claude exited with status 1" } } } });
    type(field(el, 'Title'), 'Zero click payments');
    type(description(el), 'mine');
    click(button(el, 'Draft with Claude'));
    await settle();
    expect(el.textContent).toContain("Couldn't draft the ticket");
    expect(description(el).value).toBe('mine');
    expect(t.ui.useUi.getState().toasts).toEqual([]);
    // The fields are `disabled` while the draft runs and Chromium drops focus from a control that
    // becomes disabled, so the form puts it back. jsdom proves only WHICH element was focused —
    // that Chromium drops it in the first place is a CDP question (G62/G66).
    expect(document.activeElement).toBe(field(el, 'Title'));
  });

  it('Save creates the ticket and offers an agent for it', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:createTicket': { reply: { ok: true, value: { identifier: 'AC-3500', url: 'https://linear.app/acme/issue/AC-3500/zero-click' } } },
      'linear:triage': { reply: { ok: true, value: DRAFT } },
      'app:copyToClipboard': { reply: { ok: true, value: undefined } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    expect(payloadsFor(t.calls, 'linear:createTicket')).toEqual([{
      fields: { title: 'Zero click payments', description: '', estimate: null, priority: null, teamId: 't1', projectId: null, assigneeSelf: true, state: 'Backlog' },
    }]);
    expect(t.ui.useUi.getState().toasts.map((x) => x.title)).toEqual(['Created AC-3500']);
    expect(el.textContent).toContain('Created AC-3500. Open an agent for it?');

    click(button(el, 'Copy link'));
    expect(payloadsFor(t.calls, 'app:copyToClipboard')).toEqual([{ text: 'https://linear.app/acme/issue/AC-3500/zero-click' }]);

    click(button(el, 'Open an agent'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([{ requestId: expect.stringMatching(/^triage-/) as unknown as string, ref: 'AC-3500' }]);
    expect(t.ui.useUi.getState().dialog).toMatchObject({ kind: 'new-agent', draft: DRAFT });
  });

  it('Not now closes the dialog and creates nothing else', async () => {
    const { t, el } = await openForm({ ...base(), 'linear:createTicket': { reply: { ok: true, value: { identifier: 'AC-3500', url: '' } } } });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();
    // With no link there is nothing to copy, so the button is not offered.
    expect(maybeButton(el, 'Copy link')).toBeUndefined();
    click(button(el, 'Not now'));
    expect(t.ui.useUi.getState().dialog).toBeNull();
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([]);
  });

  it('a failed save keeps everything typed and shows the reason inline', async () => {
    const { el } = await openForm({ ...base(), 'linear:createTicket': { reply: { ok: false, error: { code: 'LINEAR_FAILED', message: 'Linear rejected that: estimate is not enabled for this team' } } } });
    type(field(el, 'Title'), 'Zero click payments');
    type(description(el), 'Charge a saved card.');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    expect(el.textContent).toContain('Linear rejected that: estimate is not enabled');
    expect(field(el, 'Title').value).toBe('Zero click payments');
    expect(description(el).value).toBe('Charge a saved card.');
    expect(picker(el, 'Team').value).toBe('t1');
    expect(button(el, 'Save').disabled).toBe(false);
    // Save IS the right button for a rejection — Linear answered, and it answered no — so the caret
    // goes back where the answer can be acted on.
    expect(document.activeElement).toBe(field(el, 'Title'));
  });

  /**
   * The one failure where pressing Save again is the wrong answer: the write may already have made
   * the ticket. So the primary button becomes the one that goes and LOOKS, saving again is a
   * separate, plainly-labelled act, and Enter — which submits this form everywhere else — does
   * nothing at all.
   */
  it('never offers a blind retry after an unconfirmed create', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:createTicket': { reply: { ok: false, error: { code: LINEAR_CREATE_UNCONFIRMED, message: UNCONFIRMED } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    type(description(el), 'Charge a saved card.');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    expect(el.textContent).toContain('may or may not have been created');
    expect(maybeButton(el, 'Save')).toBeUndefined();
    expect(button(el, 'Check the ticket list').className).toContain('bg-accent');
    expect(button(el, 'Save anyway').className).not.toContain('bg-accent');
    // The caret is on the check, not on the write.
    expect(document.activeElement).toBe(button(el, 'Check the ticket list'));

    // Enter used to be a second Save. It is now nothing.
    pressEnter(el);
    await settle();
    expect(payloadsFor(t.calls, 'linear:createTicket')).toHaveLength(1);
    // Nothing typed was lost, so whichever answer the list gives, the ticket is still there to file.
    expect(field(el, 'Title').value).toBe('Zero click payments');
    expect(description(el).value).toBe('Charge a saved card.');
    // And the deliberate button is gated on exactly what Save was gated on — it is a create too, so
    // an estimate the wire would refuse stops it here rather than at `TicketFieldsSchema`.
    type(field(el, 'Estimate'), '500');
    expect(button(el, 'Save anyway').disabled).toBe(true);
  });

  it('checking the list refreshes it and still holds the ticket that was typed', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:createTicket': { reply: { ok: false, error: { code: LINEAR_CREATE_UNCONFIRMED, message: UNCONFIRMED } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    click(button(el, 'Check the ticket list'));
    await settle();
    // A refresh, not a cached read: the question being asked is whether Linear has the ticket.
    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}, { refresh: true }]);
    expect(rows(el)).toHaveLength(3);

    click(button(el, 'New ticket'));
    await flush();
    expect(field(el, 'Title').value).toBe('Zero click payments');
    expect(picker(el, 'Team').value).toBe('t1');
    // Having looked, Save is an ordinary primary button again.
    expect(button(el, 'Save').disabled).toBe(false);
  });

  /**
   * A title made only of invisible characters is not a title. `stripUntrustedText` deletes them —
   * so this would reach Linear as an empty title, or spend a `claude -p` drafting for nothing.
   */
  it('refuses a title that cleans to nothing before spending a draft or a create', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:draftTicket': { reply: { ok: true, value: { description: 'nope' } } },
      'linear:createTicket': { reply: { ok: true, value: { identifier: 'AC-3500', url: '' } } },
    });
    type(field(el, 'Title'), `${ZERO_WIDTH}${ZERO_WIDTH}`);
    choose(picker(el, 'Team'), 't1');

    expect(el.textContent).toContain('A title needs at least one visible character.');
    expect(button(el, 'Save').disabled).toBe(true);
    expect(button(el, 'Draft with Claude').disabled).toBe(true);
    pressEnter(el);
    await settle();
    expect(payloadsFor(t.calls, 'linear:draftTicket')).toEqual([]);
    expect(payloadsFor(t.calls, 'linear:createTicket')).toEqual([]);

    // One visible character is enough, and it is the CLEANED title that goes out.
    type(field(el, 'Title'), `${ZERO_WIDTH}Zero click payments${ZERO_WIDTH}`);
    expect(button(el, 'Save').disabled).toBe(false);
    click(button(el, 'Save'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:createTicket')).toMatchObject([{ fields: { title: 'Zero click payments' } }]);
  });

  it('Back returns to the list without asking Linear anything again', async () => {
    const { t, el } = await openForm(base());
    click(button(el, 'Back'));
    await flush();
    expect(rows(el)).toHaveLength(3);
    expect(payloadsFor(t.calls, 'linear:myIssues')).toEqual([{}]);
  });

  /**
   * Main answers a request whose page chain a Refresh has superseded with "the list as I hold it
   * right now" — and before the first page has ever landed, that is an EMPTY list. Two list reads
   * can be in flight at once here because `Check the ticket list` refreshes from inside the form,
   * where the dialog's own opening fetch may still be running. An empty answer from the read that
   * was left behind is not news about the owner's tickets.
   */
  it('keeps loading rather than saying the list is empty when a superseded answer lands first', async () => {
    const opener = deferred();
    const refresh = deferred();
    const { t, el } = await openForm({
      ...base(),
      'linear:myIssues': { reply: { ok: true, value: { issues: [], nextCursor: null } }, gate: opener.promise },
      'linear:createTicket': { reply: { ok: false, error: { code: LINEAR_CREATE_UNCONFIRMED, message: UNCONFIRMED } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    t.setStub('linear:myIssues', { reply: { ok: true, value: { issues: ISSUES, nextCursor: null } }, gate: refresh.promise });
    click(button(el, 'Check the ticket list'));
    await flush();

    opener.resolve();
    await settle();
    expect(el.textContent).not.toContain('No tickets are assigned to you');
    expect(rows(el)).toEqual([]);
    expect(button(el, 'Refresh').disabled).toBe(true);

    refresh.resolve();
    await settle();
    expect(rows(el)).toHaveLength(3);
    expect(button(el, 'Refresh').disabled).toBe(false);
  });

  it('ignores a superseded answer that lands after the refresh it was replaced by', async () => {
    const opener = deferred();
    const { t, el } = await openForm({
      ...base(),
      'linear:myIssues': { reply: { ok: true, value: { issues: [], nextCursor: null } }, gate: opener.promise },
      'linear:createTicket': { reply: { ok: false, error: { code: LINEAR_CREATE_UNCONFIRMED, message: UNCONFIRMED } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    t.setStub('linear:myIssues', { reply: { ok: true, value: { issues: ISSUES, nextCursor: null } } });
    click(button(el, 'Check the ticket list'));
    await settle();
    expect(rows(el)).toHaveLength(3);

    // The read the refresh left behind, answering last. It must not become the list.
    opener.resolve();
    await settle();
    expect(rows(el)).toHaveLength(3);
    expect(el.textContent).not.toContain('No tickets are assigned to you');
  });

  /**
   * `Save anyway` is an ordinary button, not a submit — so the browser never checks the number
   * field's `min`/`max`, and an estimate of 500 used to reach main and come back as a `BAD_REQUEST`
   * with nothing to show. `ticketFieldsProblem` names it instead, at both ends of the wire.
   */
  it('refuses an out-of-range estimate inline, where the browser bubble never was', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:createTicket': { reply: { ok: true, value: { identifier: 'AC-3500', url: '' } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    expect(button(el, 'Save').disabled).toBe(false);

    type(field(el, 'Estimate'), '500');
    expect(el.textContent).toContain('An estimate is a whole number between 0 and 100.');
    expect(button(el, 'Save').disabled).toBe(true);
    pressEnter(el);
    await settle();
    expect(payloadsFor(t.calls, 'linear:createTicket')).toEqual([]);

    // In range, it saves — so the gate is the bound and not the field having been touched.
    type(field(el, 'Estimate'), '5');
    expect(button(el, 'Save').disabled).toBe(false);
    click(button(el, 'Save'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:createTicket')).toMatchObject([{ fields: { estimate: 5 } }]);
  });

  /**
   * `BUSY` is refused by main BEFORE anything is sent — no request to Linear, no cache write — so it
   * is the one create failure where nothing at all happened, and the ticket has to still be there to
   * press Save on again.
   */
  it('keeps the ticket, and Save, when a concurrent create is refused as BUSY', async () => {
    const { t, el } = await openForm({
      ...base(),
      'linear:createTicket': { reply: { ok: false, error: { code: 'BUSY', message: 'Another ticket is still being created. Try again in a moment.' } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    type(description(el), 'Charge a saved card.');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();

    expect(el.textContent).toContain('Another ticket is still being created');
    expect(field(el, 'Title').value).toBe('Zero click payments');
    expect(description(el).value).toBe('Charge a saved card.');
    expect(picker(el, 'Team').value).toBe('t1');
    // Nothing was sent, so Save — not `Save anyway` — is the right button, and it is still primary.
    expect(maybeButton(el, 'Save anyway')).toBeUndefined();
    expect(button(el, 'Save').disabled).toBe(false);
    click(button(el, 'Save'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:createTicket')).toHaveLength(2);
  });

  /**
   * The team list answers whenever it answers. Keying the focus recovery on `error` meant a team
   * list that failed LATE pulled the caret out of whatever was being typed at that moment.
   */
  it('a late team-list failure does not take the caret away from what is being typed', async () => {
    const teams = deferred();
    const { el } = await openForm({
      ...base(),
      'linear:teams': { reply: { ok: false, error: { code: 'LINEAR_FAILED', message: 'Linear would not list your teams.' } }, gate: teams.promise },
    });
    const box = description(el);
    act(() => box.focus());
    type(box, 'half a sentence');

    teams.resolve();
    await settle();
    expect(el.textContent).toContain('Linear would not list your teams.');
    // jsdom has no focusability rules of its own (G66), so what this pins is that NOTHING called
    // focus() on another control — which is exactly the bug.
    expect(document.activeElement).toBe(box);
    expect(description(el).value).toBe('half a sentence');
  });

  /**
   * The other half of the same rule: the team list must not overwrite what a run just said either.
   * They shared one message slot, so a list that failed a second after a save did replaced "the
   * ticket may or may not have been created" with a sentence about teams.
   */
  it('a late team-list failure never replaces what a run just said', async () => {
    const teams = deferred();
    const { el } = await openForm({
      ...base(),
      'linear:teams': { reply: { ok: false, error: { code: 'LINEAR_FAILED', message: 'Linear would not list your teams.' } }, gate: teams.promise },
      'linear:draftTicket': { reply: { ok: false, error: { code: 'DRAFT_FAILED', message: "Couldn't draft the ticket: claude exited with status 1" } } },
    });
    const alert = (): string => el.querySelector('[role="alert"]')?.textContent ?? '';
    type(field(el, 'Title'), 'Zero click payments');
    click(button(el, 'Draft with Claude'));
    await settle();
    expect(alert()).toContain("Couldn't draft the ticket");

    teams.resolve();
    await settle();
    // Both are on screen, and the answer the owner's own press produced still owns the alert.
    expect(alert()).toContain("Couldn't draft the ticket");
    expect(el.textContent).toContain('Linear would not list your teams.');
  });

  it('puts the caret on Open an agent when the created step appears', async () => {
    const { el } = await openForm({
      ...base(),
      'linear:createTicket': { reply: { ok: true, value: { identifier: 'AC-3500', url: '' } } },
    });
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');
    click(button(el, 'Save'));
    await settle();
    // `Dialog` applied `initialFocus` on showModal(), long before this step existed, so without a
    // focus call of its own the step opens on <body> and the offer answers no key at all.
    expect(document.activeElement).toBe(button(el, 'Open an agent'));
  });

  /**
   * An unconfirmed create tells the owner to go and look at Linear — and Escape is one key from
   * doing that. The ticket they typed lives in the ui store precisely so that closing the dialog
   * they were told to leave does not throw it away.
   */
  it('keeps the typed ticket when the dialog is closed and reopened', async () => {
    const { t, el } = await openForm(base());
    type(field(el, 'Title'), 'Zero click payments');
    choose(picker(el, 'Team'), 't1');

    act(() => t.ui.useUi.getState().closeDialog());
    await flush();
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    await flush();
    // It reopens on the LIST, as ⌘⇧L always does — the ticket is waiting behind `New ticket`.
    click(button(el, 'New ticket'));
    await flush();
    expect(field(el, 'Title').value).toBe('Zero click payments');
    expect(picker(el, 'Team').value).toBe('t1');
  });

  /**
   * G65 against the form's own mount effect: StrictMode's simulated unmount marks it dead, so an
   * `alive` ref set only to false there would drop the team list the REAL mount asked for and leave
   * the picker permanently empty.
   */
  it('still fills the team picker across a StrictMode double mount', async () => {
    const t = await withSnapshot(base());
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: '/repos' } }));
    const { el } = mountStrict(<t.LinearDialog />);
    await flush();
    click(button(el, 'New ticket'));
    await settle();
    expect([...picker(el, 'Team').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Choose a team…', 'Acme', 'Infra']);
  });

  it('does not loop with no snapshot and no teams (G59/G61)', async () => {
    const t = await load({ 'linear:myIssues': { reply: { ok: true, value: { issues: [], nextCursor: null } } }, 'linear:teams': { reply: { ok: true, value: { teams: [] } } } });
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: '/repos' } }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    const m = mount(<t.DialogHost />);
    await flush();
    click(button(m.el, 'New ticket'));
    await settle();
    expect(m.commits()).toBeLessThan(15);
  });
});

/**
 * Plan 08 §3 steps 1–4: the cycle step up to the moment the button is pressed. Nothing here spends
 * usage — `linear:cycles` and `linear:cycleIssues` are MCP reads with no model in them — so these
 * tests are about the three answers the step must never blur into one (Linear could not be reached,
 * Linear answered with nothing, this cycle has nothing of yours) and about the tick boxes.
 */
describe('LinearDialog — choosing a cycle (Plan 08)', () => {
  const REPOS = '/repos';

  /**
   * The instants Linear really sends: a boundary is the TEAM's local midnight, and cycle 32's
   * `endsAt` is the same instant as cycle 33's `startsAt` (measured). `endsAt` is EXCLUSIVE, so
   * `cycleLabel` prints the day before it — `15 Sep – 28 Sep`, not `15 Sep – 29 Sep`.
   */
  const CYCLES: LinearCycle[] = [
    { id: 'cy-33', number: 33, startsAt: '2026-09-28T22:00:00.000Z', endsAt: '2026-10-12T22:00:00.000Z', isCurrent: true, teamId: 'tu1', teamName: 'Acme' },
    { id: 'cy-32', number: 32, startsAt: '2026-09-14T22:00:00.000Z', endsAt: '2026-09-28T22:00:00.000Z', isCurrent: false, teamId: 'tu1', teamName: 'Acme' },
  ];

  const CYCLE_ISSUES: LinearIssue[] = [
    { identifier: 'AC-1368', title: 'First', state: 'Todo', stateType: 'unstarted', ...team, cycleId: 'cy-33', cycleNumber: 33, updatedAt: ISO, url: '' },
    { identifier: 'AC-1369', title: 'Second', state: 'In Progress', stateType: 'started', ...team, cycleId: 'cy-33', cycleNumber: 33, updatedAt: ISO, url: '' },
    { identifier: 'AC-1370', title: 'Finished', state: 'Done', stateType: 'completed', ...team, cycleId: 'cy-33', cycleNumber: 33, updatedAt: ISO, url: '' },
  ];

  const baseStubs = (): Stubs => ({
    'linear:myIssues': { reply: { ok: true, value: { issues: ISSUES, nextCursor: null } } },
    'linear:cycles': { reply: { ok: true, value: { cycles: CYCLES } } },
    'linear:cycleIssues': { reply: { ok: true, value: { issues: CYCLE_ISSUES } } },
  });

  const boxes = (el: HTMLElement): HTMLInputElement[] => [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-ticket]')];
  const boxFor = (el: HTMLElement, id: string): HTMLInputElement => {
    const found = el.querySelector<HTMLInputElement>(`input[type="checkbox"][data-ticket="${id}"]`);
    if (!found) throw new Error(`no tick box for ${id}`);
    return found;
  };

  async function openCycle(stubs: Stubs = baseStubs(), snap?: WorkspaceSnapshot) {
    const t = snap === undefined ? await withSnapshot(stubs) : await withSnapshot(stubs, snap);
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: REPOS } }));
    act(() => t.ui.useUi.getState().openDialog({ kind: 'linear' }));
    const mounted = mount(<t.DialogHost />);
    await flush();
    click(button(mounted.el, 'Whole cycle…'));
    await settle();
    return { t, ...mounted };
  }

  it('lists the cycles newest first, labelled with their dates, current first and pre-chosen', async () => {
    const { t, el } = await openCycle();
    expect(payloadsFor(t.calls, 'linear:cycles')).toEqual([{ refresh: false }]);
    const options = [...picker(el, 'Cycle').options].map((o) => o.textContent);
    expect(options).toEqual(['Cycle 33 · 29 Sep – 12 Oct (current)', 'Cycle 32 · 15 Sep – 28 Sep']);
    // The current cycle is chosen for you, and its tickets are already listed.
    expect(picker(el, 'Cycle').value).toBe('cy-33');
    expect(payloadsFor(t.calls, 'linear:cycleIssues')).toEqual([{ cycleId: 'cy-33' }]);
  });

  it('ticks everything but Done, Cancelled and a ticket that already has an agent', async () => {
    const snap = snapshotWith({}, { agents: [...AGENTS, agent('a9', 'AC-1369 second')] });
    const { el } = await openCycle(baseStubs(), snap);
    expect(boxes(el).map((b) => `${b.getAttribute('data-ticket')}:${b.checked}`)).toEqual(['AC-1368:true', 'AC-1369:false', 'AC-1370:false']);
    expect(el.textContent).toContain('agent exists');
    expect(button(el, 'Create 1 agent')).toBeTruthy();
  });

  it('Select all and Select none move every box, and the button tracks them', async () => {
    const { el } = await openCycle();
    click(button(el, 'Select all'));
    expect(boxes(el).every((b) => b.checked)).toBe(true);
    expect(button(el, 'Create 3 agents')).toBeTruthy();
    click(button(el, 'Select none'));
    expect(boxes(el).some((b) => b.checked)).toBe(false);
    expect(button(el, 'Create 0 agents').disabled).toBe(true);
  });

  it('states the count, the time, the folder and that nothing starts', async () => {
    const { el } = await openCycle();
    expect(el.textContent).toContain('2 tickets · about 1 minute · folder "Cycle 33" · agents are not started');
    click(boxFor(el, 'AC-1370'));
    expect(el.textContent).toContain('3 tickets · about 2 minutes · folder "Cycle 33" · agents are not started');
  });

  it('re-lists when another cycle is chosen, and starts its tick boxes from scratch', async () => {
    const { t, el } = await openCycle();
    click(button(el, 'Select none'));
    t.setStub('linear:cycleIssues', { reply: { ok: true, value: { issues: [CYCLE_ISSUES[0]!] } } });
    choose(picker(el, 'Cycle'), 'cy-32');
    await settle();
    expect(payloadsFor(t.calls, 'linear:cycleIssues')).toEqual([{ cycleId: 'cy-33' }, { cycleId: 'cy-32' }]);
    expect(boxes(el).map((b) => b.checked)).toEqual([true]);
  });

  it('shows the LINEAR_* message with a Retry when the cycles will not load, and leaves the ticket list working', async () => {
    const stubs = baseStubs();
    stubs['linear:cycles'] = { reply: { ok: false, error: { code: 'LINEAR_NOT_CONNECTED', message: "Linear isn't connected in Claude Code. Run /mcp in any agent to connect it." } } };
    const { el } = await openCycle(stubs);
    expect(el.textContent).toContain("Linear isn't connected in Claude Code");
    // A failure is NOT the empty answer: that sentence must not be on screen beside this one.
    expect(el.textContent).not.toContain('No cycles found for your teams.');
    click(button(el, 'Back'));
    expect(el.querySelector('input[aria-label="Linear link or ticket ID"]')).toBeTruthy();
  });

  it('a LINEAR_REAUTH keeps its reconnect hint, and Retry drops the cache and asks again', async () => {
    const stubs = baseStubs();
    stubs['linear:cycles'] = { reply: { ok: false, error: { code: 'LINEAR_REAUTH', message: 'Linear needs reconnecting in Claude Code — run /mcp in any agent, then try again.' } } };
    const { t, el } = await openCycle(stubs);
    expect(el.textContent).toContain('run /mcp in any agent, then try again.');

    t.setStub('linear:cycles', { reply: { ok: true, value: { cycles: CYCLES } } });
    click(button(el, 'Retry'));
    await settle();
    // `refresh: true` — main caches the picker for the app run, so a plain re-read would serve the
    // same failure back and the button would do nothing.
    expect(payloadsFor(t.calls, 'linear:cycles')).toEqual([{ refresh: false }, { refresh: true }]);
    expect(el.textContent).not.toContain('run /mcp in any agent');
    expect(picker(el, 'Cycle').value).toBe('cy-33');
  });

  it('says "No cycles found" — with no Retry — when Linear answered and there simply are none', async () => {
    const stubs = baseStubs();
    stubs['linear:cycles'] = { reply: { ok: true, value: { cycles: [] } } };
    const { t, el } = await openCycle(stubs);
    expect(el.textContent).toContain('No cycles found for your teams.');
    expect(maybeButton(el, 'Retry')).toBeUndefined();
    // Nothing was chosen, so nothing was listed: an empty answer costs no further request.
    expect(payloadsFor(t.calls, 'linear:cycleIssues')).toEqual([]);
  });

  it('says so rather than showing an empty box when a cycle has nothing assigned to you', async () => {
    const stubs = baseStubs();
    stubs['linear:cycleIssues'] = { reply: { ok: true, value: { issues: [] } } };
    const { el } = await openCycle(stubs);
    expect(el.textContent).toContain('No tickets in this cycle are assigned to you.');
    expect(maybeButton(el, 'Create 0 agents')?.disabled).toBe(true);
  });

  it('shows the cycle ticket list failing above the list, with the cycle select still working', async () => {
    const stubs = baseStubs();
    stubs['linear:cycleIssues'] = { reply: { ok: false, error: { code: 'LINEAR_UNAVAILABLE', message: 'Linear is unavailable right now.' } } };
    const { t, el } = await openCycle(stubs);
    expect(el.textContent).toContain('Linear is unavailable right now.');
    // Not the empty-list sentence: the list did not come back empty, it did not come back at all.
    expect(el.textContent).not.toContain('No tickets in this cycle are assigned to you.');
    t.setStub('linear:cycleIssues', { reply: { ok: true, value: { issues: CYCLE_ISSUES } } });
    choose(picker(el, 'Cycle'), 'cy-32');
    await settle();
    expect(el.textContent).not.toContain('Linear is unavailable right now.');
    expect(boxes(el)).toHaveLength(3);
  });

  it('renders once and does not loop on a store with no snapshot at all (G59/G61)', async () => {
    const t = await load(baseStubs());
    act(() => t.config.useConfig.setState({ config: { ...defaultAppConfig('/bin/zsh'), reposDir: REPOS } }));
    const { commits } = mountStrict(<t.CycleRun onBack={() => undefined} onDone={() => undefined} />);
    await flush();
    expect(commits()).toBeLessThanOrEqual(8);
  });

  const draftFor = (identifier: string): TicketDraft => ({
    name: `${identifier} the work`,
    folder: { kind: 'root' },
    rows: [{ kind: 'existing', projectId: 'p2' }],
    notes: `${identifier} — notes`,
    droppedRepos: [],
    fromTriage: true,
  });

  /** The folder the run makes for cycle 33, as `folder:create` answers with it. */
  const CYCLE_FOLDER: Folder = { id: 'f-cycle', name: 'Cycle 33', parentId: null, sortKey: 2, collapsed: false };

  const runStubs = (): Stubs => ({
    ...baseStubs(),
    'linear:triage': { reply: { ok: true, value: draftFor('AC-1368') } },
    'folder:create': { reply: { ok: true, value: CYCLE_FOLDER } },
    'agent:create': { reply: { ok: true, value: CREATED } },
    'agent:update': { reply: { ok: true, value: CREATED } },
    'app:diskFree': { reply: { ok: true, value: { freeBytes: 9e9, path: '/h/worktrees' } } },
  });

  /**
   * The two async guards in `loadIssues`/`loadCycles`, each held open with the harness's `gate` so
   * the interleaving is real: without them both tests below pass silently, which is what made them
   * worth writing.
   */
  it('drops a cycle ticket list that lands after the picker has moved on', async () => {
    const held = deferred();
    const stubs = baseStubs();
    stubs['linear:cycleIssues'] = { reply: { ok: true, value: { issues: CYCLE_ISSUES } }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    // cy-33's read is still in flight — nothing is listed yet, and the list says so out loud rather
    // than through an `aria-hidden` spinner nobody is told about.
    expect(boxes(el)).toHaveLength(0);
    expect(el.querySelector('[role="group"]')?.getAttribute('aria-busy')).toBe('true');

    t.setStub('linear:cycleIssues', { reply: { ok: true, value: { issues: [CYCLE_ISSUES[0]!] } } });
    choose(picker(el, 'Cycle'), 'cy-32');
    await settle();
    expect(boxes(el).map((b) => b.getAttribute('data-ticket'))).toEqual(['AC-1368']);

    held.resolve();
    await settle();
    // The stale answer belongs to a cycle the owner has left: it neither re-lists nor re-ticks.
    expect(boxes(el).map((b) => b.getAttribute('data-ticket'))).toEqual(['AC-1368']);
    expect(el.querySelector('[role="group"]')?.getAttribute('aria-busy')).toBe('false');
  });

  it('asks for nothing more when the cycle list lands after the step is gone', async () => {
    const held = deferred();
    const stubs = baseStubs();
    stubs['linear:cycles'] = { reply: { ok: true, value: { cycles: CYCLES } }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    click(button(el, 'Back'));
    held.resolve();
    await settle();
    // Choosing the current cycle is what sends the ticket read, so an unguarded late answer is a
    // request made by a step that no longer exists — visible here as the call that must not happen.
    expect(payloadsFor(t.calls, 'linear:cycleIssues')).toEqual([]);
  });

  it('announces the plan line and names the ticket group', async () => {
    const { el } = await openCycle();
    expect(el.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Assigned to you in this cycle');
    // A bare <p> here changes silently every time a box is ticked.
    expect([...el.querySelectorAll('[role="status"]')].map((n) => n.textContent))
      .toContain('2 tickets · about 1 minute · folder "Cycle 33" · agents are not started');
  });

  it('drops a ticket that gains an agent while the step is open, so the button cannot over-promise', async () => {
    const { t, el } = await openCycle(runStubs());
    expect(button(el, 'Create 2 agents')).toBeTruthy();
    // Another window made one while the owner was still ticking boxes.
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { agents: [...AGENTS, agent('a9', 'AC-1369 second')] })));
    expect(button(el, 'Create 1 agent')).toBeTruthy();
    expect(boxFor(el, 'AC-1369').checked).toBe(false);
    expect(boxFor(el, 'AC-1369').disabled).toBe(true);

    click(button(el, 'Create 1 agent'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage').map((p) => (p as { ref: string }).ref)).toEqual(['AC-1368']);
  });

  it('looks up and creates one ticket at a time, in list order, and never two at once', async () => {
    const { t, el } = await openCycle(runStubs());
    click(button(el, 'Select all'));

    // Each look-up is gated, so a second one starting early is visible as an extra call.
    const first = deferred();
    t.setStub('linear:triage', { reply: { ok: true, value: draftFor('AC-1368') }, gate: first.promise });
    click(button(el, 'Create 3 agents'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([{ requestId: expect.stringMatching(/^cycle-/) as unknown as string, ref: 'AC-1368' }]);
    expect(el.textContent).toContain('looking up…');
    // The tally is live while the run goes, so it must not be ANNOUNCED — "Created 0 of 3" read out
    // mid-run says the run has finished and made nothing.
    expect(el.textContent).toContain('Created 0 of 3 agents in "Cycle 33"');
    expect([...el.querySelectorAll('[role="status"]')].map((n) => n.textContent)).not.toContain('Created 0 of 3 agents in "Cycle 33"');

    t.setStub('linear:triage', { reply: { ok: true, value: draftFor('AC-1369') } });
    first.resolve();
    await settle();
    const refs = payloadsFor(t.calls, 'linear:triage').map((p) => (p as { ref: string }).ref);
    expect(refs).toEqual(['AC-1368', 'AC-1369', 'AC-1370']);
  });

  it('creates each agent through the single-ticket sequence, into the cycle folder, unstarted', async () => {
    const { t, el } = await openCycle(runStubs());
    click(button(el, 'Create 2 agents'));
    await settle();

    // The payload, not the count: "one folder for the whole run" needs the workspace push that
    // `folder:create` causes in the app, and that is the test two below.
    expect(payloadsFor(t.calls, 'folder:create')[0]).toEqual({ name: 'Cycle 33', parentId: null });
    const created = payloadsFor(t.calls, 'agent:create');
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ folderId: 'f-cycle', startNow: false, workspaces: [{ projectId: 'p2', baseBranch: null }] });
    // The notes from each draft are saved, as the single-ticket path saves them.
    expect(payloadsFor(t.calls, 'agent:update')).toHaveLength(2);
  });

  it('makes the cycle folder once, not once per ticket', async () => {
    const { t, el } = await openCycle(runStubs(), snapshotWith({}, { folders: [...FOLDERS, CYCLE_FOLDER] }));
    click(button(el, 'Create 2 agents'));
    await settle();
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([]);
    expect(payloadsFor(t.calls, 'agent:create')[0]).toMatchObject({ folderId: 'f-cycle' });
  });

  it('reuses the folder the first ticket made rather than making a second', async () => {
    const stubs = runStubs();
    const held = deferred();
    stubs['agent:create'] = { reply: { ok: true, value: CREATED }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    click(button(el, 'Create 2 agents'));
    await settle();
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([{ name: 'Cycle 33', parentId: null }]);

    // Main pushes the new workspace the moment it writes the folder; `bootstrap` puts it in the
    // store, and these dialog tests do not run `bootstrap`, so the push is made by hand here.
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { folders: [...FOLDERS, CYCLE_FOLDER] })));
    held.resolve();
    await settle();
    // The second ticket's own sequence finds it. The run tracked nothing to make that true.
    expect(payloadsFor(t.calls, 'folder:create')).toEqual([{ name: 'Cycle 33', parentId: null }]);
    expect(payloadsFor(t.calls, 'agent:create')).toHaveLength(2);
  });

  it('a failed ticket is marked and the run carries on', async () => {
    const t0 = runStubs();
    t0['linear:triage'] = { reply: { ok: false, error: { code: 'TRIAGE_FAILED', message: "couldn't read the ticket" } } };
    const { t, el } = await openCycle(t0);
    click(button(el, 'Create 2 agents'));
    await settle();

    expect(el.textContent).toContain("failed: couldn't read the ticket");
    expect(payloadsFor(t.calls, 'linear:triage')).toHaveLength(2);
    expect(el.textContent).toContain('Created 0 of 2 agents in "Cycle 33"');
  });

  it('skips a ticket whose agent appeared while the run was going', async () => {
    const { t, el } = await openCycle(runStubs());
    click(button(el, 'Create 2 agents'));
    // Another window created the agent for the second ticket while the first was being looked up.
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { agents: [...AGENTS, agent('a9', 'AC-1369 second')] })));
    await settle();

    expect(el.textContent).toContain('skipped: agent exists');
    // One look-up, one create: the skipped ticket cost nothing at all.
    expect(payloadsFor(t.calls, 'linear:triage')).toHaveLength(1);
    expect(payloadsFor(t.calls, 'agent:create')).toHaveLength(1);
  });

  it('re-checks for an agent between the look-up and the create, not only before it', async () => {
    const stubs = runStubs();
    const held = deferred();
    stubs['linear:triage'] = { reply: { ok: true, value: draftFor('AC-1368') }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    click(boxFor(el, 'AC-1369'));
    click(button(el, 'Create 1 agent'));
    await settle();
    // The look-up is minutes long, and the agent appeared DURING it — the pre-look-up check is long
    // past, so only a re-check immediately before the create can catch this one.
    act(() => t.workspace.useWorkspace.getState().setSnapshot(snapshotWith({}, { agents: [...AGENTS, agent('a9', 'AC-1368 first')] })));
    held.resolve();
    await settle();

    expect(el.textContent).toContain('skipped: agent exists');
    expect(payloadsFor(t.calls, 'agent:create')).toEqual([]);
  });

  it('Cancel stops after the ticket in flight, and cancels its look-up', async () => {
    const { t, el } = await openCycle(runStubs());
    click(button(el, 'Select all'));
    const held = deferred();
    t.setStub('linear:triage', { reply: { ok: false, error: { code: 'CANCELLED', message: 'The look-up was cancelled.' } }, gate: held.promise });
    click(button(el, 'Create 3 agents'));
    await settle();
    // A run locks the step it is running: re-listing mid-run would leave the rows keyed to a cycle
    // the run is not about.
    expect(picker(el, 'Cycle').disabled).toBe(true);
    expect(boxes(el).every((b) => b.disabled)).toBe(true);

    click(button(el, 'Cancel run'));
    // The id of the look-up THAT IS RUNNING, not merely one of ours: a cancel naming anything else
    // leaves a `claude -p` spending in the background.
    const sent = payloadsFor(t.calls, 'linear:triage')[0] as { requestId: string };
    expect(sent.requestId).toMatch(/^cycle-/);
    expect(payloadsFor(t.calls, 'linear:cancel')).toEqual([{ requestId: sent.requestId }]);
    held.resolve();
    await settle();

    expect(payloadsFor(t.calls, 'linear:triage')).toHaveLength(1);
    expect(el.textContent).toContain('Stopped. Created 0 of 3.');
    // The row says what happened to it rather than claiming to be looking something up for ever.
    expect(el.textContent).toContain('cancelled');
    expect(el.textContent).not.toContain('looking up…');
  });

  it('stops on low disk with the banner’s own words, and says how many it made', async () => {
    const stubs = runStubs();
    stubs['app:diskFree'] = { reply: { ok: true, value: { freeBytes: 4.2e9, path: '/h/worktrees' } } };
    const { t, el } = await openCycle(stubs);
    click(button(el, 'Create 2 agents'));
    await settle();

    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([]);
    expect(el.textContent).toContain('Stopped: low disk. Created 0 of 2.');
    expect(el.textContent).toContain('Low disk space: 4.2 GB free on the volume holding worktrees.');
  });

  it('summarises at the end and Retry failed re-runs only the failures', async () => {
    const stubs = runStubs();
    const { t, el } = await openCycle(stubs);
    t.setStub('linear:triage', { reply: { ok: false, error: { code: 'TRIAGE_FAILED', message: 'nope' } } });
    click(button(el, 'Create 2 agents'));
    await settle();
    expect(el.textContent).toContain('Created 0 of 2 agents in "Cycle 33"');

    t.setStub('linear:triage', { reply: { ok: true, value: draftFor('AC-1368') } });
    const before = payloadsFor(t.calls, 'linear:triage').length;
    click(button(el, 'Retry failed'));
    await settle();
    expect(payloadsFor(t.calls, 'linear:triage').length - before).toBe(2);
    expect(el.textContent).toContain('Created 2 of 2 agents in "Cycle 33"');
    expect(maybeButton(el, 'Retry failed')).toBeUndefined();
  });

  it('Done closes the dialog', async () => {
    const { t, el } = await openCycle(runStubs());
    click(button(el, 'Create 2 agents'));
    await settle();
    click(button(el, 'Done'));
    expect(t.ui.useUi.getState().dialog).toBeNull();
  });

  it('cancels the look-up in flight when the dialog closes mid-run', async () => {
    const { t, el } = await openCycle(runStubs());
    const held = deferred();
    t.setStub('linear:triage', { reply: { ok: true, value: draftFor('AC-1368') }, gate: held.promise });
    click(button(el, 'Create 2 agents'));
    await settle();
    act(() => t.ui.useUi.getState().closeDialog());
    await flush();
    expect(payloadsFor(t.calls, 'linear:cancel')).toHaveLength(1);
    held.resolve();
    await settle();
  });

  it('never retries a ticket whose agent was saved before the create failed', async () => {
    const stubs = runStubs();
    const held = deferred();
    stubs['agent:create'] = { reply: { ok: false, error: { code: 'HOST_DOWN', message: 'the session host is not connected' } }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    click(boxFor(el, 'AC-1369'));
    click(button(el, 'Create 1 agent'));
    await settle();
    // `agent:create` committed the agent and only THEN threw: the agent EXISTS. Running the ticket
    // again would make a second one, which is the one thing `Retry failed` must never do.
    t.emit('agent:progress', ev('saved', 'done', { message: 'agent created' }));
    held.resolve();
    await settle();

    expect(el.textContent).toContain('created, then failed: the session host is not connected — not retried');
    expect(el.textContent).toContain('1 was created but not finished');
    expect(maybeButton(el, 'Retry failed')).toBeUndefined();
    expect(payloadsFor(t.calls, 'agent:create')).toHaveLength(1);
  });

  it('Cancel during the disk check spends nothing at all', async () => {
    const stubs = runStubs();
    const held = deferred();
    stubs['app:diskFree'] = { reply: { ok: true, value: { freeBytes: 9e9, path: '/h/worktrees' } }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    click(button(el, 'Create 2 agents'));
    await settle();
    click(button(el, 'Cancel run'));
    held.resolve();
    await settle();

    // Nothing was in flight to cancel, and nothing may be started now: no `claude -p`, no agent.
    expect(payloadsFor(t.calls, 'linear:triage')).toEqual([]);
    expect(payloadsFor(t.calls, 'agent:create')).toEqual([]);
    expect(el.textContent).toContain('Stopped. Created 0 of 2.');
  });

  it('Cancel after the look-up throws the draft away rather than creating from it', async () => {
    const stubs = runStubs();
    const held = deferred();
    stubs['linear:triage'] = { reply: { ok: true, value: draftFor('AC-1368') }, gate: held.promise };
    const { t, el } = await openCycle(stubs);
    click(button(el, 'Create 2 agents'));
    await settle();
    click(button(el, 'Cancel run'));
    // The look-up answers anyway — `linear:cancel` is a race main can lose — and the draft is still
    // not turned into an agent the owner has just said they do not want.
    held.resolve();
    await settle();

    expect(payloadsFor(t.calls, 'agent:create')).toEqual([]);
    expect(el.textContent).toContain('cancelled');
    expect(el.textContent).toContain('Stopped. Created 0 of 2.');
  });

  it('Retry failed finishes the same run, keeping the rows it is not re-running in the count', async () => {
    const stubs = runStubs();
    const first = deferred();
    stubs['linear:triage'] = { reply: { ok: true, value: draftFor('AC-1368') }, gate: first.promise };
    const { t, el } = await openCycle(stubs);
    click(button(el, 'Select all'));
    click(button(el, 'Create 3 agents'));
    await settle();
    t.setStub('linear:triage', { reply: { ok: false, error: { code: 'TRIAGE_FAILED', message: 'nope' } } });
    first.resolve();
    await settle();
    expect(el.textContent).toContain('Created 1 of 3 agents in "Cycle 33"');

    t.setStub('linear:triage', { reply: { ok: true, value: draftFor('AC-1369') } });
    click(button(el, 'Retry failed'));
    await settle();
    // Not `Created 2 of 2`: the agent the first pass made is still one of the three this run is for.
    expect(el.textContent).toContain('Created 3 of 3 agents in "Cycle 33"');
    expect(maybeButton(el, 'Retry failed')).toBeUndefined();
  });

  it('Back from the summary returns to the picker, unlocked', async () => {
    const { el } = await openCycle(runStubs());
    click(button(el, 'Create 2 agents'));
    await settle();
    click(button(el, 'Back'));
    expect(picker(el, 'Cycle').disabled).toBe(false);
    expect(boxes(el).some((b) => b.disabled)).toBe(false);
    expect(el.textContent).toContain('2 tickets · about 1 minute · folder "Cycle 33" · agents are not started');
  });

  it('Back ends the run: the next cycle counts its own agents and nobody else’s', async () => {
    const { t, el } = await openCycle(runStubs());
    click(button(el, 'Create 2 agents'));
    await settle();
    expect(el.textContent).toContain('Created 2 of 2 agents in "Cycle 33"');

    click(button(el, 'Back'));
    t.setStub('linear:cycleIssues', { reply: { ok: true, value: { issues: [{ ...CYCLE_ISSUES[0]!, identifier: 'AC-1400', title: 'Fresh', cycleId: 'cy-32', cycleNumber: 32 }] } } });
    choose(picker(el, 'Cycle'), 'cy-32');
    await settle();
    click(button(el, 'Create 1 agent'));
    await settle();

    // Cycle 33's two agents are not part of this run and must not be counted into it.
    expect(el.textContent).toContain('Created 1 of 1 agents in "Cycle 32"');
    expect(el.textContent).not.toContain('of 3');
  });

  it('Back clears a stop, its banner line and the rows it left behind', async () => {
    const stubs = runStubs();
    stubs['app:diskFree'] = { reply: { ok: true, value: { freeBytes: 4.2e9, path: '/h/worktrees' } } };
    const { el } = await openCycle(stubs);
    click(button(el, 'Create 2 agents'));
    await settle();
    expect(el.textContent).toContain('Stopped: low disk. Created 0 of 2.');

    click(button(el, 'Back'));
    expect(el.textContent).not.toContain('Stopped: low disk');
    expect(el.textContent).not.toContain('Low disk space:');
    expect(el.textContent).toContain('2 tickets · about 1 minute · folder "Cycle 33" · agents are not started');
  });
});
