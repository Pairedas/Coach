import { EventEmitter } from 'node:events';
import { EwmaVol, PriceHistory } from '../util/stats.js';
import { logger } from '../util/log.js';

const SEC_PER_YEAR = 365 * 24 * 3600;

/**
 * Bande consolidee : fusionne plusieurs places en un seul prix de reference,
 * entretient la volatilite realisee et l'historique court utilise par la
 * detection de retard.
 *
 * Une place qui cesse d'emettre est automatiquement exclue du prix consolide :
 * un flux fige est la premiere cause de faux signaux d'arbitrage.
 */
export class SpotTape extends EventEmitter {
  constructor({ weights, stalenessMs, historyMs, volHalfLifeSec, seedVolAnnual, volSampleMs = 1_000 }) {
    super();
    this.weights = { ...weights };
    this.stalenessMs = stalenessMs;
    this.log = logger('spot');
    this.venues = new Map(); // venue -> { bid, ask, mid, ts }
    this.history = new PriceHistory(historyMs);
    this.vol = new EwmaVol(volHalfLifeSec, seedVolAnnual / Math.sqrt(SEC_PER_YEAR), volSampleMs);
    this.consolidated = null; // { price, ts, venues: [...] }
    this.updates = 0;
  }

  /** Branche un flux (BinanceFeed, CoinbaseFeed, ou tout emetteur de `quote`). */
  attach(feed) {
    feed.on('quote', (q) => this.onQuote(q));
    return this;
  }

  onQuote(q) {
    if (!(q?.mid > 0)) return;
    this.venues.set(q.venue, { bid: q.bid, ask: q.ask, mid: q.mid, ts: q.ts });
    this.#recompute(q.ts);
  }

  #recompute(ts) {
    let weightSum = 0;
    let priceSum = 0;
    const live = [];
    for (const [venue, q] of this.venues) {
      if (ts - q.ts > this.stalenessMs) continue;
      const w = this.weights[venue] ?? 0;
      if (w <= 0) continue;
      weightSum += w;
      priceSum += w * q.mid;
      live.push(venue);
    }
    if (weightSum <= 0) {
      if (this.consolidated) this.log.warn('toutes les places sont figees, prix consolide suspendu');
      this.consolidated = null;
      return;
    }
    const price = priceSum / weightSum;
    this.consolidated = { price, ts, venues: live };
    this.history.push(ts, price);
    this.vol.update(price, ts);
    this.updates += 1;
    this.emit('tick', this.consolidated);
  }

  get price() { return this.consolidated?.price ?? null; }
  get volAnnual() { return this.vol.volAnnual; }

  /** Prix consolide tel qu'il etait il y a `ms` millisecondes. */
  priceAgo(ms, now = Date.now()) { return this.history.priceAt(now - ms); }

  /** Vrai si aucune place vivante n'alimente le prix depuis `stalenessMs`. */
  isStale(now = Date.now()) {
    return !this.consolidated || now - this.consolidated.ts > this.stalenessMs;
  }

  /** Ecart entre places, en points de base : un ecart anormal signale un flux douteux. */
  venueSpreadBps() {
    const mids = [...this.venues.values()].map((v) => v.mid).filter((m) => m > 0);
    if (mids.length < 2) return 0;
    const lo = Math.min(...mids);
    const hi = Math.max(...mids);
    return ((hi - lo) / lo) * 10_000;
  }

  snapshot() {
    return {
      price: this.price,
      ts: this.consolidated?.ts ?? null,
      venues: Object.fromEntries(this.venues),
      volAnnual: this.volAnnual,
      venueSpreadBps: this.venueSpreadBps(),
      updates: this.updates,
    };
  }
}
