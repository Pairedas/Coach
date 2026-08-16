import test from 'node:test';
import assert from 'node:assert/strict';
import { runOneSim, runSimBatch } from '../src/runners/sim.js';
import { validateConfig, withOverrides } from '../src/config.js';

/**
 * Test central du projet.
 *
 * Une strategie d'arbitrage de latence doit gagner UNIQUEMENT grace au retard.
 * On compare donc un marche retarde a un marche identique sans retard : si le
 * second rapporte autant, le moteur ne fait pas de l'arbitrage, il parie.
 */
test('le moteur exploite un retard de 3 s et s\'abstient sans retard', { timeout: 120_000 }, () => {
  const avecRetard = runSimBatch({ runs: 8, lagMs: 3_000, minutes: 60 });
  const sansRetard = runSimBatch({ runs: 8, lagMs: 0, minutes: 60 });

  assert.ok(avecRetard.totalTrades > 20, `trop peu d'operations : ${avecRetard.totalTrades}`);
  assert.ok(avecRetard.winRate > 0.6, `taux de reussite trop faible : ${avecRetard.winRate}`);
  assert.ok(avecRetard.pnlMedian > 0, 'la mediane doit etre positive quand le retard existe');

  assert.ok(
    sansRetard.totalTrades < avecRetard.totalTrades / 5,
    `sans retard, le moteur devrait quasiment ne pas traiter (${sansRetard.totalTrades} operations)`,
  );
  assert.ok(
    sansRetard.pnlMean < avecRetard.pnlMean / 5,
    'sans retard, le resultat doit s\'effondrer',
  );
});

test('les positions sont toutes denouees en fin de session', { timeout: 60_000 }, () => {
  const r = runOneSim({ seed: 3, lagMs: 3_000, minutes: 60 });
  assert.equal(r.openPositions, 0);
  assert.equal(r.exposure, 0);
});

test('la duree de detention se compte en secondes, pas en heures', { timeout: 60_000 }, () => {
  const b = runSimBatch({ runs: 5, lagMs: 3_000, minutes: 60 });
  assert.ok(b.avgHoldSec > 0 && b.avgHoldSec < 300, `duree moyenne inattendue : ${b.avgHoldSec} s`);
});

test('les plafonds de risque tiennent pendant toute une session', { timeout: 60_000 }, () => {
  const r = runOneSim({
    seed: 11,
    lagMs: 5_000,
    minutes: 60,
    overrides: { risk: { maxNotionalPerMarket: 40, maxTotalNotional: 40, bankroll: 1_000 } },
  });
  assert.ok(r.trades > 0, 'la session doit produire des operations');
  assert.ok(r.exposure <= 40 + 1e-9);
});

test('une configuration incoherente est refusee au demarrage', () => {
  assert.throws(() => validateConfig(withOverrides({ strategy: { minEdge: 0.001, exitEdge: 0.01 } })), /MIN_EDGE/);
  assert.throws(() => validateConfig(withOverrides({ risk: { minNotional: 500, maxNotionalPerMarket: 100 } })), /MIN_NOTIONAL/);
  assert.throws(
    () => validateConfig(withOverrides({ exec: { live: true, liveConfirm: '' } })),
    /LIVE_CONFIRM/,
  );
});
