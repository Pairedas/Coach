import { parseMarket } from './parse.js';
import { logger } from '../util/log.js';

const log = logger('discovery');

async function getJson(url, { timeoutMs = 8_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} a repondu ${res.status}`);
  return res.json();
}

/**
 * Prix d'ouverture d'une bougie horaire Binance, servant de seuil aux marches
 * « up or down ».
 *
 * Attention : Polymarket peut resoudre ces marches sur une autre source de prix.
 * Verifie la regle de resolution du marche avant de traiter en reel — une
 * reference decalee de quelques dollars suffit a inverser le signe de la marge.
 */
export async function fetchHourOpen(periodStartTs, { symbol = 'BTCUSDT' } = {}) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${periodStartTs}&limit=1`;
  const rows = await getJson(url);
  const open = Number(rows?.[0]?.[1]);
  if (!(open > 0)) throw new Error('bougie horaire indisponible');
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
  const getHourOpen = deps.fetchHourOpen ?? fetchHourOpen;
  const now = deps.now ?? Date.now();

  // L'API Gamma plafonne le nombre de resultats par appel : sans pagination, on
  // ne voit que les marches les plus gros, et les marches horaires — les plus
  // interessants pour cette strategie — passent sous le radar.
  const raws = [];
  const pageSize = cfg.polymarket.pageSize;
  for (let page = 0; page < cfg.polymarket.maxPages; page += 1) {
    const url = `${cfg.polymarket.gammaUrl}/markets`
      + `?closed=false&active=true&archived=false`
      + `&limit=${pageSize}&offset=${page * pageSize}`
      + `&order=volume24hr&ascending=false`;
    const batch = await fetchJson(url);
    if (!Array.isArray(batch)) throw new Error('reponse Gamma inattendue');
    raws.push(...batch);
    if (batch.length < pageSize) break; // derniere page atteinte
  }

  const keywords = cfg.polymarket.keywords.map((k) => k.toLowerCase());
  const rejected = new Map();
  const kept = [];
  let matched = 0;

  for (const raw of raws) {
    const haystack = `${raw?.question ?? ''} ${raw?.slug ?? ''}`.toLowerCase();
    if (!keywords.some((k) => haystack.includes(k))) continue;
    matched += 1;

    const parsed = parseMarket(raw);
    if (!parsed.ok) {
      rejected.set(parsed.reason, (rejected.get(parsed.reason) ?? 0) + 1);
      continue;
    }
    const m = parsed.market;
    const tte = m.expiryTs - now;
    if (tte < cfg.strategy.minTimeToExpiryMs) {
      rejected.set('echeance trop proche', (rejected.get('echeance trop proche') ?? 0) + 1);
      continue;
    }
    if (tte > cfg.strategy.maxTimeToExpiryMs) {
      rejected.set('echeance trop lointaine', (rejected.get('echeance trop lointaine') ?? 0) + 1);
      continue;
    }
    kept.push(m);
  }

  // Les marches up/down n'ont pas de seuil dans leur libelle : on le reconstruit
  // depuis le prix d'ouverture de la periode.
  for (const m of kept.filter((x) => x.kind === 'updown' && x.strike === null)) {
    try {
      m.strike = await getHourOpen(m.expiryTs - m.periodMs);
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
  if (matched > 0 && usable.length === 0) {
    log.warn('des marches BTC existent mais aucun n\'est exploitable : elargis MIN_TTE_MS / MAX_TTE_MS ou MARKET_KEYWORDS');
  }
  return usable;
}
