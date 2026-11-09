// @ts-check
// DeepL engine: POST /v2/translate with a v3 glossary built from glossary/<src>-<tgt>.tsv.
// Docs: https://developers.deepl.com/api-reference (auth header, ":fx" free keys, v3 glossaries).
import { createHash } from 'node:crypto';
import { EngineError, RetryableError, withRetry } from './engine.mjs';

/** @typedef {import('./engine.mjs').Engine} Engine */
/** @typedef {import('./glossary.mjs').Entries} Entries */

const CONTEXT =
  'Rules text printed on a card from a tabletop board game. Use the established Finnish board game ' +
  'terms and the second person imperative, as in a translated rulebook.';

/**
 * @param {{ key: string, glossaries: Map<string, Entries>, baseUrl?: string, fetch?: typeof globalThis.fetch,
 *   log?: (msg: string) => void }} opts
 * @returns {Engine}
 */
export function createDeepl({ key, glossaries, baseUrl, fetch = globalThis.fetch, log = console.log }) {
  const base = baseUrl ?? (key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
  /** Glossary id per "src-tgt", created or found once per process. */
  const glossaryIds = new Map();

  /** @param {string} method @param {string} path @param {unknown} [body] */
  async function call(method, path, body) {
    return withRetry(async () => {
      let res;
      try {
        res = await fetch(base + path, {
          method,
          headers: { Authorization: `DeepL-Auth-Key ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw new RetryableError(new EngineError(`DeepL could not be reached (${/** @type {Error} */ (e).message})`));
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      const detail = await res.text().catch(() => '');
      log(`DeepL ${method} ${path} → ${res.status} ${detail.slice(0, 200)} trace=${res.headers.get('x-trace-id')}`);
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        const after = Number(res.headers.get('retry-after'));
        throw new RetryableError(new EngineError(`DeepL is busy (${res.status}), try again shortly`, 503), after ? after * 1000 : undefined);
      }
      if (res.status === 456) throw new EngineError('The DeepL quota for this server is used up', 503);
      if (res.status === 401 || res.status === 403) throw new EngineError('The server\'s DeepL key was rejected', 503);
      throw new EngineError(`DeepL error ${res.status}`);
    });
  }

  /** Finds or creates the glossary for a language pair; old versions of it are deleted. */
  async function glossaryFor(/** @type {string} */ src, /** @type {string} */ tgt) {
    const entries = glossaries.get(`${src}-${tgt}`);
    if (!entries?.length) return undefined;
    const pair = `${src}-${tgt}`;
    if (!glossaryIds.has(pair)) {
      const promise = (async () => {
        const tsv = entries.map(([a, b]) => `${a}\t${b}`).join('\n');
        const name = `card-reader ${pair} ${createHash('sha256').update(tsv).digest('hex').slice(0, 12)}`;
        const { glossaries: existing = [] } = await call('GET', '/v3/glossaries');
        let id = existing.find((/** @type {any} */ g) => g.name === name)?.glossary_id;
        for (const g of existing) {
          if (g.name.startsWith(`card-reader ${pair} `) && g.name !== name) {
            await call('DELETE', `/v3/glossaries/${g.glossary_id}`).catch(() => undefined);
          }
        }
        if (!id) {
          ({ glossary_id: id } = await call('POST', '/v3/glossaries', {
            name,
            dictionaries: [{ source_lang: src, target_lang: tgt, entries: tsv, entries_format: 'tsv' }],
          }));
          log(`DeepL glossary created: ${name} (${entries.length} entries)`);
        }
        return id;
      })();
      glossaryIds.set(pair, promise);
      promise.catch(() => glossaryIds.delete(pair));
    }
    return glossaryIds.get(pair);
  }

  return {
    id: 'deepl',
    label: 'DeepL',
    async translate(texts, source, target) {
      // A missing glossary must not block translation; it is retried on the next request.
      const glossary_id = await glossaryFor(source, target).catch((e) => {
        log(`DeepL glossary unavailable: ${e.message}`);
        return undefined;
      });
      const { translations } = await call('POST', '/v2/translate', {
        text: texts,
        source_lang: source.toUpperCase(),
        target_lang: target.toUpperCase(),
        context: CONTEXT,
        preserve_formatting: true,
        ...(glossary_id ? { glossary_id } : {}),
      });
      return translations.map((/** @type {{ text: string }} */ t) => t.text);
    },
  };
}
