import { logger } from './util/log.js';

/** Suivi des positions et du resultat, identique en papier et en reel. */
export class Portfolio {
  constructor() {
    this.log = logger('portefeuille');
    this.positions = new Map(); // marketId -> position
    this.closed = [];
    this.realizedPnl = 0;
    this.fees = 0;
  }

  get open() { return [...this.positions.values()]; }
  get exposure() { return this.open.reduce((sum, p) => sum + p.shares * p.entryPrice, 0); }

  openPosition({ market, signal, fill, now }) {
    const position = {
      marketId: market.id,
      question: market.question,
      token: signal.token,
      outcome: signal.outcome,
      shares: fill.filled,
      entryPrice: fill.avgPrice,
      notional: fill.filled * fill.avgPrice,
      entryFee: fill.fee ?? 0,
      openedTs: now,
      entryTopChanges: signal.bookTopChanges ?? 0,
      entrySignal: {
        fairProb: signal.fairProb,
        sideProb: signal.sideProb,
        netEdge: signal.netEdge,
        impulse: signal.impulse,
        bookStalenessMs: signal.bookStalenessMs,
        spot: signal.spot,
        strike: signal.strike,
      },
    };
    this.positions.set(market.id, position);
    this.fees += position.entryFee;
    this.log.info(
      `OUVERTURE ${position.outcome} ${position.shares.toFixed(1)} @ ${position.entryPrice.toFixed(4)} ` +
      `(marge ${(signal.netEdge * 100).toFixed(1)} pts) — ${truncate(market.question)}`,
    );
    return position;
  }

  closePosition({ marketId, exitPrice, exitFee = 0, reason, now, filledShares = null }) {
    const p = this.positions.get(marketId);
    if (!p) return null;
    const shares = filledShares ?? p.shares;
    const gross = shares * (exitPrice - p.entryPrice);
    const pnl = gross - exitFee - p.entryFee * (shares / p.shares);

    // Sortie partielle : on garde le reliquat ouvert plutot que de le supposer vendu.
    if (shares < p.shares - 1e-9) {
      p.shares -= shares;
      p.notional = p.shares * p.entryPrice;
    } else {
      this.positions.delete(marketId);
    }

    this.realizedPnl += pnl;
    this.fees += exitFee;
    const record = {
      ...p,
      shares,
      exitPrice,
      pnl,
      reason,
      closedTs: now,
      holdMs: now - p.openedTs,
    };
    this.closed.push(record);
    this.log.info(
      `CLOTURE ${p.outcome} ${shares.toFixed(1)} @ ${exitPrice.toFixed(4)} — ` +
      `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC (${reason}, ${Math.round(record.holdMs / 1000)} s)`,
    );
    return record;
  }

  stats() {
    const wins = this.closed.filter((c) => c.pnl > 0);
    const losses = this.closed.filter((c) => c.pnl <= 0);
    const holds = this.closed.map((c) => c.holdMs);
    return {
      trades: this.closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.closed.length ? wins.length / this.closed.length : 0,
      realizedPnl: this.realizedPnl,
      fees: this.fees,
      avgPnl: this.closed.length ? this.realizedPnl / this.closed.length : 0,
      avgHoldSec: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length / 1000 : 0,
      openPositions: this.positions.size,
      exposure: this.exposure,
    };
  }
}

function truncate(s, n = 70) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
