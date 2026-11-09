// Board game wording fixes for the on-device translator (Opus-MT), per language pair. The model has never
// seen game jargon: it reads "draw" as drawing a picture, "deck" as a lid, "roll the die" as dying.
// `before` rephrases the English into wording the model translates correctly; `after` replaces its
// consistent mistranslations, keeping Finnish case endings. Rules were tuned against the model's real
// output (src/device-terms.model.test.ts). Server engines don't need these; they get glossary/*.tsv.

type Rule = [pattern: RegExp, replacement: string];
type Terms = { before: Rule[]; after: Rule[] };

/** A whole Finnish word, case-insensitive. */
const word = (w: string) => new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'giu');

/** Object of a game verb: "this card", "all exhausted workers", "it", … up to the noun. */
const OBJ = String.raw`((?:this|that|a|an|one|the|your|all|each|any|another|up to \d+|\d+)\b[^.,;:!?]*?\b(?:cards?|workers?|members?|heroes|hero|units?|tiles?)\b|it|them)`;

/** "kansi" (lid) → "pakka" (deck) in every case, also at the end of compounds ("tapahtumakannen"). */
const deckCases: [string, string][] = [
  ['kansi', 'pakka'], ['kannen', 'pakan'], ['kantta', 'pakkaa'], ['kanteen', 'pakkaan'],
  ['kannessa', 'pakassa'], ['kannesta', 'pakasta'], ['kannelle', 'pakkaan'], ['kannella', 'pakassa'],
  ['kannelta', 'pakasta'], ['kannet', 'pakat'], ['kansien', 'pakkojen'],
];
const discardPileCases: [string, string][] = [
  ['kasa', 'poistopakka'], ['kasan', 'poistopakan'], ['kasaa', 'poistopakkaa'], ['kasaan', 'poistopakkaan'],
  ['kasassa', 'poistopakassa'], ['kasasta', 'poistopakasta'], ['kasalle', 'poistopakkaan'],
];

const terms: Record<string, Terms> = {
  'en-fi': {
    before: [
      // "roll the hunt die" → "Metsästys loppuu" ("the hunt ends"); with "dice" it's a die.
      [/\b(roll|throw)((?:\s+(?:the|a|an|one|this|that|your|each))?(?:\s+[\w-]+){0,2}?)\s+die\b/gi, '$1$2 dice'],
      [/\bexhausts?\s+(it|them)\b/gi, 'turn $1 sideways'],
      [new RegExp(String.raw`\bexhaust\s+${OBJ}`, 'gi'), 'turn $1 sideways'],
      [/\breadies\s+(it|them)\b/gi, 'turns $1 upright'],
      [new RegExp(String.raw`\bready\s+${OBJ}`, 'gi'), 'turn $1 upright'],
      // A sentence starting "Gain …" is left untranslated; "You gain …" works.
      [/(^|[.!?;:]\s+|,\s*(?:then\s+)?|\bthen\s+|\band\s+)gain\b/gi, '$1you gain'],
      [/\btake (\d+|an?|one|two|three|four|five) damage\b/gi, 'suffer $1 damage'],
      // "renown" → "uutta" ("new"); "fame" → "mainetta".
      [/\brenown\b/gi, 'fame'],
      // "event deck" alone sometimes becomes "lava" (a stage); "event card deck" keeps the deck.
      [/\bevent deck\b/gi, 'event card deck'],
    ],
    after: [
      // \b is ASCII-only in JavaScript, so Finnish words use letter lookarounds (word()).
      [word('piirrä'), 'nosta'],
      [word('piirtää'), 'nostaa'],
      [word('piirrät'), 'nostat'],
      // "Draw" also comes out as "vedä"; only fixed before a card word ("vedä" also means "pull").
      [/(?<!\p{L})vedä(?=\s+(?:\p{L}+\s+){0,2}kort)/giu, 'nosta'],
      [/(?<!\p{L})vedät(?=\s+(?:\p{L}+\s+){0,2}kort)/giu, 'nostat'],
      // "turn it upright" → "käännä se suoraksi" ("straight").
      [/(?<!\p{L})(käännä|kääntää|käännät|käännetään)(\s+(?:se|sen|ne|niitä|ne kaikki|kaikki\s+\p{L}+\s+\p{L}+))\s+suoraksi(?!\p{L})/giu, '$1$2 pystyyn'],
      [word('pyöritä'), 'heitä'],
      [word('pyörität'), 'heität'],
      // "(to) roll the hunt dice" → "heittää metsästysnopeuksia" ("hunt speeds").
      [/(?<!\p{L})(heit\p{L}*\s+(?:\p{L}+)?)nopeuksia(?!\p{L})/giu, '$1noppaa'],
      [word('sujauta'), 'sekoita'],
      [word('hävitä'), 'hylkää'],
      [/(?<!\p{L})poisheitettävä(?:n|än|ä|ssä|stä|lle)?\s+(kasa\p{L}*)/giu, '\u0000$1'],
      ...discardPileCases.map(([fi, to]): Rule => [new RegExp(`\u0000${fi}(?![\\p{L}])`, 'giu'), to]),
      ...deckCases.map(([fi, to]): Rule => [new RegExp(`${fi}(?![\\p{L}])`, 'giu'), to]),
      // Leftover marker if a "kasa" form wasn't listed: plain "poistopakka" beats a broken word.
      [/\u0000\p{L}*/gu, 'poistopakka'],
    ],
  },
};

/** Replaces like String.replace, but keeps an uppercase first letter of the matched text. */
function replaceKeepingCase(text: string, [pattern, replacement]: Rule): string {
  return text.replace(pattern, (...args) => {
    const match = args[0] as string;
    const groups = args.slice(1, -2);
    let out = replacement.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
    // "$1you gain" at the start of a sentence: capitalise the first letter of the inserted word.
    // E.g. "Gain" → "You gain", "Piirrä" → "Nosta", ". Gain" → ". You gain".
    const lead = /^[^\p{L}]*/u.exec(match)![0].length;
    if (match[lead] && match[lead] !== match[lead].toLowerCase()) {
      const i = /^[^\p{L}]*/u.exec(out)![0].length;
      out = out.slice(0, i) + out.charAt(i).toUpperCase() + out.slice(i + 1);
    }
    return out;
  });
}

function apply(text: string, rules: Rule[]) {
  return rules.reduce(replaceKeepingCase, text);
}

/** Rephrases an English sentence before on-device translation. */
export function beforeDevice(pair: string, sentence: string): string {
  const t = terms[pair];
  return t ? apply(sentence, t.before) : sentence;
}

/** Fixes known mistranslations in the on-device translator's output. */
export function afterDevice(pair: string, sentence: string): string {
  const t = terms[pair];
  return t ? apply(sentence, t.after) : sentence;
}
