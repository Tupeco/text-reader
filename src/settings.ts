// User settings, persisted per device in localStorage.

export type Settings = {
  translate: boolean;
  /** Translation model id from models.json, e.g. "en-fi". */
  model: string;
  /** Source language spoken when translation is off. */
  sourceLang: string;
  voiceEngine: 'auto' | 'system' | 'piper';
  /** Preferred system voice per language (voiceURI). */
  systemVoices: Record<string, string>;
  rate: number;
  autoSpeak: boolean;
  flattenLighting: boolean;
  glossaryBefore: string;
  glossaryAfter: string;
};

const KEY = 'card-reader:settings';

export const defaults: Settings = {
  translate: true,
  model: 'en-fi',
  sourceLang: 'en',
  voiceEngine: 'auto',
  systemVoices: {},
  rate: 1,
  autoSpeak: false,
  flattenLighting: false,
  glossaryBefore: '# Fix OCR or protect game terms before translating, e.g.\n# Stonesaga = Stonesaga\n',
  glossaryAfter: '# Fix translated terms before they are read aloud, e.g.\n# maine = kunnia\n',
};

export function load(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

export function save(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage blocked: settings just won't persist.
  }
}
