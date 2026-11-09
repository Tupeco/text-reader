// Checks the on-device wording fixes against the real translation model (the app's q8 ONNX files, run by
// Transformers.js in Node). Skipped until `npm run assets` has downloaded the model.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { afterDevice, beforeDevice } from './device-terms';

const models = fileURLToPath(new URL('../public/models/', import.meta.url));
const present = existsSync(`${models}Xenova/opus-mt-en-fi/onnx/decoder_model_merged_quantized.onnx`);

/** English card text → the Finnish expected after before → model → after. */
export const cases: [string, string][] = [
  ["Draw 2 cards.", "Nosta kaksi korttia."],
  ["Draw a card.", "Nosta kortti."],
  ["Draw 3 cards, then discard 1 card from your hand.", "Nosta 3 korttia, hylkää 1 kortti kädestäsi."],
  ["Discard a card.", "Hylkää kortti."],
  ["Discard 2 cards from your hand.", "Hylkää kaksi korttia kädestäsi."],
  ["Shuffle the discard pile into the deck.", "Sekoita poistopakka pakkaan."],
  ["Put this card on top of the deck.", "Pane tämä kortti pakan päälle."],
  ["Reveal the top card of the event deck.", "Paljasta tapahtumakortin pakka."],
  ["Exhaust this card to gain 2 food.", "Käännä korttia sivuttain, jotta saat kaksi ruokaa."],
  ["Ready all exhausted workers.", "Käännä kaikki uupuneet työntekijät pystyasentoon."],
  ["Readies it.", "Käännä se pystyyn."],
  ["Roll the hunt die.", "Heitä metsästysnoppaa."],
  ["Roll 2 dice.", "Heitä kaksi noppaa."],
  ["Place a storm token on an adjacent region.", "Aseta myrskykyltti viereiselle alueelle."],
  ["At the end of your turn, gain 1 victory point.", "Vuorosi lopussa saat 1 voittopisteen."],
  ["Place this card faceup next to the event deck.", "Aseta tämä kortti kasvotusten tapahtumakortin pakan viereen."],
  ["Gain 1 meat and 1 hide.", "Saat yhden lihan ja yhden nahkan."],
  ["Take 2 damage.", "Kärsi 2 vahinkoa."],
  ["All heroes must spend 1 extra action to travel this round.", "Kaikkien sankarien on käytettävä yksi lisätoimi päästäkseen tälle kierrokselle."],
  ["Exposed settlements lose 2 resources unless sheltered.", "Paljastetut siirtokunnat menettävät kaksi resurssia, ellei niitä suojella."],
  ["Draw 2 cards, then discard 1 card from your hand.", "Nosta kaksi korttia, hylkää 1 kortti kädestäsi."],
  ["At the start of your turn, you may move one worker to an adjacent region.", "Vuorosi alussa voit siirtää yhden työntekijän viereiselle alueelle."],
  ["If you have more food than any other player, gain 3 renown.", "Jos sinulla on enemmän ruokaa kuin muilla pelaajilla, saat 3 mainetta."],
  ["Place this card faceup next to the event deck. It remains in play until the end of the season.", "Aseta tämä kortti tapahtumakortin pakan viereen. Kortti on pelattu kauden loppuun asti."],
  ["Roll the hunt die. On a success, gain 1 meat and 1 hide; otherwise, the beast escapes.", "Heitä metsästysnoppaa. Onnistumisena saat 1 lihan ja 1 nahka; muuten peto karkaa."],
  ["Each player chooses one of their exhausted tribe members and readies it.", "Jokainen pelaaja valitsee yhden uupuneista heimon jäsenistään ja kääntää sen pystyyn."],
  ["You cannot build structures in a region that contains a storm token.", "Alueelle ei voi rakentaa rakennuksia, joissa on myrskyn merkki."],
  ["Shuffle the discard pile into the deck when the deck runs out.", "Sekoita poistopakka pakkaan, kun pakka loppuu."],
  ["The first player to reach 20 victory points wins the game.", "Ensimmäinen pelaaja, joka saavuttaa 20 voittopistettä, voittaa pelin."],
  ["Spend 2 stone to upgrade your shelter to level 2.", "Käytä 2 kiveä, jotta voit päivittää suojasi tasolle 2."],
  ["Exhaust a worker to roll the hunt die.", "Käännä työntekijä sivuttain, jotta hän voi heittää metsästysnoppaa."],
  ["Then gain 2 stone.", "Sitten saat kaksi kiveä."],
];

describe.skipIf(!present)('on-device translation with board game wording fixes', () => {
  it('translates game jargon correctly', { timeout: 120_000 }, async () => {
    const T = await import('@huggingface/transformers');
    T.env.allowRemoteModels = false;
    T.env.localModelPath = models;
    const translate = (await T.pipeline('translation', 'Xenova/opus-mt-en-fi', { dtype: 'q8' })) as unknown as (
      s: string,
      o: object,
    ) => Promise<{ translation_text: string }[]>;
    const run = async (en: string) => {
      const [r] = await translate(beforeDevice('en-fi', en), { max_new_tokens: 256 });
      return afterDevice('en-fi', r.translation_text);
    };
    const got: [string, string][] = [];
    for (const [en] of cases) got.push([en, await run(en)]);
    if (process.env.SHOW) for (const [en, fi] of got) console.log(`${en}\n  → ${fi}`);
    expect(got).toEqual(cases);
  });
});
