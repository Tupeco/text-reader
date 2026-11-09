// @ts-check
// Translation API for Card Reader. Runs next to the static app (compose service "api"); nginx forwards
// <BASE_PATH>api/… here. Engines are enabled by environment variables (see .env.example):
//   DEEPL_API_KEY            → "deepl"
//   LLM_URL (+ LLM_MODEL)    → "llm", an OpenAI-compatible server such as the "llm" compose profile
// The app falls back to on-device translation when this API is missing, offline or failing.
import { createServer } from 'node:http';
import { createDeepl } from './deepl.mjs';
import { EngineError } from './engine.mjs';
import { loadGlossaries } from './glossary.mjs';
import { createLlm } from './llm.mjs';
import { createLimits } from './limits.mjs';

const env = process.env;
const glossaries = await loadGlossaries(env.GLOSSARY_DIR ?? new URL('../glossary', import.meta.url).pathname);

/** @type {Map<string, import('./engine.mjs').Engine>} */
const engines = new Map();
if (env.DEEPL_API_KEY) engines.set('deepl', createDeepl({ key: env.DEEPL_API_KEY, glossaries, baseUrl: env.DEEPL_API_URL || undefined }));
if (env.LLM_URL) engines.set('llm', createLlm({ url: env.LLM_URL, model: env.LLM_MODEL || undefined, label: env.LLM_LABEL || undefined, apiKey: env.LLM_API_KEY || undefined, glossaries }));
// Order of preference for the app's "Automatic" choice.
const order = (env.TRANSLATE_ENGINES ?? 'deepl,llm').split(',').map((s) => s.trim()).filter((id) => engines.has(id));
for (const id of engines.keys()) if (!order.includes(id)) order.push(id);

const limits = createLimits({
  perClientPerHour: Number(env.TRANSLATE_REQUESTS_PER_HOUR ?? 120),
  charsPerDay: Number(env.TRANSLATE_CHARS_PER_DAY ?? 50_000),
});
const MAX_TEXTS = 50;
const MAX_CHARS = 5_000;

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(/** @type {import('node:http').IncomingMessage} */ req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new EngineError('Request too large', 413);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new EngineError('Invalid JSON', 400);
  }
}

/** The client address as seen by the reverse proxy (nginx sets X-Real-IP from X-Forwarded-For). */
const clientOf = (/** @type {import('node:http').IncomingMessage} */ req) =>
  String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?');

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  try {
    if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/api/translate/engines') {
      const listed = [];
      for (const id of order) {
        const engine = /** @type {import('./engine.mjs').Engine} */ (engines.get(id));
        if (!engine.available || (await engine.available())) listed.push({ id, label: engine.label });
      }
      return send(res, 200, { engines: listed });
    }
    if (req.method === 'POST' && path === '/api/translate') {
      const body = await readJson(req);
      const { engine: id, source, target, texts } = body ?? {};
      const engine = engines.get(id);
      if (!engine) throw new EngineError(`Unknown engine "${id}"`, 400);
      if (!/^[a-z]{2,3}$/.test(source) || !/^[a-z]{2,3}$/.test(target)) throw new EngineError('Invalid language', 400);
      if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS || !texts.every((t) => typeof t === 'string')) {
        throw new EngineError(`texts must be 1–${MAX_TEXTS} strings`, 400);
      }
      const chars = texts.reduce((n, t) => n + t.length, 0);
      if (chars > MAX_CHARS) throw new EngineError(`At most ${MAX_CHARS} characters per request`, 413);
      limits.take(clientOf(req), chars);
      const t0 = Date.now();
      const out = await engine.translate(texts, source, target);
      console.log(`${id} ${source}-${target} ${chars} chars in ${Date.now() - t0} ms`);
      return send(res, 200, { engine: id, texts: out });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const err = e instanceof EngineError ? e : new EngineError('Translation failed', 500);
    if (!(e instanceof EngineError)) console.error(e);
    send(res, err.status, { error: err.message });
  }
});

const port = Number(env.PORT ?? 8080);
server.listen(port, () => console.log(`translation API on :${port}; engines: ${order.join(', ') || 'none'}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
