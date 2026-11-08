import { describe, expect, it } from 'vitest';
import { applyGlossary, cleanOcrText, linesToText, parseGlossary, splitSentences, type OcrLine } from './text';

const line = (text: string, conf = 0.9, startsParagraph = false): OcrLine => ({ text, conf, startsParagraph });

describe('cleanOcrText', () => {
  it('joins wrapped lines and keeps paragraphs', () => {
    expect(cleanOcrText('Wandering Merchant\n\nWhen you reveal this\ncard, gain 1 wood.')).toBe(
      'Wandering Merchant\n\nWhen you reveal this card, gain 1 wood.',
    );
  });

  it('de-hyphenates words split across lines', () => {
    expect(cleanOcrText('an inter-\nesting card')).toBe('an interesting card');
    expect(cleanOcrText('a well-\nKnown name')).toBe('a well- Known name');
  });

  it('drops icon debris but keeps punctuation and numbers', () => {
    expect(cleanOcrText('trade 2 © ® for 1 | stone — then +1 renown.')).toBe('trade 2 for 1 stone — then +1 renown.');
    expect(cleanOcrText('gain 3 @ .')).toBe('gain 3.');
  });

  it('drops round icons read as letters after an amount', () => {
    expect(cleanOcrText('trade 2 O wood for 1 0 stone, then +1 C renown')).toBe('trade 2 wood for 1 stone, then +1 renown');
    expect(cleanOcrText('Plan O and 2 Orcs')).toBe('Plan O and 2 Orcs');
  });

  it('separates numbers glued to words but keeps ordinals', () => {
    expect(cleanOcrText('gain 1renown on the 2nd or 3rd day, 4th x 2x')).toBe('gain 1 renown on the 2nd or 3rd day, 4th x 2x');
  });
});

describe('glossary', () => {
  it('parses rules and ignores comments', () => {
    expect(parseGlossary('# terms\nrenown = maine\n\nbad line\nsettler = uudisasukas')).toEqual([
      { from: 'renown', to: 'maine' },
      { from: 'settler', to: 'uudisasukas' },
    ]);
  });

  it('replaces whole words case-insensitively, longest first', () => {
    const rules = parseGlossary('hero = sankari\nhero token = sankarimerkki');
    expect(applyGlossary('Place a Hero token near the hero. Heroes rest.', rules)).toBe(
      'Place a sankarimerkki near the sankari. Heroes rest.',
    );
  });
});

describe('splitSentences', () => {
  it('splits sentences per paragraph', () => {
    expect(splitSentences('Title\n\nDo this. Then that! "Quoted" ok?\nNext 2 lines.')).toEqual([
      ['Title'],
      ['Do this.', 'Then that!', '"Quoted" ok?', 'Next 2 lines.'],
    ]);
  });

  it('does not split on decimals or lowercase continuations', () => {
    expect(splitSentences('Gain 1.5 wood. e.g. this stays. Next one.')).toEqual([
      ['Gain 1.5 wood. e.g. this stays.', 'Next one.'],
    ]);
  });
});

describe('linesToText', () => {
  it('uses blank lines between paragraphs', () => {
    expect(linesToText([line('Title', 1, true), line('first', 1, true), line('second')])).toBe('Title\n\nfirst\nsecond');
  });
});
