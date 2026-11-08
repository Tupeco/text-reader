// Read-aloud: the platform's own voices (Web Speech API) or Piper running in the model worker.
import { catalog } from './catalog';
import { synthesize, type Progress } from './ml';

export type SpeakOptions = {
  lang: string;
  engine: 'auto' | 'system' | 'piper';
  /** voiceURI of the preferred system voice for this language, if any. */
  systemVoice?: string;
  rate: number;
  /** Called with the index of the sentence being spoken, or -1 when done. */
  onSentence?: (i: number) => void;
  onProgress?: Progress;
};

const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;

/** System voices load asynchronously on most platforms. */
export function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!synth) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

const langMatches = (voiceLang: string, lang: string) => voiceLang.toLowerCase().replace('_', '-').split('-')[0] === lang;

/** On-device voices first: network voices (e.g. "Google suomi" on desktop Chrome) fail offline. */
export async function voicesFor(lang: string) {
  return (await systemVoices())
    .filter((v) => langMatches(v.lang, lang))
    .sort((a, b) => Number(b.localService) - Number(a.localService));
}

export function piperVoiceFor(lang: string) {
  return catalog.piper.find((v) => v.lang === lang);
}

let stopped = { value: false };
let audio: AudioContext | undefined;
let source: AudioBufferSourceNode | undefined;

export function stop() {
  stopped.value = true;
  synth?.cancel();
  source?.stop();
  source = undefined;
}

/** Must be called from a user gesture so iOS lets us play audio later. */
export function unlockAudio() {
  audio ??= new AudioContext();
  if (audio.state === 'suspended') void audio.resume();
}

export async function speak(sentences: string[], opts: SpeakOptions): Promise<void> {
  stop();
  const token = (stopped = { value: false });
  const engine = await chooseEngine(opts);
  try {
    if (engine.kind === 'system') await speakSystem(sentences, engine.voice, opts, token);
    else await speakPiper(sentences, engine.voice, opts, token);
  } finally {
    if (!token.value) opts.onSentence?.(-1);
  }
}

async function chooseEngine(opts: SpeakOptions) {
  const system = await voicesFor(opts.lang);
  const preferred = system.find((v) => v.voiceURI === opts.systemVoice) ?? system.find((v) => v.localService);
  const piper = piperVoiceFor(opts.lang);
  if (opts.engine === 'piper' || (opts.engine === 'auto' && !preferred && piper)) {
    if (!piper) throw new Error(`No Piper voice for "${opts.lang}"`);
    return { kind: 'piper' as const, voice: piper.id };
  }
  if (!synth) throw new Error('This browser has no speech synthesis');
  // Fall back to any voice (possibly a network one) rather than staying silent.
  return { kind: 'system' as const, voice: preferred ?? system[0] };
}

function speakSystem(sentences: string[], voice: SpeechSynthesisVoice | undefined, opts: SpeakOptions, token: { value: boolean }) {
  // One utterance per sentence: Chrome on Android cuts off long utterances after ~15 s.
  return new Promise<void>((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (token.value || i >= sentences.length) return resolve();
      const u = new SpeechSynthesisUtterance(sentences[i]);
      u.lang = voice?.lang ?? opts.lang;
      if (voice) u.voice = voice;
      u.rate = opts.rate;
      const index = i++;
      u.onstart = () => opts.onSentence?.(index);
      u.onend = next;
      u.onerror = (e) => (e.error === 'canceled' || e.error === 'interrupted' ? resolve() : reject(new Error(`Speech failed: ${e.error}`)));
      synth!.speak(u);
    };
    next();
  });
}

async function speakPiper(sentences: string[], voice: string, opts: SpeakOptions, token: { value: boolean }) {
  unlockAudio();
  const ctx = audio!;
  // Synthesize the next sentence while the current one plays.
  let pending = synthesize(voice, sentences[0], opts.rate, opts.onProgress);
  for (let i = 0; i < sentences.length; i++) {
    const { pcm, sampleRate } = await pending;
    if (token.value) return;
    if (i + 1 < sentences.length) pending = synthesize(voice, sentences[i + 1], opts.rate);
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    opts.onSentence?.(i);
    await new Promise<void>((resolve) => {
      source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(ctx.destination);
      source.onended = () => resolve();
      source.start();
    });
    if (token.value) return;
  }
}
