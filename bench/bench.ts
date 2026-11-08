// OCR benchmark on synthetic "board game card" photos, scored by character error rate.
// Driven by bench/run.mjs; engines are selected with ?engines=v6s,v6s-flat,...
import * as ort from 'onnxruntime-web/wasm';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { init as initPaddle } from 'esearch-ocr';
import { flattenLighting } from '../src/image';
import { fragmentsFromRaw, layoutRows, type RawLine } from '../src/layout';
import { mergeShots } from '../src/merge';
import { cleanOcrText, linesToText, type OcrLine } from '../src/text';

ort.env.wasm.wasmPaths = { wasm: ortWasm };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1;

const CARDS = [
  { title: 'Wandering Merchant', body: 'When you reveal this card, you may trade 2 wood for 1 stone. If you do, gain 1 renown.\nOnce per season: discard a food to draw a card.' },
  { title: 'Ancient Grove', body: 'Place a settler here. At the start of each day, if no hero is adjacent, the forest grows: add 1 tree token to each empty space.' },
  { title: 'Storm Front', body: 'All heroes must spend 1 extra action to travel this round. Exposed settlements lose 2 resources of their choice unless sheltered.' },
  { title: 'The Old Stone Bridge', body: "Heroes crossing the river here don't pay the toll. When the bridge is damaged, roll a die: on 4 or higher it holds, otherwise flip this card." },
  { title: 'Hunting Party', body: 'Choose up to three villagers. Each villager rolls 2 dice and gains meat equal to the highest result. Exhaust any villager who rolled doubles.' },
  { title: 'Lost in the Fog', body: 'Your next movement is random. Shuffle the path deck and draw the top card; you must follow it. Afterwards, recover 1 morale.' },
];

type Variant = { name: string; rot: number; blur: number; jpeg: number; dark?: boolean; lighting?: boolean; glare?: 'soft' | 'heavy'; glareAt?: [number, number]; scale: number };
const VARIANTS: Variant[] = [
  { name: 'clean', rot: 0, blur: 0, jpeg: 0.95, scale: 1 },
  { name: 'photo', rot: 2.5, blur: 0.8, jpeg: 0.7, lighting: true, scale: 1 },
  { name: 'rough', rot: -4, blur: 1.4, jpeg: 0.55, lighting: true, scale: 0.7 },
  { name: 'dark', rot: 1.5, blur: 0.6, jpeg: 0.75, dark: true, scale: 1 },
  { name: 'glare', rot: 1.5, blur: 0.7, jpeg: 0.7, lighting: true, glare: 'soft', scale: 1 },
  { name: 'glare-heavy', rot: -1, blur: 0.7, jpeg: 0.7, lighting: true, glare: 'heavy', scale: 1 },
];

function rand(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > width && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function drawIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, hue: number) {
  ctx.save();
  ctx.fillStyle = `hsl(${hue} 55% 40%)`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4e8c8';
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.6);
  ctx.lineTo(x + r * 0.5, y + r * 0.4);
  ctx.lineTo(x - r * 0.5, y + r * 0.4);
  ctx.fill();
  ctx.restore();
}

