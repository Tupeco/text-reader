/// <reference lib="webworker" />
// Offline support. The app shell and OCR models are precached at install; translation models
// and Piper voices are cached the first time they are fetched (or via "Download" in settings).
// Every response gets COOP/COEP headers so the page is cross-origin isolated on any static host,
// which lets onnxruntime use wasm threads.
import { addPlugins, cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import type { WorkboxPlugin } from 'workbox-core';
import { MODEL_CACHE } from './catalog';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

const isolate: WorkboxPlugin = {
  handlerWillRespond: async ({ response }) => {
    if (response.type === 'opaque' || response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

addPlugins([isolate]);
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
const scope = new URL(self.registration.scope).pathname;
// Opening piper/COPYING or piper/SOURCE.txt from the About section is a navigation; serve the file, not the app.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [new RegExp(`^${scope}piper/`)] }));
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && (url.pathname.startsWith(`${scope}models/`) || url.pathname.startsWith(`${scope}piper/`)),
  new CacheFirst({ cacheName: MODEL_CACHE, plugins: [new CacheableResponsePlugin({ statuses: [200] }), isolate] }),
);

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') void self.skipWaiting();
});

// The first install takes over immediately so the page can reload into an isolated context.
self.addEventListener('install', () => {
  if (!self.registration.active) void self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
