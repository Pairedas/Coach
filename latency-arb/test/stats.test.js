import test from 'node:test';
import assert from 'node:assert/strict';
import { erf, normCdf, EwmaVol, PriceHistory, quantile } from '../src/util/stats.js';

test('normCdf reproduit les valeurs de reference', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-4);
  assert.ok(Math.abs(normCdf(3) - 0.99865) < 1e-4);
});

test('erf est impaire et bornee', () => {
  assert.ok(Math.abs(erf(0.5) + erf(-0.5)) < 1e-9);
  assert.ok(erf(5) <= 1 && erf(5) > 0.999);
});

test('PriceHistory retrouve le prix a un instant passe', () => {
  const h = new PriceHistory(10_000);
  h.push(1_000, 100);
  h.push(2_000, 110);
  h.push(3_000, 120);
  assert.equal(h.priceAt(2_500), 110);
  assert.equal(h.priceAt(2_000), 110);
  assert.equal(h.priceAt(3_500), 120);
  assert.equal(h.priceAt(500), null, 'avant le debut de l\'historique, pas d\'invention');
});

test('PriceHistory purge au-dela de la fenetre', () => {
  const h = new PriceHistory(1_000);
  for (let t = 0; t <= 5_000; t += 100) h.push(t, 100 + t / 100);
  assert.ok(h.points.length <= 12, `fenetre non purgee : ${h.points.length} points`);
  assert.equal(h.latest.price, 150);
});

test('PriceHistory ignore les ticks arrives dans le desordre', () => {
  const h = new PriceHistory(10_000);
  h.push(2_000, 100);
  h.push(1_000, 999);
  assert.equal(h.priceAt(2_000), 100);
});

test('EwmaVol converge vers la volatilite qui a genere les donnees', () => {
  // Trajectoire deterministe alternee : volatilite par pas connue exactement.
  const volAnnual = 0.6;
  const secPerYear = 365 * 24 * 3600;
  const stepSec = 1;
  const sigmaStep = volAnnual * Math.sqrt(stepSec / secPerYear);
  const vol = new EwmaVol(60, 0.0001, 1_000);
  let price = 100_000;
  for (let i = 0; i < 3_000; i += 1) {
    price *= Math.exp(i % 2 === 0 ? sigmaStep : -sigmaStep);
    vol.update(price, i * 1_000);
  }
  assert.ok(Math.abs(vol.volAnnual - volAnnual) / volAnnual < 0.05,
    `vol estimee ${vol.volAnnual.toFixed(3)} loin de ${volAnnual}`);
});

test('EwmaVol n\'echantillonne pas sous le pas minimal', () => {
  const vol = new EwmaVol(60, 0.0001, 1_000);
  vol.update(100, 0);
  for (let t = 10; t < 900; t += 10) vol.update(100 * (1 + (t % 20 === 0 ? 0.001 : -0.001)), t);
  assert.equal(vol.samples, 0, 'le bruit haute frequence ne doit pas alimenter l\'estimateur');
});

test('quantile interpole', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([], 0.5), 0);
});
