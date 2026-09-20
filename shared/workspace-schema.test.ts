/**
 * The persisted/strict layout schema pair, at the one thing the file's own compile-time guards
 * cannot see.
 *
 * `workspace-schema.ts` carries two `DeepRequired` assignment pairs that keep it a faithful mirror
 * of `shared/types.ts`. Plan 04 Task 3 measured what they are blind to: they compare KEYS and
 * OPTIONALITY, so `z.number()` and `z.number().min(240)` are the same type to them, and a `.catch()`
 * or `.default()` is invisible. Every claim below is therefore a runtime `safeParse` — the only
 * instrument that can see a bound or a refinement.
 *
 * The claim that matters most is the MIGRATION. Every `workspace.json` written before
 * `Layout.shortcutsPanel` existed — the owner's live `~/.hangar` included — has no such key, and
 * `workspace-store.load()` moves a file that fails this schema to `.corrupt-<timestamp>` and starts
 * empty. A required key here would have cost every project and every agent on the first launch
 * after this change.
 */
import { describe, expect, it } from 'vitest';
import { PANEL_MIN_H, PANEL_MIN_W } from './layout.ts';
import { defaultLayout } from './types.ts';
import { LayoutInputSchema, LayoutSchema } from './workspace-schema.ts';

/** A layout as written to disk BEFORE `shortcutsPanel` existed. */
const legacy = (): Record<string, unknown> => {
  const { shortcutsPanel: _dropped, ...rest } = defaultLayout();
  return rest;
};

describe('LayoutSchema (persisted, lenient)', () => {
  it('loads a workspace.json written before the panel existed', () => {
    const parsed = LayoutSchema.safeParse(legacy());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shortcutsPanel).toBeNull();
    // The control: the key really was absent, so `.default(null)` is what supplied it and this test
    // is not agreeing with a value it put there itself.
    expect('shortcutsPanel' in legacy()).toBe(false);
  });

  it('recovers from a malformed rect instead of classing the whole file corrupt', () => {
    for (const junk of [{ x: 'left' }, 42, [], { x: 1, y: 2 }]) {
      const parsed = LayoutSchema.safeParse({ ...legacy(), shortcutsPanel: junk });
      expect([junk, parsed.success]).toEqual([junk, true]);
      expect(parsed.success && parsed.data.shortcutsPanel).toBeNull();
    }
  });

  /**
   * Deliberately lenient about BOUNDS: an off-screen or two-pixel-tall rect is `normalizeLayout`'s
   * to repair (`shared/layout.test.ts` → "normalizeLayout fixes the shape…"), and refusing it here
   * would move the file aside over a panel position. This is the same ruling the three `.catch()`
   * enums in this schema already record.
   */
  it('accepts an out-of-bounds rect and leaves the repair to normalizeLayout', () => {
    const parsed = LayoutSchema.safeParse({ ...legacy(), shortcutsPanel: { x: 99_999, y: -8, w: 1, h: 0 } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shortcutsPanel).toEqual({ x: 99_999, y: -8, w: 1, h: 0 });
  });
});

describe('LayoutInputSchema (from the renderer, strict)', () => {
  it('requires the field — the migration default does not carry over to the wire', () => {
    expect(LayoutInputSchema.safeParse(legacy()).success).toBe(false);
    expect(LayoutInputSchema.safeParse(defaultLayout()).success).toBe(true);
  });

  it('rejects a rect the renderer should have clamped', () => {
    const cases = [
      { x: 0, y: 0, w: PANEL_MIN_W - 1, h: 400 },
      { x: 0, y: 0, w: 400, h: PANEL_MIN_H - 1 },
      { x: -1, y: 0, w: 400, h: 400 },
      { x: 0, y: 20_000, w: 400, h: 400 },
    ];
    for (const shortcutsPanel of cases) {
      expect([shortcutsPanel, LayoutInputSchema.safeParse({ ...defaultLayout(), shortcutsPanel }).success]).toEqual([shortcutsPanel, false]);
    }
    // The control, so the four above are failing on their bounds and not on some unrelated field.
    expect(LayoutInputSchema.safeParse({ ...defaultLayout(), shortcutsPanel: { x: 0, y: 0, w: PANEL_MIN_W, h: PANEL_MIN_H } }).success).toBe(true);
  });

  it('accepts null, because "never moved" is a legal thing for the renderer to send', () => {
    expect(LayoutInputSchema.safeParse({ ...defaultLayout(), shortcutsPanel: null }).success).toBe(true);
  });

  /**
   * A `.catch()` on the strict side would be a validation bypass rather than a recovery mechanism —
   * the schema file says so in prose about its three enums, and this asserts it of the rect: junk
   * from the renderer is a rejected request, never a silently-rewritten one.
   */
  it('does not inherit the persisted schema\'s recovery', () => {
    expect(LayoutInputSchema.safeParse({ ...defaultLayout(), shortcutsPanel: { x: 'left' } }).success).toBe(false);
  });
});
