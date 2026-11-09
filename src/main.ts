import './style.css';
import { cameraSupported, takePhoto } from './camera';
import { catalog } from './catalog';
import { editPhoto, type Edit } from './crop';
import { detectGlare, hasGlare, loadPhoto, toCanvas, transform, type GlareReport } from './image';
import { recognize, setKeepModelsLoaded, translateSentences, warmupOcr } from './ml';
import { downloadPack, isReady, packStatus, registerServiceWorker, removePack, storageEstimate } from './offline';
import { load, save, type Settings } from './settings';
import * as speech from './speech';
import { mergeShots } from './merge';
import { applyGlossary, cleanOcrText, linesToText, parseGlossary, splitSentences, type OcrLine } from './text';

type Photo = {
  id: number;
  image: ImageData;
  edit: Edit;
  thumb: string;
  glare: GlareReport;
  /** Another shot of the same card as the previous photo; their lines are merged. */
  sameCard: boolean;
  lines?: OcrLine[];
  state: 'waiting' | 'reading' | 'done' | 'error';
  error?: string;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let settings = load();
setKeepModelsLoaded(settings.keepModelsLoaded);
let photos: Photo[] = [];
let nextPhotoId = 1;
/** Text the current translation was made from; a mismatch means it is stale. */
let translatedFrom = '';
let sourceEdited = false;
let speaking = false;
let busy = 0;

const ui = {
  empty: $('#empty'),
  photos: $('#photos'),
  texts: $('#texts'),
  source: $<HTMLTextAreaElement>('#source'),
  target: $<HTMLTextAreaElement>('#target'),
  tabSource: $('#tab-source'),
  tabTarget: $('#tab-target'),
  retranslate: $('#retranslate'),
  status: $('#status'),
  statusText: $('#status-text'),
  statusProgress: $<HTMLProgressElement>('#status-progress'),
  speak: $<HTMLButtonElement>('#speak'),
  settings: $<HTMLDialogElement>('#settings'),
  crop: $<HTMLDialogElement>('#crop-dialog'),
};

// ---- status ----

function showStatus(text: string, fraction: number | null = null) {
  ui.status.hidden = false;
  ui.status.classList.remove('error');
  ui.statusText.textContent = text;
  if (fraction === null) ui.statusProgress.removeAttribute('value');
  else ui.statusProgress.value = fraction;
  ui.statusProgress.hidden = false;
}

function showError(err: unknown) {
  console.error(err);
  ui.status.hidden = false;
  ui.status.classList.add('error');
  ui.statusText.textContent = err instanceof Error ? err.message : String(err);
  ui.statusProgress.hidden = true;
}

function clearStatus() {
  if (!ui.status.classList.contains('error')) ui.status.hidden = true;
}

async function task<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy++;
  try {
    return await fn();
  } catch (err) {
    showError(err);
    return undefined;
  } finally {
    busy--;
    if (!busy) clearStatus();
    renderButtons();
  }
}

// ---- photos ----

