import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotTape } from '../src/feeds/spot.js';

const NOW = 1_700_000_000_000;

function tape(over = {}) {
  return new SpotTape({
    weights: { binance: 0.65, coinbase: 0.35 },
    stalenessMs: 3_000,
    historyMs: 120_000,
    volHalfLifeSec: 120,
    seedVolAnnual: 0.5,
    volSampleMs: 1_000,
    referenceVenue: 'coinbase',
    basisHalfLifeSec: 300,
    ...over,
  });
}

const cote = (venue, mid, ts) => ({ venue, bid: mid - 1, ask: mid + 1, mid, ts });

test('la base USDT/USD est corrigee : le prix consolide reste en dollars', () => {
  const t = tape();
  // Binance cote 63 060 en USDT quand Coinbase cote 63 000 en dollars :
  // une base de 60 dollars, du meme ordre que la largeur d'un marche de 5 min.
  for (let i = 0; i < 500; i += 1) {
    t.onQuote(cote('coinbase', 63_000, NOW + i * 100));
    t.onQuote(cote('binance', 63_060, NOW + i * 100));
  }
  // Sans correction, la moyenne ponderee donnerait 63 039 : 39 dollars d'erreur.
  assert.ok(Math.abs(t.price - 63_000) < 3, `prix consolide ${t.price}, attendu ~63 000`);
  assert.ok(Math.abs(t.basis.get('binance') - 60) < 3);
});

test('la correction suit les mouvements communs sans les absorber', () => {
  const t = tape();
  for (let i = 0; i < 500; i += 1) {
    t.onQuote(cote('coinbase', 63_000, NOW + i * 100));
    t.onQuote(cote('binance', 63_060, NOW + i * 100));
  }
  const avant = t.price;
  // Les deux places montent de 100 dollars : la base est inchangee, le prix doit suivre.
  const t2 = NOW + 50_000;
  t.onQuote(cote('coinbase', 63_100, t2));
  t.onQuote(cote('binance', 63_160, t2));
  assert.ok(t.price - avant > 95, `le mouvement commun doit passer (${t.price - avant})`);
});

test('une place figee sort du prix consolide', () => {
  const t = tape();
  t.onQuote(cote('coinbase', 63_000, NOW));
  t.onQuote(cote('binance', 63_000, NOW));
  assert.equal(t.isStale(NOW), false);

  // Seule Coinbase continue d'emettre : Binance doit etre ecartee.
  t.onQuote(cote('coinbase', 63_500, NOW + 10_000));
  assert.ok(Math.abs(t.price - 63_500) < 1, `prix ${t.price}`);
  assert.deepEqual(t.consolidated.venues, ['coinbase']);
});

test('sans place de reference vivante, la base n\'est pas mise a jour', () => {
  const t = tape();
  t.onQuote(cote('binance', 63_060, NOW));
  assert.equal(t.basis.has('binance'), false, 'aucune reference, aucune correction inventee');
  assert.ok(Math.abs(t.price - 63_060) < 1);
});

test('l\'historique permet de retrouver le prix passe apres correction', () => {
  const t = tape();
  for (let i = 0; i < 100; i += 1) {
    t.onQuote(cote('coinbase', 63_000 + i, NOW + i * 1_000));
    t.onQuote(cote('binance', 63_060 + i, NOW + i * 1_000));
  }
  const passe = t.priceAgo(50_000, NOW + 99_000);
  assert.ok(passe !== null && Math.abs(passe - 63_049) < 5, `prix passe ${passe}`);
});
