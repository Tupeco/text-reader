// Service worker registration, cross-origin isolation and optional model downloads.
import { MODEL_CACHE, packs, url, type Pack } from './catalog';

const RELOADED = 'card-reader:isolation-reload';

/**
 * Registers the service worker (production builds only). On the very first visit the page is not
 * yet controlled, so it isn't cross-origin isolated; reload once when the worker takes over.
 */
export async function registerServiceWorker(onUpdate: (apply: () => void) => void) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register(url('sw.js'), { scope: import.meta.env.BASE_URL });
  const reloadForIsolation = () => {
    if (!self.crossOriginIsolated && !sessionStorage.getItem(RELOADED)) {
      sessionStorage.setItem(RELOADED, '1');
      location.reload();
    }
  };
  if (navigator.serviceWorker.controller) reloadForIsolation();
  else navigator.serviceWorker.addEventListener('controllerchange', reloadForIsolation, { once: true });

  const offerUpdate = (w: ServiceWorker) =>
    onUpdate(() => {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      w.postMessage('SKIP_WAITING');
    });
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
    });
  });
  // Ask the browser not to evict cached models under storage pressure.
  void navigator.storage?.persist?.();
}

export type PackStatus = { pack: Pack; cached: number; total: number };

export async function packStatus(): Promise<PackStatus[]> {
  const cache = 'caches' in self ? await caches.open(MODEL_CACHE) : undefined;
  return Promise.all(
    packs().map(async (pack) => {
      let cached = 0;
      for (const f of pack.files) if (await cache?.match(url(f))) cached++;
      return { pack, cached, total: pack.files.length };
    }),
  );
}

export function isReady(s: PackStatus) {
  return s.cached === s.total;
}

/** Fetches every file of a pack through the service worker, which stores it. */
export async function downloadPack(pack: Pack, onProgress: (fraction: number) => void) {
  if (!navigator.serviceWorker?.controller) throw new Error('Offline support is not active yet; reload the page and try again.');
  const sizes = await Promise.all(
    pack.files.map(async (f) => Number((await fetch(url(f), { method: 'HEAD' })).headers.get('Content-Length')) || 0),
  );
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  let loaded = 0;
  for (const f of pack.files) {
    const res = await fetch(url(f));
    if (!res.ok || !res.body) throw new Error(`Download failed: ${f} (${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      onProgress(Math.min(1, loaded / total));
    }
  }
}

export async function removePack(pack: Pack) {
  const cache = await caches.open(MODEL_CACHE);
  // The phonemizer is shared between voices; keep it while another downloaded voice needs it.
  const others = (await packStatus()).filter((s) => s.pack.id !== pack.id && s.cached > 0).flatMap((s) => s.pack.files);
  for (const f of pack.files) if (!others.includes(f)) await cache.delete(url(f));
}

export async function storageEstimate() {
  const e = await navigator.storage?.estimate?.();
  return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : undefined;
}
