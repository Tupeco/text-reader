// Image helpers: loading/downscaling photos, glare detection and lighting correction.
// Works on ImageData so the same code runs on the main thread, in workers and in the bench.

export type Rect = { x: number; y: number; w: number; h: number };

// Paddle's detector works on ~960px; a little extra keeps small rules text legible.
export const MAX_SIDE = 2000;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function ctx2d(c: AnyCanvas): Ctx2D {
  return c.getContext('2d', { willReadFrequently: true }) as Ctx2D;
}

/** Decodes a photo (EXIF orientation applied), downscaled to MAX_SIDE. */
export async function loadPhoto(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

/** Rotates (multiples of 90°, clockwise), then crops in the rotated image's coordinates. */
export function transform(img: ImageData, rotation: number, crop?: Rect): ImageData {
  const quarter = (((rotation % 360) + 360) % 360) / 90;
  if (!quarter && !crop) return img;
  const src = makeCanvas(img.width, img.height);
  ctx2d(src).putImageData(img, 0, 0);
  const swap = quarter % 2 === 1;
  const rotated = makeCanvas(swap ? img.height : img.width, swap ? img.width : img.height);
  const ctx = ctx2d(rotated);
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(src as CanvasImageSource, -img.width / 2, -img.height / 2);
  const r = crop ?? { x: 0, y: 0, w: rotated.width, h: rotated.height };
  return ctx.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h)));
}

/** A pixel is treated as specular glare when every channel is clipped near white. */
export const GLARE_LEVEL = 248;

export type GlareReport = {
  /** Share of pixels that are clipped, 0..1. */
  fraction: number;
  /** Share of the largest clipped blob (cells of a coarse grid), 0..1. */
  largestBlob: number;
};

/** Detects blown-out highlights on a coarse grid; single bright pixels don't count. */
export function detectGlare(img: ImageData, cell = 16): GlareReport {
  const { width: w, height: h, data } = img;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const counts = new Uint32Array(gw * gh);
  let clipped = 0;
  for (let y = 0; y < h; y++) {
    const row = (y / cell) | 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] >= GLARE_LEVEL && data[i + 1] >= GLARE_LEVEL && data[i + 2] >= GLARE_LEVEL) {
        clipped++;
        counts[row * gw + ((x / cell) | 0)]++;
      }
    }
  }
  // A cell is glare when most of it is clipped; flood-fill to find the largest blob.
  const hot = counts.map((c) => (c > cell * cell * 0.6 ? 1 : 0));
  let largest = 0;
  const stack: number[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start]) continue;
    let size = 0;
    hot[start] = 0;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const x = k % gw, y = (k / gw) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const n = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && hot[n]) {
          hot[n] = 0;
          stack.push(n);
        }
      }
    }
    largest = Math.max(largest, size);
  }
  return { fraction: clipped / (w * h), largestBlob: largest / (gw * gh) };
}

export function hasGlare(r: GlareReport) {
  return r.largestBlob > 0.004;
}

/** Paints clipped pixels as red zebra stripes (for the camera viewfinder overlay). */
export function paintGlare(src: ImageData, out: ImageData, phase = 0) {
  const { width: w, data } = src;
  const o = out.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const glare = data[i] >= GLARE_LEVEL && data[i + 1] >= GLARE_LEVEL && data[i + 2] >= GLARE_LEVEL;
    const stripe = (((p % w) + ((p / w) | 0) + phase) & 8) !== 0;
    o[i] = 255;
    o[i + 1] = 0;
    o[i + 2] = 0;
    o[i + 3] = glare ? (stripe ? 200 : 90) : 0;
  }
}

/**
 * Lighting correction: estimates the paper brightness with a coarse max-filter and divides it out,
 * so shadows, gradients and the halo around glare become white paper with dark text.
 * Light-on-dark cards are inverted first so the same logic applies.
 */
export function flattenLighting(img: ImageData): ImageData {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  let mean = 0;
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    mean += lum[p];
  }
  mean /= lum.length;
  const invert = mean < 110;
  if (invert) for (let p = 0; p < lum.length; p++) lum[p] = 255 - lum[p];

  // Background estimate on a grid of blocks: brightest-ish value per block, then max + blur.
  const block = Math.max(8, Math.round(Math.max(w, h) / 80));
  const bw = Math.ceil(w / block), bh = Math.ceil(h / block);
  const bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y += 2) {
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x += 2) m = Math.max(m, lum[y * w + x]);
      }
      bg[by * bw + bx] = m;
    }
  }
  const smooth = (src: Float32Array, op: (a: number, b: number) => number, init: number, avg: boolean) => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = init, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            acc = op(acc, src[ny * bw + nx]);
            n++;
          }
        }
        dst[y * bw + x] = avg ? acc / n : acc;
      }
    }
    return dst;
  };
  let est = smooth(bg, Math.max, 0, false);
  est = smooth(smooth(est, (a, b) => a + b, 0, true), (a, b) => a + b, 0, true);

  const out = new ImageData(w, h);
  const o = out.data;
  for (let y = 0; y < h; y++) {
    // Bilinear sample of the block grid at pixel centres.
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = fy | 0, y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = fx | 0, x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b =
        (est[y0 * bw + x0] * (1 - tx) + est[y0 * bw + x1] * tx) * (1 - ty) +
        (est[y1 * bw + x0] * (1 - tx) + est[y1 * bw + x1] * tx) * ty;
      const v = Math.max(0, Math.min(255, (lum[y * w + x] / Math.max(b, 24)) * 255));
      const i = (y * w + x) * 4;
      o[i] = o[i + 1] = o[i + 2] = v;
      o[i + 3] = 255;
    }
  }
  return out;
}

export function toCanvas(img: ImageData): AnyCanvas {
  const c = makeCanvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}
