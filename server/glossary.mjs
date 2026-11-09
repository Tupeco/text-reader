// @ts-check
// Built-in board game glossaries: glossary/<source>-<target>.tsv, "term<TAB>translation" per line.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {[string, string][]} Entries */

/** Parses a glossary TSV; "#" lines and blank lines are ignored. */
export function parseTsv(/** @type {string} */ text) {
  /** @type {Entries} */
  const entries = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [from, to, ...rest] = line.split('\t').map((s) => s.trim());
    if (!from || !to || rest.length) throw new Error(`glossary line is not "term<TAB>translation": ${raw}`);
    if (seen.has(from)) throw new Error(`duplicate glossary term: ${from}`);
    seen.add(from);
    entries.push([from, to]);
  }
  return entries;
}

/** Loads every <source>-<target>.tsv in dir, keyed "source-target". */
export async function loadGlossaries(/** @type {string} */ dir) {
  /** @type {Map<string, Entries>} */
  const out = new Map();
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    const m = /^([a-z]{2,3})-([a-z]{2,3})\.tsv$/.exec(f);
    if (m) out.set(`${m[1]}-${m[2]}`, parseTsv(await readFile(join(dir, f), 'utf8')));
  }
  return out;
}
