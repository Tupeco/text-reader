// @ts-check
// Language model engine: any OpenAI-compatible chat completions server (llama.cpp's llama-server,
// Ollama, vLLM, …). Each paragraph is translated in its own request at temperature 0, with the
// glossary terms that occur in it.
import { EngineError, RetryableError, withRetry } from './engine.mjs';

/** @typedef {import('./engine.mjs').Engine} Engine */
/** @typedef {import('./glossary.mjs').Entries} Entries */

const LANGUAGES = /** @type {Record<string, string>} */ ({
  en: 'English', fi: 'Finnish', sv: 'Swedish', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
  nl: 'Dutch', da: 'Danish', no: 'Norwegian', et: 'Estonian', pl: 'Polish',
});

/** Glossary entries whose English term occurs in the text (whole words, case-insensitive). */
export function relevantTerms(/** @type {Entries} */ entries, /** @type {string} */ text) {
  const lower = text.toLowerCase();
  return entries.filter(([term]) => new RegExp(`(^|[^\\p{L}])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(lower));
}

export function buildMessages(/** @type {string} */ text, /** @type {string} */ source, /** @type {string} */ target, /** @type {Entries} */ terms) {
  const from = LANGUAGES[source] ?? source;
  const to = LANGUAGES[target] ?? target;
  const glossary = terms.length
    ? `\n\nUse these established ${to} board game terms, inflected to fit the sentence:\n` +
      terms.map(([a, b]) => `- ${a} → ${b}`).join('\n')
    : '';
  return [
    {
      role: 'system',
      content:
        `You translate rules text from tabletop board game cards from ${from} to ${to}. ` +
        `Write natural, grammatical ${to} as in a professionally translated rulebook, addressing the player ` +
        `in the second person. Keep numbers, card names and symbols. The text comes from OCR and may contain ` +
        `small recognition errors; translate the intended meaning. Reply with the translation only, no notes.` +
        glossary,
    },
    { role: 'user', content: text },
  ];
}

/**
 * @param {{ url: string, model?: string, label?: string, apiKey?: string, glossaries: Map<string, Entries>,
 *   fetch?: typeof globalThis.fetch, timeoutMs?: number }} opts
 * @returns {Engine}
 */
export function createLlm({ url, model = 'default', label, apiKey, glossaries, fetch = globalThis.fetch, timeoutMs = 180_000 }) {
  const endpoint = `${url.replace(/\/+$/, '')}/v1/chat/completions`;

  async function complete(/** @type {object[]} */ messages) {
    return withRetry(async () => {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 1024, stream: false }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const err = /** @type {Error} */ (e);
        if (err.name === 'TimeoutError') throw new EngineError('The language model took too long', 504);
        throw new RetryableError(new EngineError(`The language model server could not be reached (${err.message})`, 503));
      }
      // llama-server answers 503 while it is still loading the model.
      if (res.status === 503 || res.status === 429) throw new RetryableError(new EngineError('The language model is still loading, try again shortly', 503), 2000);
      if (!res.ok) throw new EngineError(`Language model error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = /** @type {any} */ (await res.json());
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new EngineError('The language model returned no text');
      return stripThinking(text).trim();
    });
  }

  // Only offer the engine while the server answers, so "Automatic" doesn't pick a stopped service.
  let health = { at: 0, ok: false };
  async function available() {
    if (Date.now() - health.at < 15_000) return health.ok;
    let ok = false;
    try {
      // llama-server: 200 when ready, 503 while loading (still worth offering). Others may lack /health.
      const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2000) });
      ok = res.ok || res.status === 503 || res.status === 404;
    } catch {
      ok = false;
    }
    health = { at: Date.now(), ok };
    return ok;
  }

  return {
    id: 'llm',
    label: label ?? 'Language model (this server)',
    available,
    async translate(texts, source, target) {
      const entries = glossaries.get(`${source}-${target}`) ?? [];
      const out = [];
      for (const text of texts) out.push(await complete(buildMessages(text, source, target, relevantTerms(entries, text))));
      return out;
    },
  };
}

/** Some models wrap reasoning in <think>…</think> before the answer. */
export function stripThinking(/** @type {string} */ text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '');
}
