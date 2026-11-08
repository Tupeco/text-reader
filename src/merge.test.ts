import { describe, expect, it } from 'vitest';
import type { Box } from './layout';
import { fitHomography, mergeShots } from './merge';
import type { OcrLine, Word } from './text';

const line = (text: string, conf = 0.9, startsParagraph = false): OcrLine => ({ text, conf, startsParagraph });

describe('mergeShots', () => {
  it('fills a line lost to glare from another shot', () => {
    const a = [line('Storm Front', 0.95, true), line('All heroes must spend', 0.9, true), line('Exposed settlements lose', 0.9)];
    const b = [line('Storm Front', 0.9, true), line('Al hcroes must spend', 0.5, true), line('1 extra action to travel', 0.85), line('Exposed setlements lose', 0.7)];
    expect(mergeShots([a, b]).map((l) => l.text)).toEqual(['Storm Front', 'All heroes must spend 1 extra action to travel Exposed settlements lose']);
  });

  it('prefers the more confident reading of the same line', () => {
    const merged = mergeShots([[line('Gain 2 wod', 0.6)], [line('Gain 2 wood', 0.92)]]);
    expect(merged.map((l) => l.text)).toEqual(['Gain 2 wood']);
  });

  it('fills words erased by glare from the other shot', () => {
    const w = (s: string, c = 0.95) => s.split(' ').map((t) => ({ t, c }));
    const a: OcrLine = { text: '', conf: 0.9, startsParagraph: true, words: [...w('Place a settler here. At the'), ...w('day, if no hero')] };
    const b: OcrLine = { text: '', conf: 0.9, startsParagraph: true, words: [...w('Place a'), ...w('here. At the start of each day, if no hero')] };
    expect(mergeShots([[a], [b]]).map((l) => l.text)).toEqual(['Place a settler here. At the start of each day, if no hero']);
  });

  it('prefers the confident run where shots disagree', () => {
    const a: OcrLine = { text: '', conf: 0.8, startsParagraph: false, words: [{ t: 'At', c: 0.99 }, { t: 'theote', c: 0.42 }, { t: 'day', c: 0.99 }] };
    const b: OcrLine = {
      text: '', conf: 0.9, startsParagraph: false,
      words: [{ t: 'At', c: 0.99 }, { t: 'the', c: 0.97 }, { t: 'start', c: 0.96 }, { t: 'day', c: 0.98 }],
    };
    expect(mergeShots([[a], [b]])[0].text).toBe('At the start day');
  });

  it('handles empty shots', () => {
    expect(mergeShots([[], [line('x')]])).toEqual([line('x')]);
    expect(mergeShots([])).toEqual([]);
  });
});

describe('fitHomography', () => {
  it('recovers a perspective mapping', () => {
    const truth = ([x, y]: [number, number]): [number, number] => {
      const w = 1 + 0.0002 * x - 0.0001 * y;
      return [(1.1 * x - 0.2 * y + 40) / w, (0.15 * x + 0.95 * y - 25) / w];
    };
    const from: [number, number][] = [[0, 0], [500, 20], [480, 700], [10, 650], [250, 300], [120, 500]];
    const H = fitHomography(from, from.map(truth))!;
    for (const p of [[300, 100], [50, 600]] as [number, number][]) {
      expect(H(p)[0]).toBeCloseTo(truth(p)[0], 3);
      expect(H(p)[1]).toBeCloseTo(truth(p)[1], 3);
    }
  });
});

describe('geometric merge', () => {
  // A card laid out as rows of words, photographed twice from different angles.
  const CARD = [
    'Ancient Grove',
    '',
    'Place a settler here. At the start',
    'of each day, if no hero is adjacent,',
    'the forest grows: add 1 tree token',
    'to each empty space.',
  ];
  function shot(view: (p: [number, number]) => [number, number], erased: (row: number, col: number) => boolean): OcrLine[] {
    const lines: OcrLine[] = [];
    CARD.forEach((text, row) => {
      let x = 40;
      const words: Word[] = [];
      text.split(' ').filter(Boolean).forEach((t, col) => {
        const w = t.length * 18;
        const y = 60 + row * 50;
        if (!erased(row, col)) {
          const box = [view([x, y]), view([x + w, y]), view([x + w, y + 36]), view([x, y + 36])] as Box;
          words.push({ t, c: 0.95, box });
        }
        x += w + 14;
      });
      if (words.length) lines.push({ text: words.map((w) => w.t).join(' '), conf: 0.95, startsParagraph: row === 0 || row === 2, words });
    });
    return lines;
  }
  const straight = (p: [number, number]): [number, number] => p;
  const tilted = ([x, y]: [number, number]): [number, number] => {
    const a = (6 * Math.PI) / 180;
    return [1.2 * (x * Math.cos(a) - y * Math.sin(a)) + 90, 1.2 * (x * Math.sin(a) + y * Math.cos(a)) + 30];
  };

  it('fills glare holes from a tilted second shot in the right place', () => {
    // Shot A: glare over the middle of rows 2–4. Shot B: glare over the start of rows 4–5.
    const a = shot(straight, (row, col) => row >= 2 && row <= 4 && col >= 3 && col <= 5);
    const b = shot(tilted, (row, col) => row >= 4 && col <= 2);
    const merged = mergeShots([a, b]);
    expect(merged.map((l) => l.startsParagraph)).toEqual([true, true, false, false, false]);
    expect(merged.map((l) => l.text)).toEqual(CARD.filter(Boolean));
  });

  it('does not duplicate short words when the mapping is slightly off', () => {
    // Shot B's boxes are jittered by up to ±14px, as a real registration error would be.
    let seed = 3;
    const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 28;
    const noisy = (p: [number, number]): [number, number] => {
      const [x, y] = tilted(p);
      return [x + jitter(), y + jitter()];
    };
    const a = shot(straight, (row, col) => row === 3 && col >= 4);
    const b = shot(noisy, () => false);
    expect(mergeShots([a, b]).map((l) => l.text)).toEqual(CARD.filter(Boolean));
  });

  it('replaces a glare-damaged word with the confident reading at the same spot', () => {
    const a = shot(straight, () => false);
    a[1].words![6] = { ...a[1].words![6], t: 'stxrt', c: 0.45 };
    const b = shot(tilted, (row) => row === 5);
    expect(mergeShots([a, b])[1].text).toBe('Place a settler here. At the start');
  });
});
