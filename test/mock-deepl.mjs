// A stand-in for the DeepL API, for tests: glossaries in memory, translations marked "[DeepL] …".
// GET /_calls returns what it received. Usage: node test/mock-deepl.mjs [port]
import { createServer } from 'node:http';

const glossaries = new Map();
const calls = [];
const port = Number(process.argv[2] ?? 8090);

createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : undefined;
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  if (req.url === '/_calls') return send(200, calls);
  calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
  if (!req.headers.authorization?.startsWith('DeepL-Auth-Key ')) return send(403, { message: 'no key' });
  if (req.url === '/v3/glossaries' && req.method === 'GET') {
    return send(200, { glossaries: [...glossaries.values()].map(({ entries, ...g }) => g) });
  }
  if (req.url === '/v3/glossaries' && req.method === 'POST') {
    const id = `g${glossaries.size + 1}`;
    glossaries.set(id, { glossary_id: id, name: json.name, entries: json.dictionaries[0].entries });
    return send(201, { glossary_id: id, name: json.name, ready: true });
  }
  if (req.url?.startsWith('/v3/glossaries/') && req.method === 'DELETE') {
    glossaries.delete(req.url.split('/').pop());
    return send(204);
  }
  if (req.url === '/v2/translate') {
    return send(200, { translations: json.text.map((t) => ({ detected_source_language: 'EN', text: `[DeepL] ${t}` })) });
  }
  send(404, { message: 'not found' });
}).listen(port, () => console.log(`mock DeepL on :${port}`));
