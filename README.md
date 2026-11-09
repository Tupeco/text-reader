# Card Reader

A web app that reads board game cards (Mythwind, Stonesaga, …) aloud: take one or more photos, the text is
recognized **on the device**, optionally translated (English → Finnish by default), and spoken.
After the first load it works fully offline. No servers or cloud APIs are used. Every model runs in the
browser as WebAssembly.

| Step | Engine | Size |
|---|---|---|
| Text recognition | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 mobile (ONNX) via [esearch-ocr](https://github.com/xushengfeng/eSearch-OCR) | 21 MB, always cached |
| Translation | [Opus-MT en→fi](https://huggingface.co/Helsinki-NLP/opus-mt-en-fi) via [Transformers.js](https://github.com/huggingface/transformers.js) | 113 MB, optional download |
| Speech | The phone's own voices (Web Speech API), or [Piper](https://github.com/rhasspy/piper) `fi_FI-harri-medium` | 0 MB / 81 MB optional |
| Runtime | [onnxruntime-web](https://onnxruntime.ai/) (wasm, SIMD, threads), shared by all three | 14 MB |

## Using it

1. **📷 Camera** opens a viewfinder that stripes **glare** (blown-out highlights) in red. Tilt the card until
   the text is clear, then shoot. **🖼 Gallery** picks existing photos.
2. Each photo is read in order. Tap a thumbnail (✂) to crop or rotate it. Cropping to the rules text helps
   on busy cards.
3. A photo with glare gets **⚠ Glare: add another angle**. The extra shot is marked **Same card**. Words
   both shots read are used to map one photo onto the other, then words missing or glare-damaged in one shot
   are filled in from the other. You can also tick *Same card* on any photo manually.
4. Fix any OCR mistakes in the **Recognized** tab, then press **▶ Read aloud**. If you edit the text,
   **Translate again** appears.

**Settings** (⚙):
- Translation on or off, and the target language.
- Find-and-replace glossaries applied before and after translation. Use these for game terms that
  translate badly, e.g. `renown = maine`.
- The voice engine and voice, speech speed, and auto-read after a photo.
- Lighting correction (off by default; PP-OCRv6 handled uneven light just as well without it).
- **Offline downloads**: fetch the translation model and the Piper voice once on Wi-Fi.

### Voices

`Automatic` uses an **on-device** system voice for the language, falling back to Piper.
- **Android**: install *Finnish* voice data in *Settings → Text-to-speech → Speech Services by Google*.
- **iOS**: Finnish (Satu) is built in; enhanced versions can be downloaded under *Accessibility → Spoken Content*.
- **Desktop Chrome's "Google suomi"** voice is an online voice and won't work offline. Use Piper there.

## Development

```sh
npm install
npm run assets   # copy wasm runtimes, download OCR/translation/voice models into public/ (~230 MB)
npm run dev      # http://localhost:5173
npm test         # unit tests (text cleanup, glossary, layout, multi-shot merging)
npm run build    # production build in dist/
npm run preview  # serve dist/ with the service worker
```

`npm run assets -- --skip-downloads` only copies the runtimes from `node_modules`. Downloaded files are
gitignored and reused on later runs.

### Deploying

`dist/` is a static site. It must be served over **HTTPS** (needed for the camera and the service worker).

The service worker adds `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers itself, so the
app becomes cross-origin isolated (multi-threaded wasm) on any host, including GitHub Pages; the first visit
reloads once to activate it. Hosts that can set headers (see `public/_headers` for Netlify / Cloudflare
Pages) get isolation on the first load too.

For a sub-path (e.g. GitHub Pages project sites) build with `BASE_PATH=/repo-name/ npm run build`.

Some model files are larger than 25 MB, so Cloudflare Pages (25 MiB per-file limit) cannot host them.
Netlify, GitHub Pages, or any plain web server can.

### Adding languages

Edit `models.json` and re-run `npm run assets`:
- **Translation**: any `Xenova/opus-mt-en-XX` repository on Hugging Face (e.g. `opus-mt-en-sv`, `opus-mt-en-de`).
  Copy the `en-fi` entry and change `id`, `label`, `target` and `repo`.
- **Piper voices**: any voice from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices); `path` is
  the file path without extension.

### OCR benchmark

`bench/` renders synthetic card photos (a parchment texture, inline icons, rotation, blur, uneven lighting,
light-on-dark cards and specular glare) and measures character error rate per engine in headless Chromium:

```sh
npm run dev &
# engines: v6s, v6s-flat (with lighting correction), v6t (tiny; needs its model in public/bench-models)
# variants: clean, photo, rough, dark, glare, glare-heavy, merged (two glare shots merged)
npm run bench -- http://localhost:5173 v6s,v6s-flat /path/to/chromium photo,glare-heavy,merged
```

## Project layout

```
src/main.ts        UI and the photo → text → translation → speech flow
src/camera.ts      viewfinder with live glare overlay
src/crop.ts        crop / rotate dialog
src/image.ts       photo loading, glare detection, lighting correction
src/layout.ts      OCR boxes → reading-order rows and paragraphs (unit tested)
src/merge.ts       merging several shots of one card: anchor words → homography → word overlay (unit tested)
src/text.ts        OCR cleanup, glossary, sentence splitting (unit tested)
src/ml.worker.ts   OCR, translation and Piper inference on one shared onnxruntime instance
src/speech.ts      Web Speech API and Piper playback
src/offline.ts     service worker registration and optional downloads
src/sw.ts          service worker (precache, model cache, isolation headers)
models.json        which models to fetch and use
```

## License and credits

MIT, see [LICENSE](LICENSE). The models and runtimes the app downloads and serves have their own
licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Note that the optional Piper
phonemizer includes eSpeak NG, which is GPL-3.0-or-later.

### AI assistance

This project was written with [Claude Code](https://claude.com/claude-code), Anthropic's AI coding
assistant, which contributed to every commit. Commits from `71c3513` onward carry a
`Co-Authored-By: Claude …` trailer; the two earlier ones do not. The maintainer directs the work and is
responsible for what is merged.