// Renders a card photo; inline icons are drawn after numbers (like "2 [wood-icon]") and are not part of the ground truth.
function renderCard(card: { title: string; body: string }, v: Variant, seed: number): HTMLCanvasElement {
  const r = rand(seed);
  const W = 900, H = 1260;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  // Parchment with mottling.
  ctx.fillStyle = v.dark ? '#2b2a35' : '#e9dcb8';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = v.dark ? `rgba(90,80,120,${r() * 0.15})` : `rgba(120,90,40,${r() * 0.12})`;
    ctx.beginPath();
    ctx.arc(r() * W, r() * H, 10 + r() * 60, 0, Math.PI * 2);
    ctx.fill();
  }
  // Art box and frame.
  const g = ctx.createLinearGradient(0, 0, W, 500);
  g.addColorStop(0, '#5a7a4a'); g.addColorStop(1, '#2d4a5a');
  ctx.fillStyle = g;
  ctx.fillRect(60, 140, W - 120, 420);
  ctx.strokeStyle = v.dark ? '#a99' : '#6b4a2a';
  ctx.lineWidth = 10;
  ctx.strokeRect(25, 25, W - 50, H - 50);
  const ink = v.dark ? '#f1ead8' : '#2a1e12';
  ctx.fillStyle = ink;
  ctx.font = 'bold 54px "DejaVu Serif", serif';
  ctx.textAlign = 'center';
  ctx.fillText(card.title, W / 2, 105);
  ctx.textAlign = 'left';
  ctx.font = '36px "DejaVu Serif", serif';
  const lines = wrap(ctx, card.body, W - 140);
  let y = 640;
  for (const line of lines) {
    let x = 70;
    for (const word of line.split(' ')) {
      ctx.fillStyle = ink;
      ctx.fillText(word, x, y);
      x += ctx.measureText(word + ' ').width;
      if (/^\d$/.test(word) && r() < 0.8) {
        drawIcon(ctx, x + 14, y - 12, 16, Math.floor(r() * 360));
        x += 40;
      }
    }
    y += 50;
  }
  // Photograph it: rotate on a table, blur, lighting, jpeg.
  const out = document.createElement('canvas');
  out.width = Math.round(1100 * v.scale); out.height = Math.round(1500 * v.scale);
  const o = out.getContext('2d')!;
  o.fillStyle = '#6d5844';
  o.fillRect(0, 0, out.width, out.height);
  o.filter = v.blur ? `blur(${v.blur * v.scale}px)` : 'none';
  o.translate(out.width / 2, out.height / 2);
  o.rotate((v.rot * Math.PI) / 180);
  o.scale(v.scale, v.scale);
  o.drawImage(c, -W / 2, -H / 2);
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.filter = 'none';
  if (v.lighting) {
    const lg = o.createRadialGradient(out.width * 0.2, out.height * 0.2, 50, out.width * 0.5, out.height * 0.6, out.width);
    lg.addColorStop(0, 'rgba(255,255,240,0.25)');
    lg.addColorStop(1, 'rgba(0,0,20,0.35)');
    o.fillStyle = lg;
    o.fillRect(0, 0, out.width, out.height);
  }
  if (v.glare) {
    // Specular hotspot: a blown-out core with a soft halo over part of the body text.
    // "heavy" has a fully blown-out core on the rules text that erases words on 3–4 lines.
    const heavy = v.glare === 'heavy';
    const [fx, fy] = v.glareAt ?? [0.3 + r() * 0.4, heavy ? 0.5 + r() * 0.1 : 0.55 + r() * 0.2];
    const gx = out.width * fx, gy = out.height * fy;
    const sg = o.createRadialGradient(gx, gy, 10, gx, gy, heavy ? 200 : 260);
    sg.addColorStop(0, 'rgba(255,255,255,1)');
    sg.addColorStop(heavy ? 0.55 : 0.35, heavy ? 'rgba(255,255,255,1)' : 'rgba(255,255,250,0.9)');
    sg.addColorStop(1, 'rgba(255,255,250,0)');
    o.fillStyle = sg;
    o.save();
    o.translate(gx, gy); o.scale(1.8, 0.7); o.translate(-gx, -gy);
    o.fillRect(0, 0, out.width, out.height);
    o.restore();
  }
  const img = o.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  o.putImageData(img, 0, 0);
  return out;
}

async function jpeg(c: HTMLCanvasElement, q: number): Promise<HTMLCanvasElement> {
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', q));
  const bmp = await createImageBitmap(blob);
  const out = document.createElement('canvas');
  out.width = bmp.width; out.height = bmp.height;
  out.getContext('2d')!.drawImage(bmp, 0, 0);
  return out;
}

