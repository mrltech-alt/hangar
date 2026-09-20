/**
 * G65, measured on every run rather than asserted from memory.
 *
 * Five of this project's commit-counting tests were spelled `mount(<StrictMode><Thing/></StrictMode>)`
 * against a `mount` helper that wraps its argument in a `<Profiler>`. That puts the `<Profiler>`
 * outermost, and React only double-invokes EFFECTS when `<StrictMode>` is the outermost element
 * handed to `root.render()` — so half of StrictMode was silently off. Render and state updaters
 * stay doubled either way, which is why the G59/G61 allocating-selector detection those tests exist
 * for kept working and nothing looked wrong; what was missing was the double-mount half that
 * catches double-subscribe, double-fetch and double-attach (G26 records that this app cannot run
 * under StrictMode for exactly that reason, so the hazard is known to be real here).
 *
 * This file is the live measurement behind the `mountStrict` helpers in `Sidebar.test.tsx`,
 * `status.test.tsx`, `Drawer.test.tsx`, `PaneGrid.test.tsx`, `dialogs.test.tsx` and
 * `FilesTab.test.tsx`. It doubles as their G64 health check: the second test is a control holding
 * the old spelling, so "effects 2" in the first is evidence the probe can tell the shapes apart
 * rather than a counter that would report 2 for anything.
 */
import { act, Profiler, StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

interface Counts { effects: number; updaters: number; commits: number }

/**
 * Renders a probe that counts its own mount effect and its own state updater, in whatever tree
 * `build` assembles from it and the commit-counting `<Profiler>`, then clicks it once.
 */
function measure(build: (probe: ReactNode, countCommits: (n: ReactNode) => ReactNode) => ReactNode): Counts {
  const counts: Counts = { effects: 0, updaters: 0, commits: 0 };
  const Probe = (): ReactNode => {
    const [n, setN] = useState(0);
    useEffect(() => {
      counts.effects += 1;
    }, []);
    return <button type="button" onClick={() => setN((v) => { counts.updaters += 1; return v + 1; })}>{n}</button>;
  };
  const countCommits = (n: ReactNode): ReactNode => (
    <Profiler id="probe" onRender={() => { counts.commits += 1; }}>{n}</Profiler>
  );
  const el = document.createElement('div');
  container.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(build(<Probe />, countCommits)));
  const button = el.querySelector('button');
  if (button === null) throw new Error('probe did not render');
  act(() => button.click());
  return counts;
}

describe('StrictMode nesting (G65)', () => {
  // The corrected shape: `root.render(<StrictMode><Profiler><Probe/></Profiler></StrictMode>)`,
  // which is what every `mountStrict` in this project builds.
  it('double-invokes the mount EFFECT when StrictMode is the outermost element rendered', () => {
    const counts = measure((probe, countCommits) => <StrictMode>{countCommits(probe)}</StrictMode>);
    expect(counts.effects).toBe(2);
    expect(counts.updaters).toBe(2);
  });

  /**
   * The control, and the exact spelling the five files used before this correction:
   * `root.render(<Profiler><StrictMode><Probe/></StrictMode></Profiler>)`. Measured here on
   * React 19.2.8 — effects 1, updaters 2. Without this the "2" above could just mean the counter
   * increments twice for anything.
   */
  it('does NOT double-invoke it when a Profiler sits above StrictMode', () => {
    const wrapped = measure((probe, countCommits) => countCommits(<StrictMode>{probe}</StrictMode>));
    expect(wrapped.effects).toBe(1);
    // Updaters stay doubled through the nesting: this is the half that never broke, and the reason
    // the G59/G61 loop tests in those five files were still doing their stated job.
    expect(wrapped.updaters).toBe(2);
    // And the baseline, so "1" above is not just what this probe always reports.
    const plain = measure((probe, countCommits) => countCommits(probe));
    expect(plain.effects).toBe(1);
    expect(plain.updaters).toBe(1);
  });
});
