/**
 * Normalisation des marches Polymarket en objets valorisables.
 *
 * Regle de prudence : tout marche que l'on ne sait pas valoriser proprement est
 * rejete avec un motif. Un marche mal compris coute plus cher qu'un marche rate.
 */

// Marches a barriere (« touche X avant l'echeance ») : le payoff depend du
// maximum du chemin, pas du prix final. N(d2) y est faux, on les ecarte.
const BARRIER_PATTERNS = [/\bdip to\b/i, /\breach\b/i, /\bhit\b/i, /\btouch\b/i, /\ball[- ]time high\b/i];
const ABOVE_PATTERNS = [/\babove\b/i, /\bgreater than\b/i, /\bmore than\b/i, /\bexceed/i, /\bau[- ]dessus\b/i, /\b>=?\s*\$/];
const BELOW_PATTERNS = [/\bbelow\b/i, /\bless than\b/i, /\bunder\b/i, /\ben[- ]dessous\b/i, /\b<=?\s*\$/];
const UPDOWN_PATTERNS = [/\bup or down\b/i, /\bup\b.*\bdown\b/i, /\bhigher\b.*\blower\b/i];
// « between $62,000 and $64,000 » : payoff a fourchette, valorisable exactement
// comme une difference de deux digitaux.
const RANGE_PATTERN = /\bbetween\b\s*(\$\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kKmM]?)\s*\band\b\s*(\$\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kKmM]?)/i;
// « 11:35AM-11:40AM ET » : plage horaire explicite, donc duree explicite.
const TIME_RANGE_PATTERN = /(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;

/** Convertit « $118,500 », « 118.5k », « 120K » en nombre. */
export function parseMoney(raw) {
  if (!raw) return NaN;
  const m = String(raw).match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?/);
  if (!m) return NaN;
  const value = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return NaN;
  const suffix = m[2]?.toLowerCase();
  if (suffix === 'k') return value * 1_000;
  if (suffix === 'm') return value * 1_000_000;
  return value;
}

/** Extrait le seuil monetaire d'une question (premier montant plausible). */
export function parseStrike(question) {
  const matches = String(question).match(/\$\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[kKmM]?/g);
  if (!matches?.length) return NaN;
  for (const raw of matches) {
    const v = parseMoney(raw);
    // Un seuil BTC plausible : entre 1 000 et 10 000 000 USD.
    if (v >= 1_000 && v <= 10_000_000) return v;
  }
  return NaN;
}

/** Les identifiants de jetons CLOB arrivent parfois en chaine JSON. */
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {object} raw marche brut renvoye par l'API Gamma
 * @returns {{ok: true, market: object} | {ok: false, reason: string}}
 */
