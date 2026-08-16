import { LocalBookStore } from './local-books.js';
import { probAbove } from '../model/pricer.js';
import { clamp } from '../util/stats.js';

const YEAR_SEC = 365 * 24 * 3600;

/** Generateur pseudo-aleatoire deterministe (mulberry32) : rejeu reproductible. */
export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deux tirages uniformes -> un tirage normal centre reduit (Box-Muller). */
function gauss(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Marche synthetique : un prix BTC qui suit un mouvement brownien geometrique
 * avec sauts, et un carnet Polymarket qui suit la juste valeur AVEC UN RETARD
 * configurable.
 *
 * Le parametre `lagMs` est la raison d'etre du simulateur : il permet de
 * verifier que le moteur gagne quand le retard existe, et — c'est le test qui
 * compte vraiment — qu'il ne gagne pas quand `lagMs = 0`. Une strategie qui
 * gagne aussi sans retard ne fait pas de l'arbitrage : elle parie.
 */
export class MarketSimulator {
  constructor({
    seed = 42,
    startPrice = 100_000,
    volAnnual = 0.55,
    jumpProbPerStep = 0.00006,
    jumpSizePct = 0.0018,
    lagMs = 2_000,
    spreadTicks = 2,
    tick = 0.01,
    depthShares = 400,
    quoteNoise = 0.004,
    horizonMs = 3600_000,
    stepMs = 100,
    startTs = Date.UTC(2026, 0, 1, 12, 0, 0),
  } = {}) {
    this.rand = rng(seed);
    this.params = { startPrice, volAnnual, jumpProbPerStep, jumpSizePct, lagMs, spreadTicks, tick, depthShares, quoteNoise, stepMs };
    this.ts = startTs;
    this.price = startPrice;
    this.strike = startPrice;
    this.expiryTs = startTs + horizonMs;
    this.books = new LocalBookStore();
    this.fairHistory = [{ ts: startTs, prob: 0.5 }];
    // Curseur de lecture : les requetes de retard avancent dans le temps, donc
    // un simple pointeur glissant remplace une recherche a chaque pas.
    this.fairCursor = 0;

    this.market = {
      id: 'sim-btc-updown',
      slug: 'sim-btc-updown',
      question: 'Simulation : Bitcoin Up or Down (horaire)',
      kind: 'updown',
      side: 'above',
      strike: this.strike,
      periodMs: horizonMs,
      expiryTs: this.expiryTs,
      tokenYes: 'SIM-YES',
      tokenNo: 'SIM-NO',
      outcomes: ['Up', 'Down'],
      minTickSize: tick,
      negRisk: false,
      liquidity: depthShares * 100,
      volume24h: 1_000_000,
    };
  }

  /**
   * Volatilite reellement produite par le processus : diffusion + sauts.
   *
   * Utiliser la seule volatilite de diffusion pour valoriser un processus qui
   * saute rend le simulateur incoherent avec lui-meme — et fait croire a une
   * marge la ou il n'y a qu'une erreur de modele.
   */
  get effectiveVolAnnual() {
    const { volAnnual, jumpProbPerStep, jumpSizePct, stepMs } = this.params;
    const varDiffusionPerSec = volAnnual ** 2 / YEAR_SEC;
    const jumpsPerSec = jumpProbPerStep / (stepMs / 1000);
    const varJumpPerSec = jumpsPerSec * jumpSizePct ** 2;
    return Math.sqrt((varDiffusionPerSec + varJumpPerSec) * YEAR_SEC);
  }

  /** Juste probabilite vraie (celle que le simulateur connait, pas celle estimee). */
  trueFair(ts = this.ts, price = this.price) {
    return probAbove({
      spot: price,
      strike: this.strike,
      timeToExpiryMs: this.expiryTs - ts,
      volAnnual: this.effectiveVolAnnual,
    });
  }

  #fairAgo(ms) {
    const target = this.ts - ms;
    while (
      this.fairCursor + 1 < this.fairHistory.length &&
      this.fairHistory[this.fairCursor + 1].ts <= target
    ) {
      this.fairCursor += 1;
    }
    return this.fairHistory[this.fairCursor].prob;
  }

  /**
   * Avance d'un pas : diffusion du spot, puis republication du carnet a partir
   * d'une juste valeur retardee.
   * @returns {{ts: number, price: number, quotes: object[]}}
   */
  step() {
    const { stepMs, volAnnual, jumpProbPerStep, jumpSizePct, lagMs } = this.params;
    const dt = stepMs / 1000 / YEAR_SEC;
    let ret = volAnnual * Math.sqrt(dt) * gauss(this.rand) - 0.5 * volAnnual ** 2 * dt;
    if (this.rand() < jumpProbPerStep) {
      // Saut : c'est le moment ou le retard de Polymarket devient exploitable.
      ret += (this.rand() < 0.5 ? -1 : 1) * jumpSizePct;
    }
    this.price *= Math.exp(ret);
    this.ts += stepMs;

    this.fairHistory.push({ ts: this.ts, prob: this.trueFair() });
    // Purge du passe devenu inutile, en gardant le curseur coherent.
    if (this.fairCursor > 10_000) {
      this.fairHistory.splice(0, this.fairCursor);
      this.fairCursor = 0;
    }

    // Le carnet Polymarket reflete la juste valeur telle qu'elle etait il y a
    // `lagMs`, plus un bruit de cotation.
    const laggedFair = this.#fairAgo(lagMs);
    this.#publishBook(laggedFair);

    // Les deux places recoivent le meme prix a un bruit de microstructure pres.
    const quotes = ['binance', 'coinbase'].map((venue) => {
      const jitter = 1 + (this.rand() - 0.5) * 0.00004;
      const mid = this.price * jitter;
      const half = mid * 0.00002;
      return { venue, bid: mid - half, ask: mid + half, mid, ts: this.ts };
    });
    return { ts: this.ts, price: this.price, quotes };
  }

  #publishBook(fair) {
    const { tick, spreadTicks, depthShares, quoteNoise } = this.params;
    const noisy = clamp(fair + (this.rand() - 0.5) * 2 * quoteNoise, 0.01, 0.99);
    const mid = Math.round(noisy / tick) * tick;
    const half = (spreadTicks * tick) / 2;

    const levels = (start, dir) => Array.from({ length: 5 }, (_, i) => ({
      price: Number((start + dir * i * tick).toFixed(4)),
      size: depthShares * (i === 0 ? 1 : 0.6 / i),
    })).filter((l) => l.price > 0 && l.price < 1);

    const bids = levels(Number((mid - half).toFixed(4)), -1);
    const asks = levels(Number((mid + half).toFixed(4)), +1);
    this.books.set(this.market.tokenYes, { bids, asks, ts: this.ts });
    // Jeton complementaire : prix miroir, memes tailles.
    this.books.set(this.market.tokenNo, {
      bids: asks.map((l) => ({ price: Number((1 - l.price).toFixed(4)), size: l.size })),
      asks: bids.map((l) => ({ price: Number((1 - l.price).toFixed(4)), size: l.size })),
      ts: this.ts,
    });
  }

  /** Resolution du marche a l'echeance : 1 si le prix final depasse le seuil. */
  settle() {
    return this.price > this.strike ? 1 : 0;
  }
}
