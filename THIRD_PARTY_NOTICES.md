# Third-party notices

This repository's own code is under the MIT license (see `LICENSE`). The repository itself contains no
model files or wasm runtimes. `npm run assets` downloads or copies them into `public/`, and a built
`dist/` serves them to users. Anyone deploying the app redistributes the components below and must
follow their licenses.

Licenses were taken from each project's page or package metadata on 2026-11-09. Where a license is
marked *not stated*, no license was found for that exact artifact; check upstream before redistributing.

## Models

| Component | Source | License |
|---|---|---|
| PaddleOCR PP-OCRv6 small (detection + recognition ONNX, `dic.txt`) | [eSearch-OCR release 4.0.0](https://github.com/xushengfeng/eSearch-OCR/releases/tag/4.0.0), converted from [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | eSearch-OCR: Apache-2.0. PaddleOCR: Apache-2.0. The converted model files: not stated |
| Opus-MT en→fi | [Helsinki-NLP/opus-mt-en-fi](https://huggingface.co/Helsinki-NLP/opus-mt-en-fi) by the University of Helsinki [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) project; ONNX conversion [Xenova/opus-mt-en-fi](https://huggingface.co/Xenova/opus-mt-en-fi) | Base model: Apache-2.0. ONNX conversion: not stated |
| Piper voice `fi_FI-harri-medium` | [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) | Repository: MIT. Training data: [Finnish single speaker speech dataset](https://www.kaggle.com/bryanpark/finnish-single-speaker-speech-dataset), CC0 |

## Runtimes and libraries

| Component | License |
|---|---|
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) (bundled wasm runtime) | MIT |
| [Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Apache-2.0 |
| [esearch-ocr](https://github.com/xushengfeng/eSearch-OCR) | Apache-2.0 |
| [piper-phonemize](https://github.com/rhasspy/piper-phonemize) | MIT |
| [piper-wasm](https://github.com/diffusionstudio/piper-wasm) build (`@diffusionstudio/piper-wasm`, source of `piper_phonemize.wasm` / `.data`) | Package metadata: MIT; repository: not stated |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng), compiled into `piper_phonemize.wasm`, with `espeak-ng-data` packed into `piper_phonemize.data` | GPL-3.0-or-later |
| [Workbox](https://github.com/GoogleChrome/workbox) (bundled into the service worker) | MIT |

### Note on eSpeak NG

The Piper phonemizer includes eSpeak NG, which is GPL-3.0-or-later. A deployment that serves
`piper/piper_phonemize.wasm` and `.data` distributes GPL-covered files, so those files come with the
GPL's terms (including making their corresponding source available). The rest of the app loads them at
runtime as separate files and does not link them into its own bundle. OCR, translation and system-voice
speech work without them.
