// Fuses OCR readings of several photos of the same card. Glare wipes out different words in each
// shot; words read in both shots anchor a perspective mapping between the photos, and the other
// shot's words are overlaid onto the first wherever it has nothing (or something less confident).
import { layoutRows, type Box } from './layout';
import { similarity, type OcrLine, type Word } from './text';

type Point = [number, number];

/** Longest-common-subsequence style alignment; returns index pairs (−1 = gap). */
export function align<T>(a: T[], b: T[], score: (x: T, y: T) => number): [number, number][] {
  const n = a.length, m = b.length;
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const scores = a.map((x) => b.map((y) => score(x, y)));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const v = scores[i][j];
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], v > 0 ? v + best[i + 1][j + 1] : -Infinity);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const v = scores[i][j];
      if (v > 0 && best[i][j] === v + best[i + 1][j + 1]) {
        pairs.push([i++, j++]);
        continue;
      }
      if (best[i][j] === best[i + 1][j]) pairs.push([i++, -1]);
      else pairs.push([-1, j++]);
    } else if (i < n) pairs.push([i++, -1]);
    else pairs.push([-1, j++]);
  }
  return pairs;
}

const wordsOf = (l: OcrLine): Word[] => l.words ?? l.text.split(/\s+/).filter(Boolean).map((t) => ({ t, c: l.conf }));
const sameWord = (a: string, b: string) => similarity(a, b) >= 0.6;
const meanConf = (ws: Word[]) => ws.reduce((s, w) => s + w.c, 0) / Math.max(1, ws.length);

/**
 * Text-only merge of two word sequences: matching words keep the more confident spelling; where
 * only one side has words they are kept; where both disagree, the more confident run wins.
 */
export function mergeWords<T extends Word>(a: T[], b: T[], pick = (x: T, y: T) => (y.c > x.c ? y : x)): T[] {
  const out: T[] = [];
  let gapA: T[] = [], gapB: T[] = [];
  const flush = () => {
    if (gapA.length && gapB.length) out.push(...(meanConf(gapB) > meanConf(gapA) ? gapB : gapA));
    else out.push(...gapA, ...gapB);
    gapA = [];
    gapB = [];
  };
  for (const [i, j] of align(a, b, (x, y) => (sameWord(x.t, y.t) ? similarity(x.t, y.t) : 0))) {
    if (i >= 0 && j >= 0) {
      flush();
      out.push(pick(a[i], b[j]));
    } else if (i >= 0) gapA.push(a[i]);
    else gapB.push(b[j]);
  }
  flush();
  return out;
}

function linesFromWords<T extends Word & { para: boolean }>(words: T[]): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const w of words) {
    if (w.para || !lines.length) lines.push({ text: '', conf: 0, startsParagraph: true, words: [] });
    lines[lines.length - 1].words!.push({ t: w.t, c: w.c, box: w.box });
  }
  for (const l of lines) {
    const chars = l.words!.reduce((s, w) => s + w.t.length, 0);
    l.text = l.words!.map((w) => w.t).join(' ');
    l.conf = l.words!.reduce((s, w) => s + w.c * w.t.length, 0) / Math.max(1, chars);
  }
  return lines;
}

function textMerge(a: OcrLine[], b: OcrLine[]): OcrLine[] {
  const tokens = (lines: OcrLine[]) =>
    lines.flatMap((l, i) => wordsOf(l).map((w, k) => ({ ...w, para: k === 0 && (i === 0 || l.startsParagraph) })));
  return linesFromWords(mergeWords(tokens(a), tokens(b), (x, y) => ({ ...(y.c > x.c ? y : x), para: x.para || y.para })));
}

// ---- geometry ----

