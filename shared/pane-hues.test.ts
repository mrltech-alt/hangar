import { describe, expect, it } from 'vitest';
import { MAX_PANES } from './layout.ts';
import { PANE_HUES, paneChipLabel, paneHue } from './pane-hues.ts';

describe('PANE_HUES', () => {
  it('has exactly one hue per pane', () => {
    expect(PANE_HUES).toHaveLength(MAX_PANES);
  });

  it('is the spec §3 palette, in pane order', () => {
    expect(PANE_HUES).toEqual(['#a78bfa', '#5eead4', '#fb7185', '#fcd34d']);
  });

  // The whole point of the colour is telling one pane from another, so a duplicate is not a cosmetic
  // slip — it silently claims two panes are the same one.
  it('never repeats a colour', () => {
    expect(new Set(PANE_HUES).size).toBe(PANE_HUES.length);
  });
});

describe('paneHue', () => {
  it('gives every pane its own hue by index', () => {
    expect(Array.from({ length: MAX_PANES }, (_, i) => paneHue(i))).toEqual([...PANE_HUES]);
  });

  it('returns null below the first pane and at MAX_PANES', () => {
    expect(paneHue(-1)).toBeNull();
    expect(paneHue(MAX_PANES)).toBeNull();
  });

  // The assertion a modulo cannot pass: `PANE_HUES[i % 4]` would answer pane 4 with pane 0's colour
  // and pane -1 with gold, so both rails would draw a link that does not exist.
  it('never wraps around', () => {
    expect(paneHue(MAX_PANES)).not.toBe(PANE_HUES[0]);
    expect(paneHue(-1)).not.toBe(PANE_HUES[MAX_PANES - 1]);
  });

  it('rejects an index that cannot address a pane', () => {
    expect(paneHue(1.5)).toBeNull();
    expect(paneHue(Number.NaN)).toBeNull();
  });
});

describe('paneChipLabel', () => {
  // One-based: the number on the chip is the ⌘1–⌘4 key, not the array index.
  it('numbers panes from one', () => {
    expect(paneChipLabel(0)).toBe('⧉1');
  });

  it('labels every pane up to MAX_PANES', () => {
    expect(Array.from({ length: MAX_PANES }, (_, i) => paneChipLabel(i))).toEqual(['⧉1', '⧉2', '⧉3', '⧉4']);
  });
});
