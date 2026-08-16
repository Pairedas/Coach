import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/polymarket/book.js';
import { TokenView } from '../src/strategy/token-view.js';

function seeded() {
  const b = new Book('t');
  b.applySnapshot({
    bids: [{ price: 0.48, size: 100 }, { price: 0.47, size: 200 }],
    asks: [{ price: 0.52, size: 100 }, { price: 0.53, size: 200 }],
    ts: 1_000,
  });
  return b;
}

test('l\'instantane classe les niveaux et expose le sommet', () => {
  const b = seeded();
  assert.equal(b.bestBid, 0.48);
  assert.equal(b.bestAsk, 0.52);
  assert.ok(Math.abs(b.mid - 0.5) < 1e-9);
  assert.ok(Math.abs(b.spread - 0.04) < 1e-9);
  assert.equal(b.isCrossed, false);
});

test('un delta met a jour, ajoute et supprime des niveaux', () => {
  const b = seeded();
  b.applyChanges([{ price: 0.52, side: 'SELL', size: 0 }], 2_000);
  assert.equal(b.bestAsk, 0.53, 'le niveau vide doit disparaitre');
  b.applyChanges([{ price: 0.5, side: 'BUY', size: 50 }], 3_000);
  assert.equal(b.bestBid, 0.5);
});

test('le sommet fige n\'avance pas l\'horodatage de changement', () => {
  const b = seeded();
  const before = b.lastTopChangeTs;
  const changes = b.topChanges;
  b.applyChanges([{ price: 0.4, side: 'BUY', size: 10 }], 5_000);
  assert.equal(b.lastTopChangeTs, before, 'un niveau profond ne change pas le sommet');
  assert.equal(b.topChanges, changes);
  assert.equal(b.lastUpdateTs, 5_000, 'mais le carnet a bien recu un message');
});

test('le balayage calcule un prix moyen et respecte la limite', () => {
  const b = seeded();
  const full = b.sweep('buy', 150, 1);
  assert.equal(full.filled, 150);
  assert.ok(Math.abs(full.avgPrice - (100 * 0.52 + 50 * 0.53) / 150) < 1e-12);

  const limited = b.sweep('buy', 150, 1, 0.52);
  assert.equal(limited.filled, 100, 'la limite bloque au premier niveau');
  assert.equal(limited.shortfall, 50);
});

test('la disponibilite degrade le prix moyen en forcant a descendre le carnet', () => {
  const b = seeded();
  const full = b.sweep('buy', 100, 1);
  const halved = b.sweep('buy', 100, 0.5);
  // Avec la moitie de chaque niveau atteignable, il faut aller chercher 50 parts
  // au niveau suivant : meme quantite, mais plus chere.
  assert.equal(halved.filled, 100);
  assert.ok(halved.avgPrice > full.avgPrice, `${halved.avgPrice} devrait depasser ${full.avgPrice}`);
  assert.ok(Math.abs(halved.avgPrice - (50 * 0.52 + 50 * 0.53) / 100) < 1e-12);
});

test('la disponibilite limite bien la taille quand le carnet est fin', () => {
  const thin = new Book('t');
  thin.applySnapshot({ bids: [], asks: [{ price: 0.52, size: 100 }], ts: 1_000 });
  const r = thin.sweep('buy', 100, 0.5);
  assert.equal(r.filled, 50);
  assert.equal(r.shortfall, 50);
});

test('la vue NO synthetique inverse prix et sens', () => {
  const yes = seeded();
  const view = TokenView.for('NO', yes, null);
  assert.ok(view.synthetic);
  assert.ok(Math.abs(view.ask - 0.52) < 1e-9, 'acheter NO = vendre YES au meilleur achat');
  assert.ok(Math.abs(view.bid - 0.48) < 1e-9);

  const bought = view.buySweep(100, 1);
  assert.equal(bought.filled, 100);
  assert.ok(Math.abs(bought.avgPrice - 0.52) < 1e-9);
});

test('la vue NO privilegie le vrai carnet quand il existe', () => {
  const yes = seeded();
  const no = new Book('no');
  no.applySnapshot({ bids: [{ price: 0.45, size: 10 }], asks: [{ price: 0.49, size: 10 }], ts: 1_000 });
  const view = TokenView.for('NO', yes, no);
  assert.equal(view.synthetic, false);
  assert.equal(view.ask, 0.49);
});
