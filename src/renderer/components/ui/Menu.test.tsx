/**
 * `ContextMenuHost`'s submenus. The menus' CONTENTS are tested where they are built
 * (`lib/agent-actions.test.ts`); this is about what hovering an entry does.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUi } from '../../stores/ui.ts';
import { ContextMenuHost } from './Menu.tsx';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useUi.getState().hideContextMenu());
});

/** React's `onMouseEnter` is synthesised from a bubbling `mouseover` (with no `relatedTarget`: entered from outside). */
function hover(label: string): void {
  const row = [...container.querySelectorAll('button')].find((b) => b.textContent === label)?.closest('li');
  if (!row) throw new Error(`no menu row "${label}"`);
  act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
}

describe('ContextMenuHost submenus', () => {
  /**
   * "Remove project from this agent" on a one-project agent is disabled with `children: []`. Hovering
   * it used to open a submenu anyway — an empty bordered box beside a greyed-out entry.
   */
  it('opens no submenu for a disabled entry, and still opens one for an enabled entry', () => {
    act(() => useUi.getState().showContextMenu(10, 10, [
      { label: 'Remove project from this agent', disabled: true, children: [] },
      { label: 'Move to', children: [{ label: 'Root' }] },
    ]));
    act(() => root.render(<ContextMenuHost />));
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    hover('Remove project from this agent');
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    // The control: the same gesture on an enabled entry does open its submenu, so the hover is real.
    hover('Move to');
    expect(container.querySelectorAll('ul')).toHaveLength(2);
    expect(container.textContent).toContain('Root');
  });
});
