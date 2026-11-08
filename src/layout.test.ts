import { describe, expect, it } from 'vitest';
import { fragmentsFromRaw, layoutRows, type Box, type Fragment } from './layout';

/** Axis-aligned box rotated by `deg` around the origin. */
function box(x: number, y: number, w: number, h: number, deg = 0): Box {
  const a = (deg * Math.PI) / 180;
  const r = ([px, py]: [number, number]): [number, number] => [px * Math.cos(a) - py * Math.sin(a), px * Math.sin(a) + py * Math.cos(a)];
  return [r([x, y]), r([x + w, y]), r([x + w, y + h]), r([x, y + h])];
}

const frag = (text: string, b: Box): Fragment => ({ words: text.split(' ').map((t) => ({ t, c: 0.9 })), box: b });

describe('layoutRows', () => {
  it('rejoins a line split by glare, in reading order, even when tilted', () => {
    for (const deg of [0, 4, -4]) {
      const rows = layoutRows([
        frag('Storm Front', box(250, 40, 400, 60, deg)),
        frag('All heroes must', box(60, 600, 300, 40, deg)),
        frag('travel this round.', box(560, 600, 280, 40, deg)),
        frag('Exposed settlements lose', box(60, 650, 500, 40, deg)),
      ]);
      expect(rows.map((r) => r.text)).toEqual(['Storm Front', 'All heroes must travel this round.', 'Exposed settlements lose']);
      expect(rows.map((r) => r.startsParagraph)).toEqual([true, true, false]);
    }
  });

  it('keeps adjacent lines apart', () => {
    const rows = layoutRows([frag('line one', box(0, 0, 300, 40)), frag('line two', box(0, 46, 300, 40))]);
    expect(rows.map((r) => r.text)).toEqual(['line one', 'line two']);
  });
});

describe('fragmentsFromRaw', () => {
  it('splits words and uses the weakest character as word confidence', () => {
    const chars = (s: string, low = -1) => [...s].map((t, i) => [{ t, mean: i === low ? 0.4 : 0.95 }]);
    const [f] = fragmentsFromRaw([{ text: chars('gain 1 wood', 8), box: box(0, 0, 110, 10) }]);
    expect(f.words.map(({ t, c }) => ({ t, c }))).toEqual([
      { t: 'gain', c: 0.95 },
      { t: '1', c: 0.95 },
      { t: 'wood', c: 0.4 },
    ]);
    // "gain 1 wood" across a 110px box: "wood" covers characters 7..11.
    expect(f.words[2].box![0][0]).toBeCloseTo(70);
    expect(f.words[2].box![1][0]).toBeCloseTo(110);
  });

  it('drops low-confidence noise', () => {
    expect(fragmentsFromRaw([{ text: [[{ t: '@', mean: 0.2 }]], box: box(0, 0, 1, 1) }])).toEqual([]);
  });
});
