// Turns PaddleOCR's text boxes into reading-order rows and paragraphs.
// Glare (or an inline icon) often splits one printed line into several boxes; grouping boxes
// into rows by their deskewed vertical position puts the pieces back together.
import type { OcrLine, Word } from './text';

type Point = [number, number];
/** Corners clockwise from top-left. */
export type Box = [Point, Point, Point, Point];
export type Fragment = { words: Word[]; box: Box };

/** recRaw output: per character position, candidates sorted by confidence. */
export type RawLine = { text: { t: string; mean: number }[][]; box: Box };

// esearch-ocr drops recognitions below this mean confidence too.
const MIN_LINE_CONF = 0.5;

/** Splits recognized characters into words with per-word confidence (weakest character). */
export function fragmentsFromRaw(raw: RawLine[]): Fragment[] {
  const out: Fragment[] = [];
  for (const line of raw) {
    const chars = line.text.map((c) => c[0]).filter((c) => c && c.t !== '');
    if (!chars.length) continue;
    const mean = chars.reduce((s, c) => s + c.mean, 0) / chars.length;
    if (mean < MIN_LINE_CONF) continue;
    // Each word's box is interpolated along the line box from its character offsets.
    const [tl, tr, br, bl] = line.box;
    const lerp = (p: Point, q: Point, f: number): Point => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
    const words: Word[] = [];
    let t = '';
    let c = 1;
    let start = 0;
    const flush = (end: number) => {
      if (t) {
        const f0 = start / chars.length, f1 = end / chars.length;
        words.push({ t, c, box: [lerp(tl, tr, f0), lerp(tl, tr, f1), lerp(bl, br, f1), lerp(bl, br, f0)] });
      }
      t = '';
      c = 1;
    };
    chars.forEach((ch, k) => {
      if (/^\s+$/.test(ch.t)) flush(k);
      else {
        if (!t) start = k;
        t += ch.t;
        c = Math.min(c, ch.mean);
      }
    });
    flush(chars.length);
    if (words.length) out.push({ words, box: line.box });
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

type Placed = { f: Fragment; x0: number; x1: number; y: number; h: number };
type Row = { items: Placed[]; y: number; h: number };

export function layoutRows(fragments: Fragment[]): OcrLine[] {
  if (!fragments.length) return [];
  // Page skew: median angle of the boxes' top edges, weighted towards long boxes.
  const angles: number[] = [];
  for (const { box } of fragments) {
    const [tl, tr] = box;
    const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const a = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
    for (let k = 0; k < Math.max(1, Math.round(w / 50)); k++) angles.push(a);
  }
  const skew = median(angles);
  const cos = Math.cos(-skew), sin = Math.sin(-skew);
  const rot = ([x, y]: Point): Point => [x * cos - y * sin, x * sin + y * cos];

  const placed: Placed[] = fragments.map((f) => {
    const [tl, tr, br, bl] = f.box.map(rot);
    return {
      f,
      x0: Math.min(tl[0], bl[0]),
      x1: Math.max(tr[0], br[0]),
      y: (tl[1] + tr[1] + br[1] + bl[1]) / 4,
      h: (bl[1] - tl[1] + (br[1] - tr[1])) / 2,
    };
  });
  placed.sort((a, b) => a.y - b.y);

  const rows: Row[] = [];
  for (const p of placed) {
    // Join a row when vertically aligned and not overlapping a box already in it.
    const row = rows.find(
      (r) => Math.abs(r.y - p.y) < 0.5 * Math.min(r.h, p.h) && r.items.every((q) => p.x1 <= q.x0 + 0.2 * p.h || p.x0 >= q.x1 - 0.2 * p.h),
    );
    if (row) {
      row.items.push(p);
      row.y = row.items.reduce((s, q) => s + q.y, 0) / row.items.length;
      row.h = Math.max(row.h, p.h);
    } else rows.push({ items: [p], y: p.y, h: p.h });
  }
  rows.sort((a, b) => a.y - b.y);

  const typical = median(rows.map((r) => r.h));
  return rows.map((row, i) => {
    row.items.sort((a, b) => a.x0 - b.x0);
    const words = row.items.flatMap((q) => q.f.words);
    const prev = rows[i - 1];
    // New paragraph after a vertical gap (art box, spacing) or a change of font size (title).
    const gap = prev ? row.y - prev.y - (row.h + prev.h) / 2 : Infinity;
    const sizeJump = prev ? Math.max(row.h, prev.h) / Math.max(1, Math.min(row.h, prev.h)) > 1.3 : false;
    const chars = words.reduce((s, w) => s + w.t.length, 0);
    return {
      text: words.map((w) => w.t).join(' '),
      conf: words.reduce((s, w) => s + w.c * w.t.length, 0) / Math.max(1, chars),
      startsParagraph: gap > 0.6 * typical || sizeJump,
      words,
    };
  });
}
