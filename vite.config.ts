import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Cross-origin isolation enables SharedArrayBuffer, i.e. multi-threaded wasm.
// In production the service worker adds these headers too (see src/sw.ts).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  resolve: {
    // Transformers.js imports the WebGPU build of onnxruntime, which needs a second 27 MB wasm binary.
    // Everything here runs on the plain wasm backend, so share one runtime.
    alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: 'onnxruntime-web/wasm' }],
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: {
        name: 'Card Reader',
        short_name: 'Card Reader',
        description: 'Photograph board game cards, read the text offline, translate it and hear it aloud.',
        theme_color: '#2d2417',
        background_color: '#f6f1e7',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      injectManifest: {
        // App shell, onnxruntime and the OCR models are cached at install so OCR always works offline.
        // Translation models and Piper voices (models/, piper/) are cached on first use instead.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest,wasm}', 'ocr/*'],
        globIgnores: ['models/**', 'piper/**', 'bench-models/**'],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
});
