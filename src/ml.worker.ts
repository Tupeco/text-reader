// Hosts every model (OCR, translation, Piper TTS) in one worker so they share a single
// onnxruntime-web instance. Jobs run one at a time; ORT's wasm backend is not re-entrant.
// OCR stays loaded; the translator and the Piper voice are the big ones (hundreds of MB once
// loaded), so only one of them is kept at a time. wasm memory never shrinks, but memory freed by
// one model is reused by the next, so the peak is OCR + the larger of the two rather than all three.
import * as ort from 'onnxruntime-web/wasm';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortGlue from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { init as initPaddle } from 'esearch-ocr';
import { env, pipeline, type TranslationPipeline } from '@huggingface/transformers';
import { catalog, url, type PiperVoice, type TranslationModel } from './catalog';
import { flattenLighting } from './image';
import { fragmentsFromRaw, layoutRows, type RawLine } from './layout';
import type { OcrLine } from './text';
import type { Request, Response } from './ml';

// Both emitted by Vite as separate files (hashed, precached by the service worker). The JS glue must
// be its own file: ORT starts its thread pool as workers running the glue's URL, and if that were this
// bundle every thread would run this worker's code instead and never start.
ort.env.wasm.wasmPaths = { mjs: new URL(ortGlue, self.location.href).href, wasm: new URL(ortWasm, self.location.href).href };
// Threads need cross-origin isolation (COOP/COEP); without it ORT runs single-threaded.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

// Models are served from this origin and cached by the service worker, never fetched from a hub.
// Files are loaded through the "local" path. Before loading, Transformers.js 4.3 checks which files
// exist (and their sizes, for progress), but skips that check for local paths that are URLs. So
// "remote" points at the same origin: the check is answered by a one-byte Range request there.
// With remote disabled, every file looks missing and the translation pipeline gets no tokenizer.
// With a non-URL local path, the check becomes a full GET of each model file racing the real
// download, and the service worker's cache writes fail.
env.allowLocalModels = true;
env.localModelPath = url('models/');
env.allowRemoteModels = true;
env.remoteHost = url('models/');
env.remotePathTemplate = '{model}/';
env.useBrowserCache = false;
env.useWasmCache = false;

const post = (msg: Response, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function fetchProgress(path: string, id: number, label: string): Promise<ArrayBuffer> {
  const res = await fetch(url(path));
  if (!res.ok || !res.body) throw new Error(`Could not load ${path} (${res.status}). Is it downloaded?`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    post({ type: 'progress', id, label, loaded, total });
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) buf.set(c, (o += c.length) - c.length);
  return buf.buffer;
}

// ---- OCR (PaddleOCR via esearch-ocr) ----

type Paddle = Awaited<ReturnType<typeof initPaddle>>;
let paddle: Promise<Paddle> | undefined;

function loadPaddle(id: number) {
  paddle ??= (async () => {
    const m = catalog.ocr;
    const [det, rec, dict] = await Promise.all([
      fetchProgress(m.det, id, 'Loading text detector'),
      fetchProgress(m.rec, id, 'Loading text recognizer'),
      fetch(url(m.dict)).then((r) => r.text()),
    ]);
    return initPaddle({
      ort: ort as never,
      det: { input: new Uint8Array(det) },
      rec: { input: new Uint8Array(rec), decodeDic: dict, optimize: { space: m.optimizeSpace } },
    });
  })();
  paddle.catch(() => (paddle = undefined));
  return paddle;
}

async function ocr(id: number, image: ImageData, flatten: boolean): Promise<OcrLine[]> {
  const p = await loadPaddle(id);
  post({ type: 'progress', id, label: 'Reading text', loaded: 0, total: 0 });
  // Detection + raw recognition (per-character confidence); reading order is rebuilt in layout.ts
  // because glare can split a printed line into boxes that esearch's own layout treats as columns.
  const boxes = await p.det(flatten ? flattenLighting(image) : image);
  const raw = (await p.recRaw(boxes)) as unknown as RawLine[];
  return layoutRows(fragmentsFromRaw(raw));
}

// ---- Translation (Opus-MT via Transformers.js) ----

const translators = new Map<string, Promise<TranslationPipeline>>();

function loadTranslator(id: number, model: TranslationModel) {
  let t = translators.get(model.id);
  if (!t) {
    t = pipeline('translation', model.repo, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress') post({ type: 'progress', id, label: 'Loading translator', loaded: p.loaded, total: p.total });
      },
    }) as Promise<TranslationPipeline>;
    translators.set(model.id, t);
    t.catch(() => translators.delete(model.id));
  }
  return t;
}

