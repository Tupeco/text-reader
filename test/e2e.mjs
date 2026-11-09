// End-to-end check of the production build: install, OCR a card photo, translate, speak with Piper,
// then go offline and do it again from the service worker cache.
// Usage: npm run build && npm run preview -- --port 4173 & node test/e2e.mjs http://localhost:4173 [chromium-path]
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', exe = process.env.CHROMIUM_PATH] = process.argv.slice(2);
// E2E_KEEP_LOADED=0 runs with the "keep translator and voice loaded" setting off (default on).
const keepLoaded = process.env.E2E_KEEP_LOADED !== '0';
const step = (msg) => console.log(`\n▶ ${msg}`);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const CARD = {
  title: 'Storm Front',
  body: 'All heroes must spend 1 extra action to travel this round. Exposed settlements lose 2 resources unless sheltered.',
};

async function cardPhoto(page, glare) {
  // A card on a table, slightly rotated, with an inline icon and optional specular glare.
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.setContent(`
    <body style="margin:0;background:#6d5844;display:grid;place-items:center;height:1200px">
      <div style="width:700px;height:980px;background:#e9dcb8;border:10px solid #6b4a2a;border-radius:24px;
                  transform:rotate(-2deg);font-family:'DejaVu Serif',serif;color:#2a1e12;padding:40px;box-sizing:border-box;position:relative">
        <h1 style="text-align:center;font-size:48px;margin:0 0 24px">${CARD.title}</h1>
        <div style="height:300px;background:linear-gradient(#5a7a4a,#2d4a5a);margin-bottom:32px"></div>
        <p style="font-size:34px;line-height:1.45;margin:0">${CARD.body.replace('2 resources', '2 <span style="display:inline-block;width:30px;height:30px;border-radius:50%;background:#7a3;vertical-align:middle"></span> resources')}</p>
        ${glare ? `<div style="position:absolute;left:${glare}px;top:560px;width:300px;height:160px;border-radius:50%;background:radial-gradient(#fff 45%,#fff0 70%)"></div>` : ''}
      </div>
    </body>`);
  return page.screenshot({ type: 'jpeg', quality: 85 });
}

const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// Includes requests made by workers and the service worker, which pageerror doesn't explain.
// ERR_ABORTED is expected: Transformers.js cancels the body of its file-size probes.
context.on('requestfailed', (r) => {
  const why = r.failure()?.errorText;
  if (why !== 'net::ERR_ABORTED') errors.push(`request failed: ${r.method()} ${r.url()} (${why})`);
});
context.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()}: ${r.url()}`));

const photoPage = await context.newPage();
const clean = await cardPhoto(photoPage, 0);
const glareA = await cardPhoto(photoPage, 60);
const glareB = await cardPhoto(photoPage, 340);
await photoPage.close();

const upload = async (buffer, name = 'card.jpg') =>
  page.setInputFiles('#gallery', { name, mimeType: 'image/jpeg', buffer });

/** Waits for text in a textarea; stops early (with the app's message) if the app shows an error. */
const waitForText = async (selector, minLength, timeout = 300_000) => {
  try {
    await page.waitForFunction(
      ([s, n]) => {
        const status = document.querySelector('#status');
        if (status.classList.contains('error') && !status.hidden) throw new Error(`app error: ${status.textContent.trim()}`);
        return document.querySelector(s).value.trim().length >= n;
      },
      [selector, minLength],
      { timeout, polling: 1000 },
    );
  } catch (err) {
    const status = await page.$eval('#status', (el) => el.textContent.trim()).catch(() => '?');
    console.error(`  status: ${status}\n  page errors:\n    ${errors.join('\n    ')}`);
    throw err;
  }
  return page.$eval(selector, (el) => el.value);
};

/** Resident memory of the browser this script started (all descendants of this process), in MB. */
const browserRss = () => {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const mine = new Set([process.pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [pid, ppid] of rows) if (mine.has(ppid) && !mine.has(pid)) mine.add(pid), (grew = true);
    }
    mine.delete(process.pid);
    return Math.round(rows.filter(([pid]) => mine.has(pid)).reduce((n, [, , rss]) => n + rss, 0) / 1024);
  } catch {
    return undefined;
  }
};

/** Page memory incl. workers where Chromium supports measuring it, else the browser's resident memory. */
const memory = async (label) => {
  const mb = await page
    .evaluate(() => performance.measureUserAgentSpecificMemory?.().then((m) => Math.round(m.bytes / 1e6)))
    .catch(() => undefined);
  if (mb) console.log(`  memory after ${label}: ${mb} MB (page)`);
  else {
    const rss = browserRss();
    if (rss) console.log(`  memory after ${label}: ${rss} MB (browser RSS)`);
  }
};

const statusError = () => page.$eval('#status', (el) => (el.classList.contains('error') && !el.hidden ? el.textContent.trim() : ''));

step('Load and install the service worker');
await page.goto(base);
await page.waitForFunction(() => navigator.serviceWorker?.controller && self.crossOriginIsolated, null, { timeout: 120_000 });
console.log('  controlled by service worker, crossOriginIsolated = true');

step('About links open the GPL text and source notice, not the app');
await page.click('#open-settings');
for (const [href, expect] of [['piper/COPYING', 'GNU GENERAL PUBLIC LICENSE'], ['piper/SOURCE.txt', 'rhasspy/espeak-ng']]) {
  const [tab] = await Promise.all([context.waitForEvent('page'), page.click(`#settings a[href="${href}"]`)]);
  await tab.waitForLoadState();
  const text = await tab.evaluate(() => document.body.innerText);
  console.log(`  ${href}: ${text.includes(expect) ? 'ok' : 'WRONG CONTENT'}`);
  if (!text.includes(expect)) fail(`${href} did not serve the expected file`);
  await tab.close();
}
await page.click('#settings button[value=close]');

