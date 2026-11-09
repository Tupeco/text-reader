import { describe, expect, it } from 'vitest';
import { createDeepl } from './deepl.mjs';
import { parseTsv } from './glossary.mjs';
import { buildMessages, createLlm, relevantTerms, stripThinking } from './llm.mjs';
import { createLimits } from './limits.mjs';

/** A fake fetch that answers from a list of handlers and records every call. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const [status, body, headers = {}] = await handler(call, calls.length);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  };
  return Object.assign(fn, { calls });
}

const glossaries = new Map([['en-fi', parseTsv('deck\tpakka\ndraw a card\tnosta kortti\n')]]);
const quiet = () => {};

describe('DeepL engine', () => {
  it('creates the glossary once, then translates with it', async () => {
    const fetch = fakeFetch(({ url, method }) => {
      if (url.endsWith('/v3/glossaries') && method === 'GET') return [200, { glossaries: [] }];
      if (url.endsWith('/v3/glossaries') && method === 'POST') return [201, { glossary_id: 'g1' }];
      if (url.endsWith('/v2/translate')) return [200, { translations: [{ text: 'Nosta kortti.' }, { text: 'Sekoita pakka.' }] }];
      return [404, {}];
    });
    const deepl = createDeepl({ key: 'k:fx', glossaries, fetch, log: quiet });
    expect(await deepl.translate(['Draw a card.', 'Shuffle the deck.'], 'en', 'fi')).toEqual(['Nosta kortti.', 'Sekoita pakka.']);
    await deepl.translate(['Again.'], 'en', 'fi');

    expect(fetch.calls[0].url).toBe('https://api-free.deepl.com/v3/glossaries');
    expect(fetch.calls[0].headers.Authorization).toBe('DeepL-Auth-Key k:fx');
    const create = fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v3/glossaries'));
    expect(create.body.dictionaries).toEqual([{ source_lang: 'en', target_lang: 'fi', entries: 'deck\tpakka\ndraw a card\tnosta kortti', entries_format: 'tsv' }]);
    const translates = fetch.calls.filter((c) => c.url.endsWith('/v2/translate'));
    expect(translates).toHaveLength(2);
    expect(translates[0].body).toMatchObject({ text: ['Draw a card.', 'Shuffle the deck.'], source_lang: 'EN', target_lang: 'FI', glossary_id: 'g1' });
    expect(translates[0].body.context).toMatch(/board game/);
    expect(fetch.calls.filter((c) => c.url.endsWith('/v3/glossaries'))).toHaveLength(2); // list + create, once
  });

  it('reuses a matching glossary and deletes outdated versions', async () => {
    let name;
    const fetch = fakeFetch(({ url, method, body }) => {
      if (url.endsWith('/v3/glossaries') && method === 'GET') {
        return [200, { glossaries: [{ name: 'card-reader en-fi 000000000000', glossary_id: 'old' }, ...(name ? [{ name, glossary_id: 'cur' }] : [])] }];
      }
      if (method === 'POST' && url.endsWith('/v3/glossaries')) return ((name = body.name), [201, { glossary_id: 'cur' }]);
      if (method === 'DELETE') return [204];
      return [200, { translations: [{ text: 'x' }] }];
    });
    await createDeepl({ key: 'k', glossaries, fetch, log: quiet }).translate(['a'], 'en', 'fi');
    expect(fetch.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v3/glossaries/old'))).toBe(true);
    expect(fetch.calls[0].url.startsWith('https://api.deepl.com/')).toBe(true); // Pro key: no ":fx"

    fetch.calls.length = 0;
    await createDeepl({ key: 'k', glossaries, fetch, log: quiet }).translate(['a'], 'en', 'fi');
    expect(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v3/glossaries'))).toBe(false);
  });

  it('reports quota and key errors in plain words, and retries when busy', async () => {
    const quota = fakeFetch(({ url }) => (url.includes('glossaries') ? [200, { glossaries: [{ name: 'x', glossary_id: 'x' }] }] : [456, { message: 'Quota exceeded' }]));
    await expect(createDeepl({ key: 'k', glossaries: new Map(), fetch: quota, log: quiet }).translate(['a'], 'en', 'fi')).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/quota/) });

    const busy = fakeFetch((_, n) => (n === 1 ? [429, {}, { 'retry-after': '0' }] : [200, { translations: [{ text: 'ok' }] }]));
    expect(await createDeepl({ key: 'k', glossaries: new Map(), fetch: busy, log: quiet }).translate(['a'], 'en', 'fi')).toEqual(['ok']);
    expect(busy.calls).toHaveLength(2);
  });
});

describe('language model engine', () => {
  it('puts only the glossary terms that occur into the prompt', () => {
    const entries = parseTsv('deck\tpakka\ndraw a card\tnosta kortti\nround\tkierros\n');
    expect(relevantTerms(entries, 'Draw a card, then shuffle the DECK.').map(([t]) => t)).toEqual(['deck', 'draw a card']);
    expect(relevantTerms(entries, 'Surround the decks')).toEqual([]); // whole words only
    const [system, user] = buildMessages('Draw a card.', 'en', 'fi', [['draw a card', 'nosta kortti']]);
    expect(system.content).toMatch(/from English to Finnish/);
    expect(system.content).toMatch(/draw a card → nosta kortti/);
    expect(user).toEqual({ role: 'user', content: 'Draw a card.' });
  });

  it('translates each paragraph with temperature 0 and strips reasoning', async () => {
    const fetch = fakeFetch(({ body }) => [200, { choices: [{ message: { content: `<think>hmm</think>\n${body.messages[1].content.toUpperCase()}\n` } }] }]);
    const llm = createLlm({ url: 'http://llm:8080/', model: 'm', glossaries, fetch });
    expect(await llm.translate(['one', 'two'], 'en', 'fi')).toEqual(['ONE', 'TWO']);
    expect(fetch.calls[0].url).toBe('http://llm:8080/v1/chat/completions');
    expect(fetch.calls[0].body).toMatchObject({ model: 'm', temperature: 0, stream: false });
    expect(stripThinking('<think>a\nb</think>x')).toBe('x');
  });
});

describe('limits', () => {
  it('limits requests per client per hour and characters per day', () => {
    let t = Date.parse('2026-11-10T10:00:00Z');
    const limits = createLimits({ perClientPerHour: 2, charsPerDay: 100, now: () => t });
    limits.take('a', 10);
    limits.take('a', 10);
    expect(() => limits.take('a', 10)).toThrow(/Too many/);
    limits.take('b', 70);
    expect(() => limits.take('c', 20)).toThrow(/daily/);
    t += 3_600_001;
    limits.take('a', 5);
    t += 24 * 3_600_000;
    limits.take('c', 90);
  });

  it('rejects malformed glossary lines and duplicates', () => {
    expect(() => parseTsv('deck pakka')).toThrow(/term<TAB>translation/);
    expect(() => parseTsv('deck\tpakka\ndeck\tkansi')).toThrow(/duplicate/);
    expect(parseTsv('# c\n\ndeck\tpakka\n')).toEqual([['deck', 'pakka']]);
  });
});
