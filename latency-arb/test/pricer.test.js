import test from 'node:test';
import assert from 'node:assert/strict';
import { probAbove, probBelow, probDelta, fairProbability } from '../src/model/pricer.js';

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
