import { describe, expect, it } from 'vitest';
import { afterDevice, beforeDevice } from './device-terms';

describe('rephrasing English for the on-device translator', () => {
  const b = (s: string) => beforeDevice('en-fi', s);

  it('turns a rolled "die" into dice and leaves other dying alone', () => {
    expect(b('Roll the hunt die.')).toBe('Roll the hunt dice.');
    expect(b('Roll a die.')).toBe('Roll a dice.');
    expect(b('If the beast would die, discard it.')).toBe('If the beast would die, discard it.');
  });

  it('rephrases exhaust/ready with their object', () => {
    expect(b('Exhaust this card to gain 2 food.')).toBe('Turn this card sideways to gain 2 food.');
    expect(b('Ready all exhausted workers.')).toBe('Turn all exhausted workers upright.');
    expect(b('… and readies it.')).toBe('… and turns it upright.');
    expect(b('Exhausted heroes cannot move.')).toBe('Exhausted heroes cannot move.');
  });

  it('gives "gain" a subject, keeping the capital letter', () => {
    expect(b('Gain 1 meat.')).toBe('You gain 1 meat.');
    expect(b('Draw a card, then gain 2 stone.')).toBe('Draw a card, then you gain 2 stone.');
    expect(b('Roll. On a success, gain 1 hide.')).toBe('Roll. On a success, you gain 1 hide.');
    expect(b('You gain 1 meat.')).toBe('You gain 1 meat.');
  });

  it('rewrites renown, event deck and damage', () => {
    expect(b('Gain 3 renown.')).toBe('You gain 3 fame.');
    expect(b('next to the event deck')).toBe('next to the event card deck');
    expect(b('Take 2 damage.')).toBe('Suffer 2 damage.');
  });
});

describe('fixing the on-device translator output', () => {
  const a = (s: string) => afterDevice('en-fi', s);

  it('replaces "kansi" (lid) with "pakka" in every case, also in compounds', () => {
    expect(a('Sekoita kasa kannelle.')).toBe('Sekoita kasa pakkaan.');
    expect(a('Paljasta tapahtumakannen yläkortti.')).toBe('Paljasta tapahtumapakan yläkortti.');
    expect(a('Kansi loppuu.')).toBe('Pakka loppuu.');
    expect(a('Ota kortti kannesta, avaa kansio.')).toBe('Ota kortti pakasta, avaa kansio.');
  });

  it('fixes draw, roll, shuffle and discard verbs, keeping the capital letter', () => {
    expect(a('Piirrä kaksi korttia.')).toBe('Nosta kaksi korttia.');
    expect(a('Vedä kaksi korttia, vedä vipua.')).toBe('Nosta kaksi korttia, vedä vipua.');
    expect(a('Pyöritä noppaa.')).toBe('Heitä noppaa.');
    expect(a('Sujauta kortti.')).toBe('Sekoita kortti.');
    expect(a('Hävitä kortti.')).toBe('Hylkää kortti.');
  });

  it('names the discard pile', () => {
    expect(a('Laita kortti poisheitettävään kasaan.')).toBe('Laita kortti poistopakkaan.');
    expect(a('Sujauta poisheitettävä kasa kannelle.')).toBe('Sekoita poistopakka pakkaan.');
  });

  it('leaves other language pairs alone', () => {
    expect(afterDevice('en-sv', 'Piirrä')).toBe('Piirrä');
    expect(beforeDevice('en-sv', 'Gain 1.')).toBe('Gain 1.');
  });
});