function thumbnail(img: ImageData) {
  const s = 160 / Math.max(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext('2d')!.drawImage(toCanvas(img) as CanvasImageSource, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function prepared(p: Photo) {
  return transform(p.image, p.edit.rotation, p.edit.crop);
}

/** Adds photos at `at` (default: the end). With `sameCard`, the first one is merged with the photo before it. */
async function addPhotos(blobs: Blob[], sameCard = false, at = photos.length) {
  ui.status.classList.remove('error');
  for (const [i, blob] of blobs.entries()) {
    showStatus('Opening photo…');
    const image = await loadPhoto(blob);
    photos.splice(at + i, 0, {
      id: nextPhotoId++,
      image,
      edit: { rotation: 0 },
      thumb: thumbnail(image),
      glare: detectGlare(image),
      sameCard: sameCard && i === 0 && at > 0,
      state: 'waiting',
    });
  }
  if (at < photos.length - blobs.length) sourceEdited = false;
  renderPhotos();
  await processPhotos();
}

function renderPhotos() {
  ui.empty.hidden = photos.length > 0;
  ui.photos.replaceChildren(
    ...photos.map((p, index) => {
      const card = document.createElement('article');
      card.className = `photo ${p.state}${p.sameCard ? ' same' : ''}`;

      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = `Photo ${index + 1}`;
      img.addEventListener('click', () => void edit(p));

      const info = document.createElement('div');
      info.className = 'photo-info';
      const title = document.createElement('strong');
      title.textContent = `Photo ${index + 1}`;
      const state = document.createElement('span');
      state.className = 'muted';
      state.textContent = { waiting: 'Waiting…', reading: 'Reading…', done: `${p.lines?.length ?? 0} lines`, error: p.error ?? 'Failed' }[p.state];
      info.append(title, state);

      if (hasGlare(p.glare)) {
        const warn = document.createElement('button');
        warn.type = 'button';
        warn.className = 'chip warn';
        warn.textContent = '⚠ Glare — add another angle';
        warn.title = 'Take another photo of this card from a different angle; the two are merged line by line.';
        warn.addEventListener('click', () => void capture(p));
        info.append(warn);
      }

      const tools = document.createElement('div');
      tools.className = 'photo-tools';
      if (index > 0) {
        const same = document.createElement('label');
        same.className = 'switch small';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = p.sameCard;
        cb.addEventListener('change', () => {
          p.sameCard = cb.checked;
          sourceEdited = false;
          renderPhotos();
          void rebuildText();
        });
        same.append(cb, ' Same card');
        tools.append(same);
      }
      const editBtn = button('✂', 'Crop or rotate', () => void edit(p));
      const del = button('🗑', 'Remove photo', () => {
        photos = photos.filter((x) => x !== p);
        if (photos[0]) photos[0].sameCard = false;
        sourceEdited = false;
        renderPhotos();
        void rebuildText();
      });
      tools.append(editBtn, del);

      card.append(img, info, tools);
      return card;
    }),
  );
}

function button(label: string, aria: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.title = aria;
  b.addEventListener('click', onClick);
  return b;
}

async function edit(p: Photo) {
  const result = await editPhoto(ui.crop, p.image, p.edit);
  if (!result) return;
  p.edit = result;
  const img = prepared(p);
  p.thumb = thumbnail(img);
  p.glare = detectGlare(img);
  p.lines = undefined;
  p.state = 'waiting';
  sourceEdited = false;
  renderPhotos();
  await processPhotos();
}

let processing: Promise<void> | undefined;

/** OCRs every photo that hasn't been read yet, then rebuilds and (optionally) translates the text. */
function processPhotos(): Promise<void> {
  processing = (processing ?? Promise.resolve()).then(() =>
    task(async () => {
      for (const p of photos) {
        // Failed photos are retried after they are edited (crop/rotate resets their state).
        if (p.lines || p.state === 'error') continue;
        p.state = 'reading';
        renderPhotos();
        try {
          const n = photos.indexOf(p) + 1;
          p.lines = await recognize(prepared(p), settings.flattenLighting, (label, f) => showStatus(`${label} (photo ${n})`, f));
          p.state = 'done';
        } catch (err) {
          p.state = 'error';
          p.error = err instanceof Error ? err.message : String(err);
          showError(err);
        } finally {
          renderPhotos();
        }
      }
      await rebuildText();
      if (settings.autoSpeak && ui.source.value.trim()) await readAloud();
    }).then(() => undefined),
  );
  return processing;
}

/** Groups "same card" shots, merges their lines, and fills in the recognized text. */
async function rebuildText() {
  const groups: Photo[][] = [];
  for (const p of photos) {
    if (!p.lines) continue;
    if (p.sameCard && groups.length) groups[groups.length - 1].push(p);
    else groups.push([p]);
  }
  const text = groups.map((g) => cleanOcrText(linesToText(mergeShots(g.map((p) => p.lines!))))).filter(Boolean).join('\n\n');
  if (sourceEdited && ui.source.value.trim()) {
    // Keep the user's corrections; only append text that isn't there yet.
    const extra = text.split('\n\n').filter((para) => !ui.source.value.includes(para));
    if (extra.length) ui.source.value = `${ui.source.value.trim()}\n\n${extra.join('\n\n')}`;
  } else {
    ui.source.value = text;
  }
  ui.texts.hidden = !photos.length;
  renderButtons();
  if (settings.translate && ui.source.value.trim()) await translate();
}

// ---- translation ----

function currentModel() {
  return catalog.translation.find((m) => m.id === settings.model) ?? catalog.translation[0];
}

async function translate() {
  const source = ui.source.value.trim();
  if (!source) return;
  const model = currentModel();
  const prepared = applyGlossary(source, parseGlossary(settings.glossaryBefore));
  const paragraphs = splitSentences(prepared);
  const flat = paragraphs.flat();
  const out = await translateSentences(model.id, flat, (label, f) => showStatus(label, f));
  let k = 0;
  const translated = paragraphs.map((p) => p.map(() => out[k++]).join(' ')).join('\n\n');
  ui.target.value = applyGlossary(translated, parseGlossary(settings.glossaryAfter));
  translatedFrom = ui.source.value.trim();
  showTab('target');
  renderButtons();
}

function showTab(which: 'source' | 'target') {
  const target = which === 'target' && settings.translate;
  ui.source.hidden = target;
  ui.target.hidden = !target;
  ui.tabSource.setAttribute('aria-selected', String(!target));
  ui.tabTarget.setAttribute('aria-selected', String(target));
}

// ---- speech ----

function speechLang() {
  return settings.translate ? currentModel().target : settings.sourceLang;
}

async function readAloud() {
  if (settings.translate && ui.source.value.trim() !== translatedFrom) await translate();
  const text = (settings.translate ? ui.target : ui.source).value;
  const sentences = splitSentences(text).flat();
  if (!sentences.length) return;
  const lang = speechLang();
  speaking = true;
  renderButtons();
  try {
    await speech.speak(sentences, {
      lang,
      engine: settings.voiceEngine,
      systemVoice: settings.systemVoices[lang],
      rate: settings.rate,
      onProgress: (label, f) => showStatus(label, f),
      onSentence: (i) => (i >= 0 ? showStatus(`Reading ${i + 1} / ${sentences.length}`, (i + 1) / sentences.length) : clearStatus()),
    });
  } finally {
    speaking = false;
    renderButtons();
  }
}

function renderButtons() {
  const hasText = !!(settings.translate ? ui.target.value || ui.source.value : ui.source.value).trim();
  ui.speak.disabled = !speaking && !hasText;
  ui.speak.firstChild!.textContent = speaking ? '■' : '▶';
  ui.speak.querySelector('span')!.textContent = speaking ? 'Stop' : 'Read aloud';
  ui.tabTarget.hidden = !settings.translate;
  ui.retranslate.hidden = !settings.translate || !ui.source.value.trim() || ui.source.value.trim() === translatedFrom;
}

// ---- capture ----

/** Opens the camera; `after` adds the shot as another angle of that photo's card. */
async function capture(after?: Photo) {
  speech.unlockAudio();
  pendingAfter = after;
  if (cameraSupported()) {
    try {
      const blob = await takePhoto(document.body);
      if (blob) await addCaptured([blob]);
      return;
    } catch (err) {
      // Camera permission denied or no camera: fall back to the system camera app.
      console.warn(err);
    }
  }
  $<HTMLInputElement>('#capture').click();
}

let pendingAfter: Photo | undefined;

function addCaptured(blobs: Blob[]) {
  const after = pendingAfter && photos.includes(pendingAfter) ? pendingAfter : undefined;
  pendingAfter = undefined;
  return after ? addPhotos(blobs, true, photos.indexOf(after) + 1) : addPhotos(blobs);
}

$('#camera').addEventListener('click', () => void capture());
$<HTMLInputElement>('#capture').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length) void addCaptured(files);
});
$<HTMLInputElement>('#gallery').addEventListener('change', (e) => {
  speech.unlockAudio();
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length) void addPhotos(files);
});

