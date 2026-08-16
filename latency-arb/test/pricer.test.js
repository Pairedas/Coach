import test from 'node:test';
import assert from 'node:assert/strict';
import { probAbove, probBelow, probDelta, fairProbability, impliedVolAbove } from '../src/model/pricer.js';

const base = { spot: 100_000, strike: 100_000, timeToExpiryMs: 1_800_000, volAnnual: 0.6 };

test('a la monnaie, la probabilite est proche de 0,5', () => {
  const p = probAbove(base);
  assert.ok(p > 0.49 && p < 0.5, `p = ${p}`);
});

test('la probabilite croit avec le spot', () => {
  const low = probAbove({ ...base, spot: 99_500 });
  const mid = probAbove(base);
  const high = probAbove({ ...base, spot: 100_500 });
  assert.ok(low < mid && mid < high);
});

test('probAbove et probBelow sont complementaires', () => {
  assert.ok(Math.abs(probAbove(base) + probBelow(base) - 1) < 1e-12);
});

test('a l\'echeance, le resultat est binaire', () => {
  assert.equal(probAbove({ ...base, spot: 100_001, timeToExpiryMs: 0 }), 1);
  assert.equal(probAbove({ ...base, spot: 99_999, timeToExpiryMs: 0 }), 0);
});

test('plus l\'echeance approche, plus la probabilite est tranchee', () => {
  const far = probAbove({ ...base, spot: 100_600, timeToExpiryMs: 3_600_000 });
  const near = probAbove({ ...base, spot: 100_600, timeToExpiryMs: 120_000 });
  assert.ok(near > far, `${near} devrait depasser ${far}`);
});

test('la sensibilite au spot est positive et decroit avec le temps restant', () => {
  const dNear = probDelta({ ...base, timeToExpiryMs: 120_000 });
  const dFar = probDelta({ ...base, timeToExpiryMs: 3_600_000 });
  assert.ok(dNear > dFar && dFar > 0);
});

test('un marche « below » inverse le sens', () => {
  const market = { strike: 100_000, side: 'below', expiryTs: 1_800_000 };
  const up = fairProbability(market, { spot: 101_000, volAnnual: 0.6, now: 0 });
  const down = fairProbability(market, { spot: 99_000, volAnnual: 0.6, now: 0 });
  assert.ok(down.prob > up.prob);
  assert.ok(up.delta < 0, 'la sensibilite d\'un « below » doit etre negative');
});

test('entrees invalides renvoient NaN plutot qu\'un prix invente', () => {
  assert.ok(Number.isNaN(probAbove({ ...base, spot: 0 })));
  assert.ok(Number.isNaN(probAbove({ ...base, volAnnual: 0 })));
});

test('la volatilite implicite retrouve la volatilite qui a produit le prix', () => {
  // Echeance a 28 h : assez lointaine pour que meme 25 % de volatilite donne un
  // prix loin du pas de cotation, donc reellement inversible.
  const args = { spot: 63_000, strike: 64_000, timeToExpiryMs: 100_000_000 };
  for (const vol of [0.25, 0.6, 1.2]) {
    const prix = probAbove({ ...args, volAnnual: vol });
    const implicite = impliedVolAbove({ ...args, prob: prix });
    assert.ok(Math.abs(implicite - vol) < 1e-3, `${implicite} devrait valoir ${vol}`);
  }
});

test('la volatilite implicite n\'est pas identifiable dans les cas degeneres', () => {
  const args = { spot: 63_000, strike: 64_000, timeToExpiryMs: 10_000_000 };
  assert.equal(impliedVolAbove({ ...args, prob: 0.001 }), null, 'cote posee sur le plancher du pas');
  assert.equal(impliedVolAbove({ ...args, prob: 0.9999 }), null);
  assert.equal(impliedVolAbove({ spot: 63_000, strike: 63_000, timeToExpiryMs: 10_000_000, prob: 0.5 }), null, 'a la monnaie');
  assert.equal(impliedVolAbove({ ...args, timeToExpiryMs: 0, prob: 0.3 }), null);
});

test('un marche plus confiant que le modele implique une volatilite plus faible', () => {
  // Cas reel observe le 16 aout 2026 : spot 63 040, seuil 64 000, ~2 h avant
  // echeance. Le carnet cotait 0,002 la ou le modele calculait 0,094.
  const args = { spot: 63_040, strike: 64_000, timeToExpiryMs: 2.4 * 3600_000 };
  const volMarche = impliedVolAbove({ ...args, prob: 0.002 });
  const volModele = impliedVolAbove({ ...args, prob: 0.094 });
  assert.ok(volMarche < volModele, 'le marche implique moins de volatilite');
  assert.ok(volMarche > 0.1 && volMarche < 0.5, `volatilite implicite inattendue : ${volMarche}`);
});

test('une fourchette vaut la difference de deux digitaux', () => {
  const market = { strike: 62_000, strikeHigh: 64_000, side: 'inside', expiryTs: 3_600_000 };
  const ctx = { spot: 63_000, volAnnual: 0.6, now: 0 };
  const r = fairProbability(market, ctx);

  const attendu = probAbove({ spot: 63_000, strike: 62_000, timeToExpiryMs: 3_600_000, volAnnual: 0.6 })
    - probAbove({ spot: 63_000, strike: 64_000, timeToExpiryMs: 3_600_000, volAnnual: 0.6 });
  assert.ok(Math.abs(r.prob - attendu) < 1e-12);
  assert.ok(r.prob > 0 && r.prob < 1);
});

test('une fourchette est plus probable au centre qu\'aux bords', () => {
  const market = { strike: 62_000, strikeHigh: 64_000, side: 'inside', expiryTs: 3_600_000 };
  const centre = fairProbability(market, { spot: 63_000, volAnnual: 0.6, now: 0 }).prob;
  const bord = fairProbability(market, { spot: 61_000, volAnnual: 0.6, now: 0 }).prob;
  assert.ok(centre > bord, `${centre} devrait depasser ${bord}`);
});

test('la sensibilite d\'une fourchette change de signe de part et d\'autre', () => {
  const market = { strike: 62_000, strikeHigh: 64_000, side: 'inside', expiryTs: 3_600_000 };
  const sousLaBorneBasse = fairProbability(market, { spot: 61_500, volAnnual: 0.6, now: 0 }).delta;
  const auDessusDeLaHaute = fairProbability(market, { spot: 64_500, volAnnual: 0.6, now: 0 }).delta;
  assert.ok(sousLaBorneBasse > 0, 'sous la fourchette, monter rapproche du gain');
  assert.ok(auDessusDeLaHaute < 0, 'au-dessus, monter eloigne du gain');
});

test('une fourchette mal formee ne produit pas de prix', () => {
  const market = { strike: 64_000, strikeHigh: 62_000, side: 'inside', expiryTs: 3_600_000 };
  assert.ok(Number.isNaN(fairProbability(market, { spot: 63_000, volAnnual: 0.6, now: 0 }).prob));
});
