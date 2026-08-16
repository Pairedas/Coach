import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker } from '../src/exec/paper.js';
import { LiveBroker } from '../src/exec/live.js';
import { Book } from '../src/polymarket/book.js';
import { TokenView } from '../src/strategy/token-view.js';
import { withOverrides } from '../src/config.js';
import { takerFee } from '../src/model/costs.js';

const NOW = 1_700_000_000_000;
const cfg = (over = {}) => withOverrides({ exec: { simLatencyMs: 300, simQueueLossPct: 0 }, ...over });

function viewAt(ask, size = 500) {
  const b = new Book('YES');
  b.applySnapshot({ bids: [{ price: ask - 0.02, size }], asks: [{ price: ask, size }], ts: NOW });
  return TokenView.for('YES', b, null);
}

test('un ordre n\'est pas execute avant l\'ecoulement de la latence', () => {
  const broker = new PaperBroker(cfg());
  const fills = [];
  broker.on('fill', (f) => fills.push(f));

  const view = viewAt(0.52);
  broker.submit({ side: 'buy', shares: 100, limitPrice: 0.55, now: NOW, resolveView: () => view });
  broker.tick(NOW + 100);
  assert.equal(fills.length, 0, 'trop tot');
  broker.tick(NOW + 300);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].avgPrice, 0.52);
});

test('si le prix part pendant la latence, l\'ordre meurt au lieu de payer trop cher', () => {
  const broker = new PaperBroker(cfg());
  const rejets = [];
  broker.on('reject', (r) => rejets.push(r));

  let view = viewAt(0.52);
  broker.submit({ side: 'buy', shares: 100, limitPrice: 0.54, now: NOW, resolveView: () => view });
  // Le retard a ete comble par un acteur plus rapide : l'offre est passee a 0,60.
  view = viewAt(0.60);
  broker.tick(NOW + 300);

  assert.equal(rejets.length, 1);
  assert.match(rejets[0].reason, /prix parti/);
});

test('la perte de file d\'attente degrade le prix moyen obtenu', () => {
  const broker = new PaperBroker(cfg({ exec: { simLatencyMs: 0, simQueueLossPct: 0.5 } }));
  const fills = [];
  broker.on('fill', (f) => fills.push(f));

  const b = new Book('YES');
  b.applySnapshot({
    bids: [{ price: 0.5, size: 100 }],
    asks: [{ price: 0.52, size: 100 }, { price: 0.54, size: 100 }],
    ts: NOW,
  });
  const view = TokenView.for('YES', b, null);
  broker.submit({ side: 'buy', shares: 100, limitPrice: 0.6, now: NOW, resolveView: () => view });
  broker.tick(NOW);

  assert.equal(fills[0].filled, 100);
  assert.ok(Math.abs(fills[0].avgPrice - 0.53) < 1e-9, 'la moitie du premier niveau seulement est atteignable');
});

test('une execution partielle est signalee comme telle', () => {
  const broker = new PaperBroker(cfg());
  const fills = [];
  broker.on('fill', (f) => fills.push(f));
  const view = viewAt(0.52, 30);
  broker.submit({ side: 'buy', shares: 100, limitPrice: 0.55, now: NOW, resolveView: () => view });
  broker.tick(NOW + 300);
  assert.equal(fills[0].filled, 30);
  assert.equal(fills[0].partial, true);
});

test('les frais suivent la formule min(p, 1-p)', () => {
  assert.equal(takerFee(0.5, 100, 0), 0);
  assert.ok(Math.abs(takerFee(0.8, 100, 100) - 0.01 * 0.2 * 100) < 1e-12);
  assert.ok(Math.abs(takerFee(0.2, 100, 100) - takerFee(0.8, 100, 100)) < 1e-12);
});

test('le mode reel refuse de demarrer sans confirmation explicite', async () => {
  await assert.rejects(
    () => new LiveBroker(withOverrides({ exec: { live: false } })).connect(),
    /mode reel non active/,
  );
  await assert.rejects(
    () => new LiveBroker(withOverrides({ exec: { live: true, liveConfirm: 'oui' } })).connect(),
    /LIVE_CONFIRM/,
  );
  await assert.rejects(
    () => new LiveBroker(withOverrides({
      exec: { live: true, liveConfirm: 'JE COMPRENDS LES RISQUES', privateKey: '' },
    })).connect(),
    /PRIVATE_KEY/,
  );
});