ui.speak.addEventListener('click', () => {
  speech.unlockAudio();
  if (speaking) {
    speech.stop();
    speaking = false;
    clearStatus();
    renderButtons();
  } else void task(readAloud);
});

ui.source.addEventListener('input', () => {
  sourceEdited = true;
  renderButtons();
});
ui.target.addEventListener('input', renderButtons);
ui.tabSource.addEventListener('click', () => showTab('source'));
ui.tabTarget.addEventListener('click', () => showTab('target'));
ui.retranslate.addEventListener('click', () => void task(translate));

// ---- settings ----

const form = ui.settings.querySelector('form')!;
const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T;

async function fillVoices() {
  const select = field<HTMLSelectElement>('systemVoice');
  const lang = speechLang();
  const voices = await speech.voicesFor(lang);
  select.replaceChildren(new Option('Default', ''), ...voices.map((v) => new Option(`${v.name}${v.localService ? '' : ' (online)'}`, v.voiceURI)));
  select.value = settings.systemVoices[lang] ?? '';
  const piper = speech.piperVoiceFor(lang);
  const note = $('#voice-note');
  const offline = voices.some((v) => v.localService);
  note.textContent = offline
    ? ''
    : `This device has no offline voice for "${lang}".${piper ? ' Use Piper (download it below), or install one in the phone’s text-to-speech settings.' : ''}`;
}

