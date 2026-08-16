import { withOverrides, validateConfig } from '../config.js';
import { MarketSimulator } from '../replay/simulator.js';
import { PaperBroker } from '../exec/paper.js';
import { Engine } from '../engine.js';
import { mean, quantile } from '../util/stats.js';

/**
 * Une session simulee complete, du premier tick a la resolution du marche.
 * Les positions encore ouvertes a l'echeance sont denouees a la valeur de
 * resolution (0 ou 1) : ignorer ce reglage flatterait artificiellement le
 * resultat.
 */
export function runOneSim({ seed = 1, lagMs = 2_000, minutes = 60, overrides = {} } = {}) {
  const cfg = validateConfig(withOverrides(overrides));
  const sim = new MarketSimulator({ seed, lagMs, horizonMs: minutes * 60_000 });
  const broker = new PaperBroker(cfg);
  const engine = new Engine(cfg, { broker, bookProvider: sim.books, now: () => sim.ts });
  engine.setMarkets([sim.market]);

  const steps = Math.floor((minutes * 60_000) / sim.params.stepMs);
  for (let i = 0; i < steps; i += 1) {
    const { quotes } = sim.step();
    for (const q of quotes) engine.spot.onQuote(q);
    engine.step(sim.ts);
  }

  // Reglage des positions residuelles a la valeur terminale du marche.
  const settlementYes = sim.settle();
  for (const position of engine.portfolio.open) {
    const value = position.outcome === 'YES' ? settlementYes : 1 - settlementYes;
    engine.portfolio.closePosition({
      marketId: position.marketId,
      exitPrice: value,
      reason: 'resolution du marche',
      now: sim.ts,
    });
  }

  const stats = engine.portfolio.stats();
  return {
    seed,
    lagMs,
    ...stats,
    finalPrice: sim.price,
    strike: sim.strike,
    rejections: Object.fromEntries(engine.strategy.rejections),
    counters: engine.snapshot().counters,
  };
}

/** Agrege plusieurs graines : une seule session ne prouve rien. */
export function runSimBatch({ runs = 20, lagMs = 2_000, minutes = 60, overrides = {} } = {}) {
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    results.push(runOneSim({ seed: 1_000 + i, lagMs, minutes, overrides }));
  }
  const pnls = results.map((r) => r.realizedPnl);
  const trades = results.reduce((s, r) => s + r.trades, 0);
  const wins = results.reduce((s, r) => s + r.wins, 0);
  return {
    runs,
    lagMs,
    minutes,
    totalTrades: trades,
    tradesPerRun: trades / runs,
    winRate: trades ? wins / trades : 0,
    pnlMean: mean(pnls),
    pnlMedian: quantile(pnls, 0.5),
    pnlP05: quantile(pnls, 0.05),
    pnlP95: quantile(pnls, 0.95),
    pnlWorst: Math.min(...pnls),
    pnlBest: Math.max(...pnls),
    profitableRuns: pnls.filter((p) => p > 0).length,
    avgHoldSec: mean(results.filter((r) => r.trades > 0).map((r) => r.avgHoldSec)),
    results,
  };
}