function norm(s: string) {
  return s.replace(/\s+/g, ' ').trim();
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

type Engine = { name: string; run: (c: HTMLCanvasElement) => Promise<OcrLine[]> };

async function paddle(name: string, dir: string, det: string, rec: string, dic: string, flat: boolean): Promise<Engine> {
  const dict = await (await fetch(`/${dir}/${dic}`)).text();
  const p = await initPaddle({
    ort: ort as never,
    det: { input: `/${dir}/${det}` },
    rec: { input: `/${dir}/${rec}`, decodeDic: dict, optimize: { space: false } },
  });
  return {
    name: flat ? `${name}+flat` : name,
    run: async (c) => {
      const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
      // Same pipeline as src/ml.worker.ts.
      const boxes = await p.det(flat ? flattenLighting(data) : data);
      return layoutRows(fragmentsFromRaw((await p.recRaw(boxes)) as unknown as RawLine[]));
    },
  };
}

const text = (lines: OcrLine[]) => norm(cleanOcrText(linesToText(lines)));

async function main() {
  const which = new URLSearchParams(location.search).get('engines')?.split(',') ?? ['v6s', 'v6s-flat'];
  const makers: Record<string, () => Promise<Engine>> = {
    v6s: () => paddle('paddle-v6-small', 'ocr', 'ppocr6_small_det.onnx', 'ppocr6_small_rec.onnx', 'dic.txt', false),
    'v6s-flat': () => paddle('paddle-v6-small', 'ocr', 'ppocr6_small_det.onnx', 'ppocr6_small_rec.onnx', 'dic.txt', true),
    v6t: () => paddle('paddle-v6-tiny', 'bench-models', 'ppocr6_tiny_det.onnx', 'ppocr6_tiny_rec.onnx', 'tiny_dic.txt', false),
  };
  const only = new URLSearchParams(location.search).get('variants')?.split(',');
  const images: { card: number; variant: string; canvas: HTMLCanvasElement; truth: string }[] = [];
  for (const [ci, card] of CARDS.entries()) {
    for (const v of VARIANTS) {
      if (only && !only.includes(v.name)) continue;
      images.push({ card: ci, variant: v.name, canvas: await jpeg(renderCard(card, v, ci * 100 + 7), v.jpeg), truth: norm(`${card.title} ${card.body}`) });
    }
  }
  // Two heavy-glare shots of each card with the hotspot in different places, as the app's
  // "add another angle" flow would produce.
  const heavy = VARIANTS.find((v) => v.name === 'glare-heavy')!;
  const angleA: Variant = { ...heavy, rot: -1.5, glareAt: [0.38, 0.52] };
  const angleB: Variant = { ...heavy, rot: 3, glareAt: [0.62, 0.64] };
  const pairs = only && !only.includes('merged')
    ? []
    : await Promise.all(
        CARDS.map(async (card, ci) => ({
          card: ci,
          shots: [await jpeg(renderCard(card, angleA, ci * 100 + 7), heavy.jpeg), await jpeg(renderCard(card, angleB, ci * 100 + 55), heavy.jpeg)],
          truth: norm(`${card.title} ${card.body}`),
        })),
      );
  const results: object[] = [];
  const score = (got: string, truth: string) => levenshtein(got, truth) / truth.length;
  for (const key of which) {
    const t0 = performance.now();
    const engine = await makers[key]();
    const initMs = performance.now() - t0;
    for (const img of images) {
      const t = performance.now();
      const got = text(await engine.run(img.canvas));
      results.push({ engine: engine.name, initMs, card: img.card, variant: img.variant, ms: performance.now() - t, cer: score(got, img.truth), text: got, truth: img.truth });
    }
    for (const pair of pairs) {
      const t = performance.now();
      const shots = [await engine.run(pair.shots[0]), await engine.run(pair.shots[1])];
      for (const [k, shotLines] of shots.entries()) {
        const one = text(shotLines);
        results.push({ engine: engine.name, initMs, card: pair.card, variant: `shot-${'AB'[k]}`, ms: 0, cer: score(one, pair.truth), text: one, truth: pair.truth });
      }
      const got = text(mergeShots(shots));
      results.push({ engine: engine.name, initMs, card: pair.card, variant: 'merged', ms: (performance.now() - t) / 2, cer: score(got, pair.truth), text: got, truth: pair.truth });
    }
  }
  (window as { benchDone?: unknown }).benchDone = { results, isolated: self.crossOriginIsolated };
}

main().catch((e) => ((window as { benchDone?: unknown }).benchDone = { error: String(e?.stack ?? e) }));