export function parseMarket(raw) {
  const question = raw?.question ?? raw?.title ?? '';
  if (!question) return { ok: false, reason: 'question absente' };

  if (BARRIER_PATTERNS.some((re) => re.test(question))) {
    return { ok: false, reason: 'marche a barriere (payoff dependant du chemin)' };
  }

  const tokenIds = parseJsonArray(raw.clobTokenIds);
  const outcomes = parseJsonArray(raw.outcomes);
  if (tokenIds.length < 2) return { ok: false, reason: 'identifiants de jetons CLOB absents' };

  const endRaw = raw.endDate ?? raw.end_date_iso ?? raw.endDateIso;
  const expiryTs = endRaw ? Date.parse(endRaw) : NaN;
  if (!Number.isFinite(expiryTs)) return { ok: false, reason: 'echeance illisible' };

  const isUpDown = UPDOWN_PATTERNS.some((re) => re.test(question));
  const strike = parseStrike(question);
  const plage = question.match(RANGE_PATTERN);

  let kind;
  let side;
  let strikeHigh = null;
  if (plage) {
    // P(K1 < S < K2) = N(d2(K1)) - N(d2(K2)) : exact sous le meme modele.
    const bas = parseMoney(plage[1]);
    const haut = parseMoney(plage[2]);
    if (!(bas > 0) || !(haut > bas)) return { ok: false, reason: 'fourchette illisible' };
    kind = 'range';
    side = 'inside';
    strikeHigh = haut;
  } else if (Number.isFinite(strike)) {
    kind = 'threshold';
    const below = BELOW_PATTERNS.some((re) => re.test(question));
    const above = ABOVE_PATTERNS.some((re) => re.test(question));
    if (below && !above) side = 'below';
    else if (above) side = 'above';
    else return { ok: false, reason: 'sens du seuil ambigu' };
  } else if (isUpDown) {
    // Le seuil est le prix d'ouverture de la periode : renseigne plus tard.
    kind = 'updown';
    side = 'above';
  } else {
    return { ok: false, reason: 'ni seuil chiffre ni marche up/down' };
  }

  // L'indice 0 correspond au premier resultat declare (« Yes » / « Up »).
  const yesIndex = outcomes.findIndex((o) => /^(yes|up|oui)$/i.test(String(o).trim()));
  const idxYes = yesIndex >= 0 ? yesIndex : 0;
  const idxNo = idxYes === 0 ? 1 : 0;

  return {
    ok: true,
    market: {
      id: raw.conditionId ?? raw.condition_id ?? raw.id,
      slug: raw.slug ?? '',
      question,
      kind,
      side,
      strike: kind === 'range' ? parseMoney(plage[1]) : (Number.isFinite(strike) ? strike : null),
      // Borne haute, renseignee uniquement pour les marches a fourchette.
      strikeHigh,
      // Duree de la periode pour un marche up/down horaire, utilisee pour
      // retrouver le prix d'ouverture de reference.
      periodMs: kind === 'updown' ? inferPeriodMs(question) : null,
      expiryTs,
      tokenYes: String(tokenIds[idxYes]),
      tokenNo: String(tokenIds[idxNo]),
      outcomes: outcomes.length ? outcomes.map(String) : ['Yes', 'No'],
      minTickSize: Number(raw.orderPriceMinTickSize ?? raw.minimum_tick_size ?? 0.001),
      negRisk: Boolean(raw.negRisk ?? raw.neg_risk ?? false),
      liquidity: Number(raw.liquidityNum ?? raw.liquidity ?? 0),
      volume24h: Number(raw.volume24hr ?? raw.volume_24hr ?? 0),
    },
  };
}

/** Duree de la periode d'un marche up/down, deduite du libelle. */
function inferPeriodMs(question) {
  // Une plage horaire explicite prime sur toute heuristique : « 11:35AM-11:40AM »
  // dure cinq minutes, pas une heure. Se tromper de periode, c'est reconstruire
  // le seuil sur la mauvaise bougie — et donc inverser le signe de la marge.
  const plage = question.match(TIME_RANGE_PATTERN);
  if (plage) {
    const [, h1, m1, ap1, h2, m2, ap2] = plage;
    const debut = toMinutes(h1, m1, ap1 ?? ap2);
    const fin = toMinutes(h2, m2, ap2);
    let duree = fin - debut;
    if (duree < 0) duree += 24 * 60; // la plage franchit minuit
    if (duree > 0) return duree * 60_000;
  }
  if (/\bhourly\b|\bhour\b|\b\d{1,2}\s?(am|pm)\b/i.test(question)) return 3600_000;
  if (/\bdaily\b|\btoday\b|\bday\b/i.test(question)) return 24 * 3600_000;
  if (/\bweek/i.test(question)) return 7 * 24 * 3600_000;
  return 3600_000;
}

/** Convertit « 11:35 PM » en minutes depuis minuit. */
function toMinutes(heure, minute, meridien) {
  let h = Number(heure) % 12;
  if (meridien && /pm/i.test(meridien)) h += 12;
  return h * 60 + Number(minute);
}
