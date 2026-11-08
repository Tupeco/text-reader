// Model catalog shared by the app and scripts/fetch-assets.mjs (via models.json).
import models from '../models.json';

export type TranslationModel = (typeof models.translation)[number];
export type PiperVoice = (typeof models.piper)[number];

export const catalog = {
  ocr: {
    det: `ocr/${models.ocr.det}`,
    rec: `ocr/${models.ocr.rec}`,
    dict: `ocr/${models.ocr.dict}`,
    optimizeSpace: models.ocr.optimizeSpace,
  },
  translation: models.translation,
  piper: models.piper,
};

/** Resolves a path against the app's base URL (works on the main thread and in workers). */
export function url(path: string) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, self.location.origin).href;
}

/** Service worker cache holding the on-demand downloads. */
export const MODEL_CACHE = 'models-v1';

export type Pack = { id: string; label: string; files: string[] };

/** Optional downloads, cached on demand by the service worker (see sw.ts). */
export function packs(): Pack[] {
  return [
    ...models.translation.map((m) => ({
      id: `translation:${m.id}`,
      label: `Translation ${m.source} → ${m.target} (${m.label})`,
      files: m.files.map((f) => `models/${m.repo}/${f}`),
    })),
    ...models.piper.map((v) => ({
      id: `piper:${v.id}`,
      label: `Voice: ${v.label}`,
      files: [
        'piper/piper_phonemize.mjs',
        'piper/piper_phonemize.wasm',
        'piper/piper_phonemize.data',
        `piper/voices/${v.id}.onnx`,
        `piper/voices/${v.id}.onnx.json`,
      ],
    })),
  ];
}
