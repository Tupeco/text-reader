// Main-thread client for ml.worker.ts.
import type { OcrLine } from './text';

export type Request =
  | { type: 'ocr'; id: number; image: ImageData; flatten: boolean }
  | { type: 'translate'; id: number; model: string; sentences: string[] }
  | { type: 'piper'; id: number; voice: string; text: string; rate: number }
  | { type: 'warmup'; id: number; what: 'ocr' }
  | { type: 'config'; id: number; keepModelsLoaded: boolean };

export type Response =
  | { type: 'progress'; id: number; label: string; loaded: number; total: number }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string };

export type Progress = (label: string, fraction: number | null) => void;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: Progress };

let worker: Worker | undefined;
let nextId = 1;
/** Sent to every new worker, so a worker restarted after a crash gets the same settings. */
let config = { keepModelsLoaded: true };
const pending = new Map<number, Pending>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./ml.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Response>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.onProgress?.(msg.label, msg.total ? msg.loaded / msg.total : null);
      else {
        pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.value);
        else p.reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      // A crashed worker (e.g. out of memory) fails everything in flight; the next call starts a new one.
      for (const p of pending.values()) p.reject(new Error(e.message || 'Model worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
    // Id 0 is never pending, so the reply is ignored. Messages are handled in order.
    worker.postMessage({ type: 'config', id: 0, ...config } satisfies Request);
  }
  return worker;
}

type Body<T> = T extends unknown ? Omit<T, 'id'> : never;

function call<T>(req: Body<Request>, onProgress?: Progress, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage({ ...req, id }, transfer);
  });
}

export function recognize(image: ImageData, flatten: boolean, onProgress?: Progress) {
  return call<OcrLine[]>({ type: 'ocr', image, flatten }, onProgress);
}

export function translateSentences(model: string, sentences: string[], onProgress?: Progress) {
  return call<string[]>({ type: 'translate', model, sentences }, onProgress);
}

export function synthesize(voice: string, text: string, rate: number, onProgress?: Progress) {
  return call<{ pcm: Float32Array; sampleRate: number }>({ type: 'piper', voice, text, rate }, onProgress);
}

/** Keep the translator and the Piper voice loaded together (faster, more memory). */
export function setKeepModelsLoaded(keepModelsLoaded: boolean) {
  config = { keepModelsLoaded };
  if (worker) worker.postMessage({ type: 'config', id: 0, ...config } satisfies Request);
}

export function warmupOcr() {
  return call<null>({ type: 'warmup', what: 'ocr' });
}