async function renderPacks() {
  const box = $('#packs');
  const statuses = await packStatus();
  box.replaceChildren(
    ...statuses.map((s) => {
      const row = document.createElement('div');
      row.className = 'pack';
      const label = document.createElement('span');
      label.textContent = `${s.pack.label} — ${isReady(s) ? 'ready offline' : s.cached ? 'partly downloaded' : 'not downloaded'}`;
      const progress = document.createElement('progress');
      progress.hidden = true;
      const act = document.createElement('button');
      act.type = 'button';
      act.textContent = isReady(s) ? 'Remove' : 'Download';
      act.addEventListener('click', async () => {
        act.disabled = true;
        try {
          if (isReady(s)) await removePack(s.pack);
          else {
            progress.hidden = false;
            await downloadPack(s.pack, (f) => (progress.value = f));
          }
        } catch (err) {
          label.textContent = err instanceof Error ? err.message : String(err);
          return;
        } finally {
          act.disabled = false;
        }
        await renderPacks();
      });
      row.append(label, act, progress);
      return row;
    }),
  );
  const est = await storageEstimate();
  const iso = self.crossOriginIsolated ? 'multi-threaded' : 'single-threaded';
  $('#storage').textContent = `${est ? `Using ${(est.usage / 1e6).toFixed(0)} MB of storage. ` : ''}Models run ${iso}.`;
}

function openSettings() {
  field<HTMLInputElement>('translate').checked = settings.translate;
  const model = field<HTMLSelectElement>('model');
  model.replaceChildren(...catalog.translation.map((m) => new Option(`${m.label} (${m.source} → ${m.target})`, m.id)));
  model.value = currentModel().id;
  field<HTMLTextAreaElement>('glossaryBefore').value = settings.glossaryBefore;
  field<HTMLTextAreaElement>('glossaryAfter').value = settings.glossaryAfter;
  field<HTMLSelectElement>('voiceEngine').value = settings.voiceEngine;
  field<HTMLInputElement>('rate').value = String(settings.rate);
  field<HTMLInputElement>('autoSpeak').checked = settings.autoSpeak;
  field<HTMLInputElement>('flattenLighting').checked = settings.flattenLighting;
  field<HTMLInputElement>('keepModelsLoaded').checked = settings.keepModelsLoaded;
  void fillVoices();
  void renderPacks();
  ui.settings.showModal();
}

function readSettings(): Settings {
  const lang = settings.translate ? currentModel().target : settings.sourceLang;
  const next: Settings = {
    ...settings,
    translate: field<HTMLInputElement>('translate').checked,
    model: field<HTMLSelectElement>('model').value,
    glossaryBefore: field<HTMLTextAreaElement>('glossaryBefore').value,
    glossaryAfter: field<HTMLTextAreaElement>('glossaryAfter').value,
    voiceEngine: field<HTMLSelectElement>('voiceEngine').value as Settings['voiceEngine'],
    rate: Number(field<HTMLInputElement>('rate').value),
    autoSpeak: field<HTMLInputElement>('autoSpeak').checked,
    flattenLighting: field<HTMLInputElement>('flattenLighting').checked,
    keepModelsLoaded: field<HTMLInputElement>('keepModelsLoaded').checked,
    systemVoices: { ...settings.systemVoices },
  };
  const voice = field<HTMLSelectElement>('systemVoice').value;
  if (voice) next.systemVoices[lang] = voice;
  else delete next.systemVoices[lang];
  return next;
}

form.addEventListener('change', (e) => {
  const prev = settings;
  settings = readSettings();
  save(settings);
  const name = (e.target as HTMLInputElement).name;
  if (name === 'translate' || name === 'model') void fillVoices();
  if (name === 'keepModelsLoaded') setKeepModelsLoaded(settings.keepModelsLoaded);
  if (name === 'flattenLighting') {
    for (const p of photos) {
      p.lines = undefined;
      p.state = 'waiting';
    }
    sourceEdited = false;
    renderPhotos();
    void processPhotos();
  }
  if ((name === 'model' || name.startsWith('glossary')) && prev.translate) translatedFrom = '';
  if (name === 'translate') showTab(settings.translate ? 'target' : 'source');
  renderButtons();
});

$('#test-voice').addEventListener('click', () => {
  speech.unlockAudio();
  const sample = speechLang() === 'fi' ? 'Hei! Näin luen korttien tekstit ääneen.' : 'Hello! This is how card text will be read aloud.';
  void task(() =>
    speech.speak([sample], {
      lang: speechLang(),
      engine: settings.voiceEngine,
      systemVoice: settings.systemVoices[speechLang()],
      rate: settings.rate,
      onProgress: (label, f) => showStatus(label, f),
    }),
  );
});

$('#open-settings').addEventListener('click', openSettings);

// ---- start-up ----

renderButtons();
showTab('source');
void registerServiceWorker((apply) => {
  const btn = $('#update');
  btn.hidden = false;
  btn.addEventListener('click', apply, { once: true });
});
// Load the OCR models in the background so the first photo is read sooner.
warmupOcr().catch((err) => console.warn('OCR warm-up failed', err));
