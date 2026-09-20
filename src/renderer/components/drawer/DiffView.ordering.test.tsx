/**
 * Two orderings inside `DiffView` that only a CONTROLLED editor factory can reach.
 *
 * `createUnifiedDiff` awaits a lazy grammar chunk, so its view arrives after the effect that asked
 * for it has returned — and possibly after that effect has been cleaned up. Both hazards below live
 * in that window:
 *
 *   1. A view that finishes building after its file was closed must be DESTROYED, not assigned to a
 *      dead closure. Otherwise one editor leaks into the host div per file clicked faster than its
 *      grammar loads, and they stack up on screen.
 *   2. The state a view is built from must belong to the file whose name it is built under. An
 *      effect that blanks the previous file's diff runs AFTER the render that already carries the
 *      new `relPath`, so `DiffView` derives instead — measured here as the difference between two
 *      builds and three.
 *
 * Neither is reachable through the real factory in jsdom. Measured on this tree: `await act(...)`
 * drains a COLD dynamic `import()` (`x.rs`, never loaded in that worker) to completion, so the view
 * is always assigned before any cleanup can run and a plain `view?.destroy()` covers every ordering
 * jsdom can produce. Over a real lazy chunk it is not drained, which is the case the guard exists
 * for — so the stub is what makes the guard testable at all, not a convenience.
 *
 * A file of its own, and a hoisted `vi.mock`, because `vi.doMock` inside one test of
 * `DiffTab.test.tsx` did not take effect there (measured: the stub was applied when that test ran
 * alone and not when the file ran whole, then leaked into the test after it).
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangarBridge, IpcEventKey, IpcEvents, IpcReply, IpcRequestKey, IpcRequests } from '../../../../shared/ipc-contract.ts';

/** Every view the stubbed factory was asked for: its filename, a hand to finish it with, and
 *  whether anyone destroyed it. */
const built = vi.hoisted(() => [] as { filename: string; finish: () => void; destroyed: boolean }[]);

vi.mock('../../lib/codemirror.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/codemirror.ts')>()),
  createUnifiedDiff: (_parent: HTMLElement, _old: string, _next: string, filename: string) =>
    new Promise((resolve) => {
      const entry: { filename: string; finish: () => void; destroyed: boolean } = { filename, finish: () => undefined, destroyed: false };
      entry.finish = (): void => resolve({ destroy: () => { entry.destroyed = true; } });
      built.push(entry);
    }),
}));

const DIFFS: Record<string, IpcRequests['git:fileDiff']['res']> = {
  'src/edited.ts': { oldText: 'const a = 1;\n', newText: 'const a = 2;\n', oldMissing: false, newMissing: false, binary: false, tooLarge: false },
  'README.md': { oldText: '# old\n', newText: '# new\n', oldMissing: false, newMissing: false, binary: false, tooLarge: false },
};

const bridge: HangarBridge = {
  invoke<K extends IpcRequestKey>(channel: K, ...args: IpcRequests[K]['req'] extends void ? [] : [payload: IpcRequests[K]['req']]): Promise<IpcReply<IpcRequests[K]['res']>> {
    const relPath = (args[0] as { relPath?: string } | undefined)?.relPath ?? '';
    if (channel === 'git:fileDiff' && relPath in DIFFS) {
      return Promise.resolve({ ok: true, value: DIFFS[relPath] } as IpcReply<IpcRequests[K]['res']>);
    }
    return Promise.resolve({ ok: false, error: { code: 'TEST', message: `no stub for ${channel}` } });
  },
  on<K extends IpcEventKey>(channel: K, handler: (payload: IpcEvents[K]) => void): () => void {
    void channel;
    void handler;
    return () => undefined;
  },
};

let container: HTMLDivElement;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as Window & { hangar: HangarBridge }).hangar = bridge;
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
  built.length = 0;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  container.remove();
});

function mount(node: ReactNode): { render: (next: ReactNode) => void } {
  const el = document.createElement('div');
  container.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(node));
  return { render: (next) => act(() => root.render(next)) };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('DiffView, editors that finish after the fact', () => {
  it('destroys a view that arrives after its file was closed, and keeps the one that is current', async () => {
    const { DiffView } = await import('./DiffView.tsx');
    const m = mount(<DiffView agentId="a1" workspaceId="w1" relPath="src/edited.ts" status="M" refreshKey={0} />);
    await settle();
    expect(built.map((b) => b.filename)).toEqual(['src/edited.ts']);

    // The file is closed while its editor is still being built.
    m.render(<DiffView agentId="a1" workspaceId="w1" relPath="README.md" status="M" refreshKey={0} />);
    await settle();
    // TWO builds, not three: the render that already carries `README.md` must not build an editor
    // out of `src/edited.ts`'s text under that name. An effect-cleared state does exactly that for
    // one commit — measured, before `DiffView` moved to a keyed state read at render time.
    expect(built.map((b) => b.filename)).toEqual(['src/edited.ts', 'README.md']);

    await act(async () => {
      built[0].finish();
      built[1].finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(built[0].destroyed).toBe(true);
    expect(built[1].destroyed).toBe(false);
  });

  it('destroys a view that arrives after the whole tab unmounted', async () => {
    const { DiffView } = await import('./DiffView.tsx');
    mount(<DiffView agentId="a1" workspaceId="w1" relPath="src/edited.ts" status="M" refreshKey={0} />);
    await settle();
    expect(built).toHaveLength(1);
    for (const root of roots) act(() => root.unmount());
    roots = [];
    await act(async () => {
      built[0].finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(built[0].destroyed).toBe(true);
  });
});
