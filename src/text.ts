// Pure text helpers: OCR cleanup, glossary replacements and sentence splitting.

import type { Box } from './layout';

/** A recognized word, its confidence (0..1, the weakest character) and where it is in the photo. */
export type Word = { t: string; c: number; box?: Box };

export type OcrLine = {
  text: string;
  /** Mean recognition confidence, 0..1. */
  conf: number;
  /** True when this line starts a new paragraph (title, new rules block, ...). */
  startsParagraph: boolean;
  words?: Word[];
};

// Characters OCR typically produces for inline icons, borders and dirt.
const JUNK_ONLY = /^[^\p{L}\p{N}]+$/u;
const KEEP_PUNCT = /^(?:[-–—:;,.!?…"“”'‘’()&+/%]|\.\.\.)$/u;

function isJunkToken(token: string) {
  return JUNK_ONLY.test(token) && !KEEP_PUNCT.test(token);
}

// Round resource icons after an amount ("gain 1 [icon] renown") come out as a lone O/0/C/Q.
const ICON_AFTER_NUMBER = /(?<=(?:^|\s)[+-]?\d+)\s+[OoQC0◯○●](?=\s+\p{L})/gu;
// "1renown" -> "1 renown" (but leave ordinals like 1st, 2nd, 3rd, 4th alone).
const GLUED_NUMBER = /(?<=(?:^|\s)[+-]?\d+)(?!st\b|nd\b|rd\b|th\b|x\b)(?=\p{Ll}{2,})/gu;

/** Joins wrapped lines into paragraphs and drops icon/border debris. */
export function cleanOcrText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) =>
      para
        // "inter-\nesting" -> "interesting" when the next line continues in lowercase.
        .replace(/(\p{L})[-‐‑]\n(\p{Ll})/gu, '$1$2')
        .replace(/\n/g, ' ')
        .replace(ICON_AFTER_NUMBER, '')
        .replace(GLUED_NUMBER, ' ')
        .split(/\s+/)
        .filter((t) => t && !isJunkToken(t))
        .join(' ')
        .replace(/\s+([,.;:!?…])/g, '$1')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
}

export function linesToText(lines: OcrLine[]): string {
  let out = '';
  for (const line of lines) {
    if (!line.text.trim()) continue;
    if (out) out += line.startsParagraph ? '\n\n' : '\n';
    out += line.text.trim();
  }
  return out;
}

export type GlossaryRule = { from: string; to: string };

/** Parses "from = to" lines; blank lines and lines starting with # are ignored. */
export function parseGlossary(src: string): GlossaryRule[] {
  const rules: GlossaryRule[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const from = line.slice(0, i).trim();
    if (from) rules.push({ from, to: line.slice(i + 1).trim() });
  }
  return rules;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word replacement; longer phrases win over their substrings. */
export function applyGlossary(text: string, rules: GlossaryRule[]): string {
  if (!rules.length) return text;
  const sorted = [...rules].sort((a, b) => b.from.length - a.from.length);
  const byKey = new Map(sorted.map((r) => [r.from.toLowerCase(), r.to]));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${sorted.map((r) => escapeRegExp(r.from)).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return text.replace(pattern, (m) => byKey.get(m.toLowerCase()) ?? m);
}

/** Splits into sentences, keeping paragraph boundaries as separate entries. */
export function splitSentences(text: string): string[][] {
  return text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/\s+/g, ' ')
        .trim()
        .split(/(?<=[.!?…])\s+(?=["“(]?[\p{Lu}\p{N}])/u)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((p) => p.length);
}

function levenshtein(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string) {
  const x = a.toLowerCase().replace(/\s+/g, ' ').trim();
  const y = b.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!x && !y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}
