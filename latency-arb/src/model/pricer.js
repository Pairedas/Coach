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

  // Fourchette : P(K1 < S < K2) = N(d2(K1)) - N(d2(K2)). Exact sous le meme
  // modele, aucune approximation supplementaire.
  if (market.side === 'inside') {
    if (!(market.strikeHigh > market.strike)) return { prob: NaN, timeToExpiryMs, delta: 0 };
    const haut = { ...args, strike: market.strikeHigh };
    const prob = probAbove(args) - probAbove(haut);
    return {
      prob: Number.isFinite(prob) ? clamp(prob, 0, 1) : NaN,
      timeToExpiryMs,
      delta: probDelta(args) - probDelta(haut),
    };
  }

  const p = market.side === 'below' ? probBelow(args) : probAbove(args);
  return { prob: p, timeToExpiryMs, delta: probDelta(args) * (market.side === 'below' ? -1 : 1) };
}

/**
 * Volatilite implicite : quelle volatilite annualisee rend la cote du marche
 * juste ? Obtenue par dichotomie, N(d2) etant monotone en sigma de chaque cote
 * de la monnaie.
 *
 * C'est l'outil de calibration le plus direct : si la volatilite implicite du
 * marche s'ecarte franchement de la volatilite realisee que l'on mesure, ce
 * n'est pas une opportunite, c'est un desaccord de modele. Et sur un marche
 * liquide, celui qui se trompe est rarement le marche.
 *
 * @returns {number|null} null si la volatilite n'est pas identifiable
 */
export function impliedVolAbove({ spot, strike, timeToExpiryMs, prob }) {
  if (!(spot > 0) || !(strike > 0) || !(timeToExpiryMs > 0)) return null;
  // Une cote posee exactement sur le plancher ou le plafond du pas de cotation
  // (0,001 sur Polymarket) n'apprend rien : toute volatilite faible l'explique.
  // Au-dessus, l'inversion est possible — bruitee, mais informative.
  if (!(prob > 0.001) || !(prob < 0.999)) return null;
  // A la monnaie, N(d2) vaut ~0,5 quelle que soit la volatilite : rien a inverser.
  if (Math.abs(Math.log(spot / strike)) < 1e-6) return null;

  const f = (v) => probAbove({ spot, strike, timeToExpiryMs, volAnnual: v }) - prob;
  let lo = 0.01;
  let hi = 5;
  let flo = f(lo);
  if (flo * f(hi) > 0) return null; // la cote est hors de portee du modele

  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (flo * fm <= 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}
