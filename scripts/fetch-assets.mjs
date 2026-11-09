// Downloads the models and the Piper phonemizer into public/, so the built app is fully self-hosted
// and never contacts a CDN at runtime.
// Usage: node scripts/fetch-assets.mjs [--skip-downloads]   (with it, only local files are copied)
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const catalog = JSON.parse(await readFile(join(root, 'models.json'), 'utf8'));
const skipDownloads = process.argv.includes('--skip-downloads');

async function copy(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log(`copied  ${to.slice(root.length + 1)}`);
}

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(url, to) {
  if (await exists(to)) {
    console.log(`cached  ${to.slice(root.length + 1)}`);
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  const tmp = `${to}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, to);
  console.log(`fetched ${to.slice(root.length + 1)}`);
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res;
}

/** Extracts the named entries of a zip archive (stored or deflated). */
function unzip(buf, wanted) {
  const out = new Map();
  // End of central directory record: last 22+ bytes, signature 0x06054b50.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const base = name.split('/').pop();
    if (wanted.includes(base)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out.set(base, method === 0 ? data : inflateRawSync(data));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// PaddleOCR: text detection + recognition models and the character dictionary.
{
  const { archive, det, rec, dict } = catalog.ocr;
  const files = [det, rec, dict];
  const targets = files.map((f) => join(pub, 'ocr', f));
  if ((await Promise.all(targets.map(exists))).every(Boolean)) {
    console.log('cached  public/ocr/*');
  } else {
    const res = await fetch(archive);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${archive}`);
    const entries = unzip(Buffer.from(await res.arrayBuffer()), files);
    await mkdir(join(pub, 'ocr'), { recursive: true });
    for (const f of files) {
      if (!entries.has(f)) throw new Error(`${f} missing from ${archive}`);
      await writeFile(join(pub, 'ocr', f), entries.get(f));
      console.log(`fetched public/ocr/${f}`);
    }
  }
}


// Piper phonemizer (piper-phonemize + eSpeak NG compiled to wasm), built from pinned sources by
// phonemizer/build.sh and published as release assets. A local build in phonemizer/dist/ is used if
// present; either way every file must match the SHA-256 in phonemizer/release.json. The emscripten
// glue is not an ES module, so an export is appended to make it importable from a module worker.
{
  const release = JSON.parse(await readFile(join(root, 'phonemizer/release.json'), 'utf8'));
  const local = join(root, 'phonemizer/dist');
  const useLocal = await exists(join(local, 'piper_phonemize.wasm'));
  if (skipDownloads && !useLocal) {
    console.log('skipping phonemizer download');
  } else {
    await mkdir(join(pub, 'piper'), { recursive: true });
    for (const [file, sha256] of Object.entries(release.files)) {
      const buf = useLocal
        ? await readFile(join(local, file))
        : Buffer.from(await (await fetchOk(release.url + file)).arrayBuffer());
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== sha256) {
        throw new Error(`${file} from ${useLocal ? 'phonemizer/dist' : release.url} has SHA-256 ${actual}, ` +
          `phonemizer/release.json expects ${sha256}`);
      }
      const out = file === 'piper_phonemize.js' ? 'piper_phonemize.mjs' : file;
      await writeFile(join(pub, 'piper', out),
        out === file ? buf : `${buf.toString('utf8')}\nexport default createPiperPhonemize;\n`);
      console.log(`${useLocal ? 'built  ' : 'fetched'} public/piper/${out}`);
    }
  }
}
// The phonemizer contains GPL-3.0-or-later eSpeak NG: serve the license and source pointers with it.
await mkdir(join(pub, 'piper'), { recursive: true });
await copy(join(root, 'licenses/GPL-3.0.txt'), join(pub, 'piper/COPYING'));
await copy(join(root, 'licenses/espeak-ng-SOURCE.txt'), join(pub, 'piper/SOURCE.txt'));

if (skipDownloads) {
  console.log('skipping model downloads');
} else {
  for (const m of catalog.translation) {
    for (const file of m.files) {
      await download(`https://huggingface.co/${m.repo}/resolve/main/${file}`, join(pub, 'models', m.repo, file));
    }
  }
  for (const v of catalog.piper) {
    for (const ext of ['onnx', 'onnx.json']) {
      await download(
        `https://huggingface.co/rhasspy/piper-voices/resolve/main/${v.path}.${ext}`,
        join(pub, 'piper/voices', `${v.id}.${ext}`),
      );
    }
  }
}
