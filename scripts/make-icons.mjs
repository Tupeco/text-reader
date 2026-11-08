// Renders public/icon.svg into the PNG icons the web app manifest and iOS need.
// Usage: CHROMIUM_PATH=/path/to/chrome node scripts/make-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const pub = new URL('../public/', import.meta.url);
const svg = await readFile(new URL('icon.svg', pub), 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const icons = [
  { file: 'icon-192.png', size: 192, pad: 0, bg: 'transparent' },
  { file: 'icon-512.png', size: 512, pad: 0, bg: 'transparent' },
  // Maskable icons get cropped to a circle or squircle: keep the art inside the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, pad: 0.12, bg: '#2d2417' },
  { file: 'apple-touch-icon.png', size: 180, pad: 0, bg: '#2d2417' },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage();
for (const { file, size, pad, bg } of icons) {
  const inner = Math.round(size * (1 - 2 * pad));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:${bg};display:grid;place-items:center;height:${size}px">` +
      `<img src="${dataUrl}" width="${inner}" height="${inner}"></body>`,
  );
  await writeFile(new URL(file, pub), await page.screenshot({ omitBackground: bg === 'transparent' }));
  console.log(`wrote public/${file}`);
}
await browser.close();