async function translate(id: number, modelId: string, sentences: string[]): Promise<string[]> {
  const model = catalog.translation.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown translation model ${modelId}`);
  await unloadVoices();
  const t = await loadTranslator(id, model);
  const out: string[] = [];
  for (const [i, s] of sentences.entries()) {
    post({ type: 'progress', id, label: 'Translating', loaded: i, total: sentences.length });
    const [r] = (await t(s, { max_new_tokens: 256 })) as { translation_text: string }[];
    out.push(r.translation_text);
  }
  return out;
}

// ---- Piper TTS ----

type PiperConfig = {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  speaker_id_map: Record<string, number>;
};

type PhonemizeModule = { callMain(args: string[]): void };
type PhonemizeFactory = (opts: object) => Promise<PhonemizeModule>;

let phonemizer: Promise<{ factory: PhonemizeFactory; wasm: ArrayBuffer; data: ArrayBuffer }> | undefined;
const voices = new Map<string, Promise<{ config: PiperConfig; session: ort.InferenceSession }>>();

function loadPhonemizer(id: number) {
  phonemizer ??= (async () => {
    const [mod, wasm, data] = await Promise.all([
      import(/* @vite-ignore */ url('piper/piper_phonemize.mjs')),
      fetchProgress('piper/piper_phonemize.wasm', id, 'Loading phonemizer'),
      fetchProgress('piper/piper_phonemize.data', id, 'Loading phonemizer'),
    ]);
    return { factory: mod.default as PhonemizeFactory, wasm, data };
  })();
  phonemizer.catch(() => (phonemizer = undefined));
  return phonemizer;
}

function loadVoice(id: number, voice: PiperVoice) {
  let v = voices.get(voice.id);
  if (!v) {
    v = (async () => {
      const config = (await (await fetch(url(`piper/voices/${voice.id}.onnx.json`))).json()) as PiperConfig;
      const model = await fetchProgress(`piper/voices/${voice.id}.onnx`, id, 'Loading voice');
      const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      return { config, session };
    })();
    voices.set(voice.id, v);
    v.catch(() => voices.delete(voice.id));
  }
  return v;
}

async function phonemize(id: number, text: string, espeakVoice: string): Promise<number[]> {
  const { factory, wasm, data } = await loadPhonemizer(id);
  return new Promise((resolve, reject) => {
    // The emscripten program exits after one run, so a fresh instance is created per call;
    // the wasm and espeak data are handed over from memory instead of being fetched again.
    factory({
      wasmBinary: wasm,
      getPreloadedPackage: () => data.slice(0),
      print: (out: string) => resolve(JSON.parse(out).phoneme_ids),
      printErr: (msg: string) => reject(new Error(msg)),
      locateFile: (f: string) => url(`piper/${f}`),
    })
      .then((m) => m.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']))
      .catch(reject);
  });
}

async function speakPiper(id: number, voiceId: string, text: string, rate: number) {
  const voice = catalog.piper.find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown voice ${voiceId}`);
  await unloadTranslators();
  const { config, session } = await loadVoice(id, voice);
  const ids = await phonemize(id, text, config.espeak.voice);
  const { noise_scale, length_scale, noise_w } = config.inference;
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
    scales: new ort.Tensor('float32', Float32Array.from([noise_scale, length_scale / rate, noise_w])),
  };
  if (Object.keys(config.speaker_id_map ?? {}).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]));
  const { output } = await session.run(feeds);
  return { pcm: output.data as Float32Array, sampleRate: config.audio.sample_rate };
}

// ---- unloading ----

async function unloadTranslators() {
  const all = [...translators.values()];
  translators.clear();
  for (const t of all) await (await t.catch(() => undefined))?.dispose();
}

async function unloadVoices() {
  const all = [...voices.values()];
  voices.clear();
  // The phonemizer keeps the 18 MB espeak data in memory.
  phonemizer = undefined;
  for (const v of all) await (await v.catch(() => undefined))?.session.release();
}

self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data;
  serial(async () => {
    try {
      switch (req.type) {
        case 'ocr':
          post({ type: 'result', id: req.id, value: await ocr(req.id, req.image, req.flatten) });
          break;
        case 'translate':
          post({ type: 'result', id: req.id, value: await translate(req.id, req.model, req.sentences) });
          break;
        case 'piper': {
          const { pcm, sampleRate } = await speakPiper(req.id, req.voice, req.text, req.rate);
          post({ type: 'result', id: req.id, value: { pcm, sampleRate } }, [pcm.buffer]);
          break;
        }
        case 'warmup':
          if (req.what === 'ocr') await loadPaddle(req.id);
          post({ type: 'result', id: req.id, value: null });
          break;
      }
    } catch (err) {
      post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  });
};