step('Translation off: OCR a clean card');
await page.evaluate((keepModelsLoaded) => {
  localStorage.setItem('card-reader:settings', JSON.stringify({ translate: false, voiceEngine: 'piper', keepModelsLoaded }));
}, keepLoaded);
// Record every status message, to check that OCR reports its progress.
await page.addInitScript(() => {
  self.statusLog = [];
  addEventListener('DOMContentLoaded', () => {
    const text = document.querySelector('#status-text');
    const bar = document.querySelector('#status-progress');
    new MutationObserver(() => self.statusLog.push(`${text.textContent} [${bar.hasAttribute('value') ? bar.value : '…'}]`))
      .observe(document.querySelector('#status'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
});
await page.reload();
await page.waitForFunction(() => self.crossOriginIsolated);
let t0 = Date.now();
await upload(clean);
const source = await waitForText('#source', 40);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(source));
if (process.env.E2E_UNTIL === 'ocr') {
  await browser.close();
  process.exit(process.exitCode ?? 0);
}
await memory('OCR');
const statusLog = await page.evaluate(() => self.statusLog);
const reading = statusLog.filter((l) => l.startsWith('Reading text'));
console.log(`  OCR progress: ${[...new Set(statusLog.filter((l) => /^(Finding|Reading) text/.test(l)))].join(' → ')}`);
if (!statusLog.some((l) => l.startsWith('Finding text'))) fail('OCR did not report "Finding text"');
if (!reading.some((l) => !l.endsWith('[…]') && !l.endsWith('[0]'))) fail('OCR did not report per-line progress');
for (const word of ['Storm Front', 'extra action', 'settlements lose 2 resources']) {
  if (!source.includes(word)) fail(`recognized text is missing "${word}"`);
}

step('Translation on: English → Finnish');
await page.click('#open-settings');
await page.check('input[name=translate]');
await page.click('#settings button[value=close]');
t0 = Date.now();
await page.click('#retranslate');
const fi = await waitForText('#target', 20);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(fi));
if (!/sankari|myrsky|toiminto|toimin/i.test(fi)) fail('translation does not look Finnish');
await memory('translation');

step('Read aloud with Piper (Finnish)');
t0 = Date.now();
await page.click('#speak');
await page.waitForFunction(() => document.querySelector('#speak span').textContent === 'Stop', null, { timeout: 30_000 });
await page.waitForFunction(() => document.querySelector('#speak span').textContent === 'Read aloud', null, { timeout: 300_000 });
console.log(`  finished speaking in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (await statusError()) fail(`speech error: ${await statusError()}`);
await memory(`Piper (translator ${keepLoaded ? 'kept loaded' : 'unloaded'})`);

step(`Translate and read again (models ${keepLoaded ? 'kept loaded' : 'swapped'})`);
const before = await page.$eval('#target', (el) => el.value);
await page.click('#tab-source');
await page.fill('#source', `${await page.$eval('#source', (el) => el.value)}\nDraw a card.`);
t0 = Date.now();
await page.click('#retranslate');
await page.waitForFunction((prev) => {
  const v = document.querySelector('#target').value;
  return v && v !== prev;
}, before, { timeout: 300_000 });
console.log(`  translated again in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
t0 = Date.now();
await page.click('#speak');
await page.waitForFunction(() => document.querySelector('#speak span').textContent === 'Stop', null, { timeout: 30_000 });
await page.waitForFunction(() => document.querySelector('#speak span').textContent === 'Read aloud', null, { timeout: 300_000 });
console.log(`  read aloud again in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (await statusError()) fail(`error: ${await statusError()}`);
await memory('second round');

step('Glare: two shots of the same card are merged');
await page.click('#photos .photo button[aria-label="Remove photo"]');
await upload(glareA, 'a.jpg');
await page.waitForFunction(() => document.querySelector('.photo.done'), null, { timeout: 300_000 });
const glareFlag = await page.$('.photo .chip.warn');
console.log(`  glare warning shown: ${!!glareFlag}`);
if (!glareFlag) fail('no glare warning on a photo with glare');
const single = await page.$eval('#source', (el) => el.value);
await upload(glareB, 'b.jpg');
await page.waitForFunction(() => document.querySelectorAll('.photo.done').length === 2, null, { timeout: 300_000 });
await page.check('.photo:nth-child(2) .photo-tools input[type=checkbox]');
await page.waitForTimeout(500);
const merged = await page.$eval('#source', (el) => el.value);
console.log('  shot A only:', JSON.stringify(single));
console.log('  merged     :', JSON.stringify(merged));
if (!merged.includes('extra action') || !merged.includes('settlements')) fail('merged text is missing words');

step('Offline: reload and read a card again');
await context.setOffline(true);
await page.reload();
await page.waitForSelector('#camera');
await upload(clean, 'offline.jpg');
const offlineSource = await waitForText('#source', 40);
const offlineFi = await waitForText('#target', 20);
console.log('  source:', JSON.stringify(offlineSource));
console.log('  target:', JSON.stringify(offlineFi));
if (!offlineSource.includes('Storm Front')) fail('offline OCR failed');
if (await statusError()) fail(`offline error: ${await statusError()}`);

await browser.close();
const relevant = errors.filter((e) => !/Failed to load resource/.test(e));
if (relevant.length) {
  console.log('\nPage errors:\n ', relevant.join('\n  '));
  fail('page logged errors');
}
console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E PASSED');