/** Solves A x = b (n×n) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return undefined;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

type Homography = (p: Point) => Point;

/** Least-squares homography mapping `from` onto `to` (needs ≥ 4 points). */
export function fitHomography(from: Point[], to: Point[]): Homography | undefined {
  if (from.length < 4) return undefined;
  // Normalize both point sets for numerical stability.
  const norm = (pts: Point[]) => {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
    const k = Math.SQRT2 / d;
    return { f: (p: Point): Point => [(p[0] - cx) * k, (p[1] - cy) * k], inv: (p: Point): Point => [p[0] / k + cx, p[1] / k + cy] };
  };
  const nf = norm(from), nt = norm(to);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  for (let i = 0; i < from.length; i++) {
    const [x, y] = nf.f(from[i]);
    const [u, v] = nt.f(to[i]);
    for (const [row, rhs] of [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ] as [number[], number][]) {
      for (let r = 0; r < 8; r++) {
        Atb[r] += row[r] * rhs;
        for (let c = 0; c < 8; c++) AtA[r][c] += row[r] * row[c];
      }
    }
  }
  const h = solve(AtA, Atb);
  if (!h) return undefined;
  return (p) => {
    const [x, y] = nf.f(p);
    const w = h[6] * x + h[7] * y + 1;
    return nt.inv([(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]);
  };
}

const center = (b: Box): Point => [(b[0][0] + b[1][0] + b[2][0] + b[3][0]) / 4, (b[0][1] + b[1][1] + b[2][1] + b[3][1]) / 4];
const height = (b: Box) => (Math.hypot(b[3][0] - b[0][0], b[3][1] - b[0][1]) + Math.hypot(b[2][0] - b[1][0], b[2][1] - b[1][1])) / 2;

/** Axis-aligned overlap of two boxes relative to the smaller one. */
function overlap(a: Box, b: Box) {
  const ext = (q: Box) => ({
    x0: Math.min(...q.map((p) => p[0])),
    x1: Math.max(...q.map((p) => p[0])),
    y0: Math.min(...q.map((p) => p[1])),
    y1: Math.max(...q.map((p) => p[1])),
  });
  const p = ext(a), q = ext(b);
  const w = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
  const h = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((p.x1 - p.x0) * (p.y1 - p.y0), (q.x1 - q.x0) * (q.y1 - q.y0));
}

type Boxed = Word & { box: Box };

/** Maps shot B's words onto shot A via anchor words; undefined if they can't be registered. */
function register(a: Boxed[], b: Boxed[]): Homography | undefined {
  // Anchors: confidently read words of 3+ letters that both shots agree on, in order.
  const good = (w: Word) => w.c > 0.8 && w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 3;
  let pairs = align(a, b, (x, y) => (good(x) && good(y) && similarity(x.t, y.t) >= 0.9 ? 1 : 0))
    .filter(([i, j]) => i >= 0 && j >= 0)
    .map(([i, j]) => ({ from: center(b[j].box), to: center(a[i].box), h: height(a[i].box) }));
  // Fit, drop anchors that disagree with the fit (repeated words matched wrongly), refit.
  for (let round = 0; round < 3; round++) {
    const H = fitHomography(pairs.map((p) => p.from), pairs.map((p) => p.to));
    if (!H) return undefined;
    const kept = pairs.filter((p) => {
      const [x, y] = H(p.from);
      return Math.hypot(x - p.to[0], y - p.to[1]) < 0.6 * p.h;
    });
    if (kept.length === pairs.length) return kept.length >= 6 ? H : undefined;
    pairs = kept;
  }
  return undefined;
}

function geometricMerge(a: OcrLine[], b: OcrLine[]): OcrLine[] | undefined {
  const wa = a.flatMap(wordsOf), wb = b.flatMap(wordsOf);
  if (!wa.every((w) => w.box) || !wb.every((w) => w.box)) return undefined;
  const H = register(wa as Boxed[], wb as Boxed[]);
  if (!H) return undefined;

  const words: Boxed[] = [...(wa as Boxed[])];
  for (const w of wb as Boxed[]) {
    const box = w.box.map(H) as Box;
    const [cx, cy] = center(box);
    // Same spot, or the same word nearby (short words barely overlap after a slightly-off mapping).
    const hits = words.filter((x) => {
      if (overlap(x.box, box) > 0.3) return true;
      const [xx, xy] = center(x.box);
      return similarity(x.t, w.t) >= 0.8 && Math.hypot(xx - cx, xy - cy) < height(x.box);
    });
    if (!hits.length) words.push({ ...w, box });
    else if (hits.every((x) => w.c > x.c + 0.05)) {
      // B read this spot better (A's reading is glare-damaged): replace A's word(s).
      for (const x of hits) words.splice(words.indexOf(x), 1);
      words.push({ ...w, box });
    }
  }
  return layoutRows(words.map((w) => ({ words: [w], box: w.box })));
}

/**
 * Fuses OCR output from several photos of the same card. Words blown out by glare in one shot
 * (missing or low confidence) are taken from a shot where they read well.
 */
export function mergeShots(shots: OcrLine[][]): OcrLine[] {
  const nonEmpty = shots.filter((s) => s.length);
  if (!nonEmpty.length) return [];
  // Start from the shot with the most confident text so its geometry anchors the result.
  const weight = (s: OcrLine[]) => s.reduce((t, l) => t + l.text.length * l.conf, 0);
  const [first, ...rest] = [...nonEmpty].sort((x, y) => weight(y) - weight(x));
  return rest.reduce((acc, shot) => geometricMerge(acc, shot) ?? textMerge(acc, shot), first);
}
