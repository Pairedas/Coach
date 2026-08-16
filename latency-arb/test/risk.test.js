import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from '../src/risk/limits.js';
import { Portfolio } from '../src/portfolio.js';
import { withOverrides } from '../src/config.js';

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const cfg = () => withOverrides({
  risk: { maxPositions: 2, maxNotionalPerMarket: 100, maxTotalNotional: 150, minNotional: 5, dailyLossLimit: 50, maxConsecutiveLosses: 3 },
});

test('les plafonds de position et d\'exposition sont respectes', () => {
  const risk = new RiskManager(cfg());
  const base = { now: NOW, openPositions: [], exposure: 0, marketId: 'a', notional: 50 };
  assert.equal(risk.canOpen(base).ok, true);
  assert.equal(risk.canOpen({ ...base, notional: 120 }).ok, false, 'au-dessus du plafond par marche');
  assert.equal(risk.canOpen({ ...base, notional: 2 }).ok, false, 'sous le notionnel minimal');
  assert.equal(risk.canOpen({ ...base, exposure: 120, notional: 50 }).ok, false, 'exposition totale depassee');
});

test('un seul engagement par marche', () => {
  const risk = new RiskManager(cfg());
  const open = [{ marketId: 'a', shares: 10, entryPrice: 0.5 }];
  const r = risk.canOpen({ now: NOW, openPositions: open, exposure: 5, marketId: 'a', notional: 20 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /deja ouverte/);
});

test('la limite de perte journaliere declenche le coupe-circuit', () => {
  const risk = new RiskManager(cfg());
  risk.recordClose(-30, NOW);
  assert.equal(risk.halted, false);
  risk.recordClose(-25, NOW);
  assert.equal(risk.halted, true);
  assert.match(risk.haltReason, /perte journaliere/);
  assert.equal(risk.canOpen({ now: NOW, openPositions: [], exposure: 0, marketId: 'b', notional: 10 }).ok, false);
});

test('une serie de pertes arrete le moteur meme sous la limite de perte', () => {
  const risk = new RiskManager(cfg());
  for (let i = 0; i < 3; i += 1) risk.recordClose(-1, NOW);
  assert.equal(risk.halted, true);
  assert.match(risk.haltReason, /consecutives/);
});

test('un gain remet le compteur de pertes consecutives a zero', () => {
  const risk = new RiskManager(cfg());
  risk.recordClose(-1, NOW);
  risk.recordClose(-1, NOW);
  risk.recordClose(+1, NOW);
  risk.recordClose(-1, NOW);
  assert.equal(risk.halted, false);
});

test('le changement de journee libere un arret journalier, pas un arret manuel', () => {
  const risk = new RiskManager(cfg());
  risk.recordClose(-60, NOW);
  assert.equal(risk.halted, true);
  const lendemain = NOW + 24 * 3600_000;
  assert.equal(risk.canOpen({ now: lendemain, openPositions: [], exposure: 0, marketId: 'c', notional: 10 }).ok, true);
  assert.equal(risk.realizedPnl, 0, 'le resultat journalier repart de zero');

  risk.halt('intervention manuelle');
  const surlendemain = NOW + 48 * 3600_000;
  assert.equal(risk.canOpen({ now: surlendemain, openPositions: [], exposure: 0, marketId: 'c', notional: 10 }).ok, false);
});

test('le portefeuille calcule le resultat net des frais', () => {
  const pf = new Portfolio();
  const market = { id: 'm', question: 'test' };
  const signal = { token: 'YES', outcome: 'YES', fairProb: 0.6, sideProb: 0.6, netEdge: 0.05, impulse: 0.1, bookStalenessMs: 900, spot: 1, strike: 1, bookTopChanges: 2 };
  pf.openPosition({ market, signal, fill: { filled: 100, avgPrice: 0.5, fee: 1 }, now: NOW });
  assert.equal(pf.exposure, 50);

  const rec = pf.closePosition({ marketId: 'm', exitPrice: 0.56, exitFee: 1, reason: 'test', now: NOW + 30_000 });
  // 100 x (0,56 - 0,50) = 6, moins 1 de frais d'entree et 1 de sortie.
  assert.ok(Math.abs(rec.pnl - 4) < 1e-9, `resultat ${rec.pnl}`);
  assert.equal(rec.holdMs, 30_000);
  assert.equal(pf.positions.size, 0);
});

test('une sortie partielle laisse le reliquat ouvert', () => {
  const pf = new Portfolio();
  const market = { id: 'm', question: 'test' };
  const signal = { token: 'YES', outcome: 'YES', netEdge: 0.05, bookTopChanges: 0 };
  pf.openPosition({ market, signal, fill: { filled: 100, avgPrice: 0.5, fee: 0 }, now: NOW });
  pf.closePosition({ marketId: 'm', exitPrice: 0.6, reason: 'partielle', now: NOW + 1_000, filledShares: 40 });

  const reste = pf.positions.get('m');
  assert.ok(reste, 'le reliquat doit rester ouvert');
  assert.ok(Math.abs(reste.shares - 60) < 1e-9);
  assert.ok(Math.abs(pf.realizedPnl - 4) < 1e-9);
});

test('la position memorise l\'etat du carnet a l\'entree', () => {
  const pf = new Portfolio();
  pf.openPosition({
    market: { id: 'm', question: 'test' },
    signal: { token: 'YES', outcome: 'YES', netEdge: 0.05, bookTopChanges: 7 },
    fill: { filled: 10, avgPrice: 0.5, fee: 0 },
    now: NOW,
  });
  assert.equal(pf.positions.get('m').entryTopChanges, 7);
});
