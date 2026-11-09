# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Card Reader is an offline PWA. It photographs board game cards, then OCRs, translates (en→fi by default)
and speaks the text, with every model running in the browser as WebAssembly. README.md covers usage,
deployment and how to add languages.

## Commands

```sh
npm run assets            # copy wasm runtimes + download models into public/ (~230 MB, gitignored, reused)
npm run assets -- --skip-downloads   # no downloads (still uses a local phonemizer/dist/ build)
phonemizer/build.sh       # rebuild the Piper phonemizer wasm in Docker from pinned commits (see README)
npm run dev               # http://localhost:5173 (sends COOP/COEP headers itself)
npm test                  # vitest unit tests (src/*.test.ts)
npx vitest run src/merge.test.ts     # one test file; add -t "<name>" for a single test
npm run build             # tsc (type check, no emit) + vite build into dist/
npm run preview           # serve dist/ with the service worker on :4173
docker compose up -d --build   # production image (nginx, deploy/), host port from .env HOST_PORT (8477)
./test/run-e2e.sh         # full e2e from a fresh checkout: npm ci, assets, unit tests, build, preview, Playwright
```

There is no linter. `tsc` with `strict`, `noUnusedLocals` and `noUnusedParameters` is the check (it also
runs in `npm run build`).

`test/e2e.mjs` drives the **production build** in headless Chromium. It generates card photos and tests
OCR, translation, Piper speech, multi-shot glare merging, and offline use from the SW cache. To run it
against an already-running preview: `node test/e2e.mjs http://localhost:4173 [chromium-path]`. Set
`E2E_UNTIL=ocr` to stop after OCR. `run-e2e.sh` refuses to start if port 4173 is already in use. The e2e
test is the only test that exercises the worker, model loading and the service worker; unit tests cover
only the pure modules (`text`, `layout`, `merge`).

`npm run bench` (see README) measures OCR character error rate across engines/variants on synthetic photos.

## Architecture

**One ML worker, one ORT instance.** `src/ml.worker.ts` hosts OCR (esearch-ocr / PaddleOCR), translation
(Transformers.js Opus-MT) and Piper TTS on a single `onnxruntime-web` wasm instance. `src/ml.ts` is the
main-thread RPC client (id-tagged request/progress/result messages; a crashed worker is replaced on the
next call). Points to know:
- Jobs run one at a time through `serial()`. ORT's wasm backend is not re-entrant.
- `vite.config.ts` aliases `onnxruntime-web/webgpu` → `onnxruntime-web/wasm` so Transformers.js shares the
  same runtime instead of pulling a second 27 MB binary.
- ORT's JS glue (`ort-wasm-simd-threaded.mjs`) must be emitted as its own file and passed through
  `ort.env.wasm.wasmPaths`. ORT starts its threads by loading that URL; if it pointed at the worker
  bundle, the threads would never start.
- Memory: OCR stays resident. Only one of the translator and the Piper voice/phonemizer is kept loaded at
  a time (`unloadTranslators`/`unloadVoices`), because all three together pushed the page past 1 GB.
- Transformers.js env: models load from this origin's `models/` folder through the "local" path, and
  "remote" is also pointed at the same folder (`remoteHost = url('models/')`). Don't set
  `allowRemoteModels = false` or turn `localModelPath` into a plain path. The comment in the worker
  explains how each one breaks translation (missing tokenizer / duplicate full downloads that make the
  service worker's cache writes fail).

**Cross-origin isolation is required for wasm threads.** The dev and preview servers send COOP/COEP
headers. In production the service worker (`src/sw.ts`) adds them to every response it serves, so any
static host works. The first visit reloads once to become isolated.

**Service worker / offline** (`src/sw.ts`, Workbox `injectManifest` via vite-plugin-pwa):
- The app shell, onnxruntime and the OCR models (`public/ocr/`) are precached at install.
- Translation models (`public/models/`) and Piper files (`public/piper/`) are cached on first use in
  `MODEL_CACHE` with CacheFirst, or ahead of time via "Offline downloads" in settings (`src/offline.ts`).
- The precache glob in `vite.config.ts` must keep excluding `models/**` and `piper/**`.
- Any server for `dist/` (the Docker image uses `deploy/nginx.conf`) must return real 404s for missing
  files, never `index.html`, and must answer Range requests under `models/` and `piper/` with 206. With
  gzip, nginx ignores Range, and the full response then races the real download in the service worker
  cache.

**Model catalog.** `models.json` is the single source of truth for which models exist. It is read by
`scripts/fetch-assets.mjs` (downloads) and `src/catalog.ts` (app; also builds the offline-download
"packs"). A translation entry's `files` list must contain every file Transformers.js will load, or
offline use breaks. Always build asset paths with `url()` from `catalog.ts`. It resolves against
`BASE_URL`, which is set by `BASE_PATH` for sub-path deploys, and works in both the window and workers.

**GPL boundary.** The Piper phonemizer (`piper/piper_phonemize.*`, built by `phonemizer/`) contains
GPL-3.0-or-later eSpeak NG. The MIT app keeps it a separate program: it is loaded at runtime from its own
files, started per call with command-line arguments, and only its output is read. Don't bundle it into the
app's JS or call into it more closely without discussing licensing (see THIRD_PARTY_NOTICES.md).

**Text pipeline** (main thread, `src/main.ts` orchestrates):
- photo → `image.ts` (loading, glare detection, optional lighting flattening) → worker OCR
- → `layout.ts` (OCR boxes → reading-order rows/paragraphs)
- → for multiple shots of one card, `merge.ts` (anchor words → homography → fill in words missing or
  damaged by glare)
- → `text.ts` (cleanup, glossary find/replace before/after translation, sentence splitting)
- → worker translation → `speech.ts` (Web Speech API voice, or Piper PCM from the worker)

Settings are stored per device in localStorage (`src/settings.ts`).
