/** Fonction d'erreur (Abramowitz & Stegun 7.1.26), erreur max ~1.5e-7. */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return sign * y;
}

/** Loi normale centree reduite cumulee. */
export function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Variance exponentiellement ponderee des log-rendements, normalisee par seconde.
 *
 * Les rendements sont echantillonnes sur une grille de `minSampleMs` et non a
 * chaque tick. C'est essentiel : le bruit de microstructure (rebond entre bid et
 * ask, gigue entre places) domine les vrais rendements a tres haute frequence et
 * gonfle la volatilite realisee d'un facteur deux ou plus. Une volatilite
 * surestimee ecrase le juste prix vers 0,5 et fausse toute la valorisation.
 */
export class EwmaVol {
  /**
   * @param {number} halfLifeSec demi-vie du poids accorde aux observations passees
   * @param {number} seedVolPerSec ecart-type initial par seconde (avant toute observation)
   * @param {number} minSampleMs pas d'echantillonnage minimal des rendements
   */
  constructor(halfLifeSec = 120, seedVolPerSec = 0.0004, minSampleMs = 1_000) {
    this.halfLifeSec = halfLifeSec;
    this.variance = seedVolPerSec ** 2;
    this.minSampleMs = minSampleMs;
    this.samples = 0;
    this.lastPrice = null;
    this.lastTs = null;
  }

  /** Ajoute un tick de prix ; n'echantillonne qu'au-dela du pas minimal. */
  update(price, ts) {
    if (!(price > 0) || !Number.isFinite(ts)) return;
    if (this.lastPrice === null) {
      this.lastPrice = price;
      this.lastTs = ts;
      return;
    }
    const dtSec = (ts - this.lastTs) / 1000;
    if (dtSec * 1000 < this.minSampleMs) return;
    const r = Math.log(price / this.lastPrice);
    this.lastPrice = price;
    this.lastTs = ts;
    // Variance par seconde de ce pas, puis melange EWMA pondere par la duree du pas.
    const perSec = (r * r) / dtSec;
    const lambda = Math.pow(0.5, dtSec / this.halfLifeSec);
    this.variance = lambda * this.variance + (1 - lambda) * perSec;
    this.samples += 1;
  }

  /** Ecart-type par seconde. */
  get volPerSec() {
    return Math.sqrt(Math.max(this.variance, 1e-12));
  }

  /** Ecart-type annualise (365 j x 24 h, le BTC ne ferme jamais). */
  get volAnnual() {
    return this.volPerSec * Math.sqrt(365 * 24 * 3600);
  }
}

/**
 * Historique de prix borne dans le temps, pour retrouver le prix « tel qu'il etait
 * il y a N millisecondes » — c'est la base de la detection de retard.
 */
export class PriceHistory {
  constructor(windowMs = 120_000) {
    this.windowMs = windowMs;
    this.points = []; // { ts, price } croissant en ts
  }

  push(ts, price) {
    if (!(price > 0)) return;
    const last = this.points.at(-1);
    if (last && ts < last.ts) return; // on ignore les ticks arrives dans le desordre
    this.points.push({ ts, price });
    const cutoff = ts - this.windowMs;
    let drop = 0;
    while (drop + 1 < this.points.length && this.points[drop + 1].ts < cutoff) drop += 1;
    if (drop > 0) this.points.splice(0, drop);
  }

  /** Dernier prix connu a l'instant `ts` (null si l'historique ne remonte pas assez loin). */
  priceAt(ts) {
    if (this.points.length === 0) return null;
    if (ts < this.points[0].ts) return null;
    let lo = 0;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.points[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return this.points[lo].price;
  }

  get latest() {
    return this.points.at(-1) ?? null;
  }
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Quantile par interpolation lineaire (xs non trie accepte). */
export function quantile(xs, q) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
