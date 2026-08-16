import { parseMarket } from './parse.js';
import { logger } from '../util/log.js';

const log = logger('discovery');

async function getJson(url, { timeoutMs = 8_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} a repondu ${res.status}`);
  return res.json();
}

/**
 * Prix d'ouverture de la periode d'un marche « up or down », qui en constitue
 * le seuil.
 *
 * On lit toujours une bougie d'une minute : l'ouverture de la premiere minute
 * d'une periode est, par construction, l'ouverture de la periode — que celle-ci
 * dure cinq minutes ou une heure. Une seule requete couvre donc tous les
 * formats, sans table de correspondance a maintenir.
 *
 * Attention : Polymarket peut resoudre ces marches sur une autre source de prix.
 * Verifie la regle de resolution du marche avant de traiter en reel — une
 * reference decalee de quelques dollars suffit a inverser le signe de la marge.
 */
export async function fetchPeriodOpen(periodStartTs, { symbol = 'BTCUSDT' } = {}) {
  const aligne = Math.floor(periodStartTs / 60_000) * 60_000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${aligne}&limit=1`;
  const rows = await getJson(url);
  const open = Number(rows?.[0]?.[1]);
  if (!(open > 0)) throw new Error('bougie d\'ouverture indisponible');
  return open;
}

/**
 * Decouvre les marches Polymarket exploitables.
 *
 * @param {object} cfg configuration `polymarket` + `strategy`
 * @param {object} deps injections pour les tests
 */
export async function discoverMarkets(cfg, deps = {}) {
  const fetchJson = deps.getJson ?? getJson;
  const getPeriodOpen = deps.fetchPeriodOpen ?? fetchPeriodOpen;
  const now = deps.now ?? Date.now();

  // Deux balayages complementaires, dedupliques.
  //
  // Trier par volume ne suffit pas : un marche horaire a un volume individuel
  // faible et se retrouve noyé sous les gros marches annuels, alors que c'est
  // exactement le type de marche que cette strategie vise. Le second balayage
  // trie par echeance croissante, la ou vivent les marches courts.
  const pageSize = cfg.polymarket.pageSize;
  const sweep = async (order, ascending) => {
    const out = [];
    for (let page = 0; page < cfg.polymarket.maxPages; page += 1) {
      const url = `${cfg.polymarket.gammaUrl}/markets`
        + `?closed=false&active=true&archived=false`
        + `&limit=${pageSize}&offset=${page * pageSize}`
        + `&order=${order}&ascending=${ascending}`;
      const batch = await fetchJson(url);
      if (!Array.isArray(batch)) throw new Error('reponse Gamma inattendue');
      out.push(...batch);
      if (batch.length < pageSize) break; // derniere page atteinte
    }
    return out;
  };

  const parVolume = await sweep('volume24hr', false);
  const parEcheance = await sweep('endDate', true);

  const vus = new Set();
  const raws = [];
  for (const raw of [...parVolume, ...parEcheance]) {
    const cle = raw?.conditionId ?? raw?.condition_id ?? raw?.id;
    if (cle === undefined || vus.has(cle)) continue;
    vus.add(cle);
    raws.push(raw);
  }

  const keywords = cfg.polymarket.keywords.map((k) => k.toLowerCase());
  const rejected = new Map();
  // Un exemple de question par motif : sans ca, « sens du seuil ambigu : 3 » ne
  // dit pas quel format de libelle le parseur ne sait pas encore lire.
  const exemples = new Map();
  const kept = [];
  let matched = 0;

  const rejeter = (motif, question) => {
    rejected.set(motif, (rejected.get(motif) ?? 0) + 1);
    if (!exemples.has(motif)) exemples.set(motif, question);
  };

  for (const raw of raws) {
    const haystack = `${raw?.question ?? ''} ${raw?.slug ?? ''}`.toLowerCase();
    if (!keywords.some((k) => haystack.includes(k))) continue;
    matched += 1;

    const parsed = parseMarket(raw);
    if (!parsed.ok) {
      rejeter(parsed.reason, raw.question ?? '');
      continue;
    }
    const m = parsed.market;
    const tte = m.expiryTs - now;
    if (tte <= 0) {
      // L'API renvoie parfois des marches deja echus comme encore actifs. Les
      // distinguer d'une simple echeance proche evite de croire a un reglage
      // trop strict la ou il s'agit d'une donnee obsolete.
      rejeter('echeance deja passee (donnee obsolete)', m.question);
      continue;
    }
    if (tte < cfg.strategy.minTimeToExpiryMs) {
      rejeter('echeance trop proche', m.question);
      continue;
    }
    if (tte > cfg.strategy.maxTimeToExpiryMs) {
      rejeter('echeance trop lointaine', m.question);
      continue;
    }
    kept.push(m);
  }

  // Les marches up/down n'ont pas de seuil dans leur libelle : on le reconstruit
  // depuis le prix d'ouverture de la periode.
  for (const m of kept.filter((x) => x.kind === 'updown' && x.strike === null)) {
    try {
      m.strike = await getPeriodOpen(m.expiryTs - m.periodMs);
      m.strikeSource = 'binance-kline-open';
    } catch (err) {
      log.warn(`seuil introuvable pour "${m.question}" : ${err.message}`);
    }
  }

  const usable = kept
    .filter((m) => m.strike > 0)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, cfg.polymarket.maxMarkets);

  // L'entonnoir complet, parce qu'un « 4 marches trouves » sans denominateur ne
  // dit pas si le filtre est trop strict ou si la requete ne ramene rien.
  log.info(
    `entonnoir : ${raws.length} marches inspectes -> ${matched} mentionnant ${keywords.join('/')} `
    + `-> ${kept.length} valorisables -> ${usable.length} retenus`,
    rejected.size ? Object.fromEntries(rejected) : undefined,
  );
  for (const [motif, question] of exemples) {
    log.debug(`rejet « ${motif} » — exemple : ${question}`);
  }
  if (matched > 0 && usable.length === 0) {
    log.warn('des marches BTC existent mais aucun n\'est exploitable : elargis MIN_TTE_MS / MAX_TTE_MS ou MARKET_KEYWORDS');
  }
  return usable;
}
