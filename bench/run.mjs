// Runs bench/index.html in headless Chromium and prints a per-engine/variant summary.
// Usage: node bench/run.mjs <base-url> [engines] [chromium-path] [variants]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base = 'http://localhost:5173', engines = 'v6s,v6s-flat', exe, variants] = process.argv.slice(2);
// One browser per engine keeps peak memory low enough for small devices.
const out = { results: [] };
for (const engine of engines.split(',')) {
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
  await page.goto(`${base}/bench/index.html?engines=${engine}${variants ? `&variants=${variants}` : ''}`);
  const done = await page.waitForFunction(() => window.benchDone, null, { timeout: 0, polling: 1000 });
  const res = await done.jsonValue();
  await browser.close();
  if (res.error) throw new Error(res.error);
  out.results.push(...res.results);
  out.isolated = res.isolated;
}
writeFileSync(new URL('./last-results.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`crossOriginIsolated=${out.isolated}`);
const groups = new Map();
for (const r of out.results) {
  const k = `${r.engine.padEnd(18)} ${r.variant.padEnd(6)}`;
  const g = groups.get(k) ?? { cer: [], ms: [], init: r.initMs };
  g.cer.push(r.cer); g.ms.push(r.ms);
  groups.set(k, g);
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (const [k, g] of groups) {
  console.log(`${k} CER ${(avg(g.cer) * 100).toFixed(1).padStart(5)}%  ${(avg(g.ms) / 1000).toFixed(2)}s/card  init ${(g.init / 1000).toFixed(1)}s`);
}
