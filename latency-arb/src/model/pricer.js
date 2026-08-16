import { normCdf, clamp } from '../util/stats.js';

const YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * Probabilite risque-neutre que S_T > K sous un mouvement brownien geometrique
 * sans derive : P = N(d2), d2 = (ln(S/K) - sigma^2 tau / 2) / (sigma sqrt(tau)).
 *
 * La derive est volontairement nulle : parier sur la direction du BTC n'est pas
 * la strategie. On ne modelise que la dispersion du prix d'ici l'echeance.
 *
 * @param {object} p
 * @param {number} p.spot prix spot courant
 * @param {number} p.strike seuil du marche (prix d'ouverture pour un marche « up/down »)
 * @param {number} p.timeToExpiryMs temps restant en millisecondes
 * @param {number} p.volAnnual volatilite annualisee
 * @returns {number} probabilite dans [0,1]
 */
export function probAbove({ spot, strike, timeToExpiryMs, volAnnual }) {
  if (!(spot > 0) || !(strike > 0)) return NaN;
  if (!(volAnnual > 0)) return NaN;
  if (timeToExpiryMs <= 0) return spot > strike ? 1 : 0;

  const tau = timeToExpiryMs / YEAR_MS;
  const sigmaSqrtTau = volAnnual * Math.sqrt(tau);
  if (sigmaSqrtTau < 1e-12) return spot > strike ? 1 : 0;

  const d2 = (Math.log(spot / strike) - 0.5 * volAnnual ** 2 * tau) / sigmaSqrtTau;
  return clamp(normCdf(d2), 0, 1);
}

/** Probabilite que S_T < K — complement exact de probAbove. */
export function probBelow(args) {
  const p = probAbove(args);
  return Number.isFinite(p) ? 1 - p : NaN;
}

/**
 * Sensibilite de la probabilite au prix spot (dP/dS), utile pour convertir un
 * mouvement du BTC en mouvement attendu des cotes, et pour dimensionner un stop.
 */
export function probDelta({ spot, strike, timeToExpiryMs, volAnnual }) {
  if (!(spot > 0) || !(strike > 0) || !(volAnnual > 0) || timeToExpiryMs <= 0) return 0;
  const tau = timeToExpiryMs / YEAR_MS;
  const sigmaSqrtTau = volAnnual * Math.sqrt(tau);
  if (sigmaSqrtTau < 1e-12) return 0;
  const d2 = (Math.log(spot / strike) - 0.5 * volAnnual ** 2 * tau) / sigmaSqrtTau;
  const pdf = Math.exp(-0.5 * d2 * d2) / Math.sqrt(2 * Math.PI);
  return pdf / (spot * sigmaSqrtTau);
}

/**
 * Valorise un marche donne a partir d'un prix spot. Renvoie la probabilite du
 * cote YES tel que defini par le marche (`side` = 'above' ou 'below').
 */
export function fairProbability(market, { spot, volAnnual, now }) {
  const timeToExpiryMs = market.expiryTs - now;
  const args = { spot, strike: market.strike, timeToExpiryMs, volAnnual };
  const p = market.side === 'below' ? probBelow(args) : probAbove(args);
  return { prob: p, timeToExpiryMs, delta: probDelta(args) * (market.side === 'below' ? -1 : 1) };
}
