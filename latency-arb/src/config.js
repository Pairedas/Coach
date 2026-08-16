/**
 * Configuration centrale. Toutes les valeurs sont surchargeables par variable
 * d'environnement (voir .env.example) — aucun secret n'est ecrit en dur ici.
 */

const num = (key, dflt) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key} doit etre un nombre, recu "${raw}"`);
  return v;
};

const bool = (key, dflt) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return dflt;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(raw.toLowerCase());
};

const str = (key, dflt) => process.env[key] ?? dflt;

export const config = {
  // ── Flux spot ────────────────────────────────────────────────────────────
  spot: {
    binanceSymbol: str('BINANCE_SYMBOL', 'btcusdt'),
    coinbaseProduct: str('COINBASE_PRODUCT', 'BTC-USD'),
    // Poids de chaque venue dans le prix consolide (renormalises a la volee).
    weights: { binance: num('WEIGHT_BINANCE', 0.65), coinbase: num('WEIGHT_COINBASE', 0.35) },
    // Au-dela, une venue est jugee morte et sort du prix consolide.
    stalenessMs: num('SPOT_STALENESS_MS', 3_000),
    historyMs: num('SPOT_HISTORY_MS', 120_000),
  },

  // ── Polymarket ───────────────────────────────────────────────────────────
  polymarket: {
    gammaUrl: str('GAMMA_URL', 'https://gamma-api.polymarket.com'),
    clobUrl: str('CLOB_URL', 'https://clob.polymarket.com'),
    wsUrl: str('CLOB_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    // Filtre de decouverte des marches.
    keywords: str('MARKET_KEYWORDS', 'bitcoin,btc').split(',').map((s) => s.trim()).filter(Boolean),
    maxMarkets: num('MAX_MARKETS', 12),
    rediscoverMs: num('REDISCOVER_MS', 60_000),
    // Frais preneur de liquidite, en points de base, appliques sur min(p, 1-p).
    takerFeeBps: num('TAKER_FEE_BPS', 0),
    minTickSize: num('MIN_TICK_SIZE', 0.001),
  },

  // ── Modele de valorisation ───────────────────────────────────────────────
  model: {
    volHalfLifeSec: num('VOL_HALFLIFE_SEC', 120),
    // Pas d'echantillonnage des rendements pour la volatilite realisee.
    // Trop court : on mesure le bruit de microstructure. Trop long : on reagit
    // trop tard a un changement de regime.
    volSampleMs: num('VOL_SAMPLE_MS', 1_000),
    seedVolAnnual: num('SEED_VOL_ANNUAL', 0.5),
    // Multiplicateur de prudence sur la vol : >1 rapproche le juste prix de 0.5
    // et donc reduit mecaniquement le nombre de signaux.
    volMultiplier: num('VOL_MULTIPLIER', 1.0),
    // Incertitude du modele, ajoutee au seuil d'entree.
    modelUncertainty: num('MODEL_UNCERTAINTY', 0.01),
  },

  // ── Strategie ────────────────────────────────────────────────────────────
  strategy: {
    // Fenetre pendant laquelle on considere qu'un mouvement spot est « recent ».
    lagWindowMs: num('LAG_WINDOW_MS', 4_000),
    // Deplacement minimal du juste prix cause par le spot sur la fenetre.
    minImpulse: num('MIN_IMPULSE', 0.02),
    // Le carnet Polymarket doit etre au moins aussi vieux que ca pour parler de retard.
    minBookStalenessMs: num('MIN_BOOK_STALENESS_MS', 500),
    // Marge nette exigee apres spread, frais et incertitude modele.
    minEdge: num('MIN_EDGE', 0.03),
    // On sort quand la marge residuelle repasse sous ce seuil.
    exitEdge: num('EXIT_EDGE', 0.008),
    // Coupe-circuit sur la position : la marge est devenue negative de ce montant.
    stopEdge: num('STOP_EDGE', 0.05),
    maxHoldMs: num('MAX_HOLD_MS', 300_000),
    // Nombre de re-cotations du carnet apres lesquelles on considere que le
    // retard a ete comble, meme si le modele voit encore une marge.
    repriceExitTicks: num('REPRICE_EXIT_TICKS', 3),
    // Bornes de temps restant avant echeance pour ouvrir une position.
    minTimeToExpiryMs: num('MIN_TTE_MS', 90_000),
    maxTimeToExpiryMs: num('MAX_TTE_MS', 6 * 3600_000),
    // On evite les extremes ou le modele et la liquidite sont peu fiables.
    minPrice: num('MIN_PRICE', 0.05),
    maxPrice: num('MAX_PRICE', 0.95),
    cooldownMs: num('COOLDOWN_MS', 15_000),
    // Fraction de Kelly. 0.25 = quart de Kelly, deja agressif en pratique.
    kellyFraction: num('KELLY_FRACTION', 0.2),
  },

  // ── Risque ───────────────────────────────────────────────────────────────
  risk: {
    bankroll: num('BANKROLL', 1_000),
    maxPositions: num('MAX_POSITIONS', 3),
    maxNotionalPerMarket: num('MAX_NOTIONAL_PER_MARKET', 100),
    maxTotalNotional: num('MAX_TOTAL_NOTIONAL', 250),
    minNotional: num('MIN_NOTIONAL', 5),
    dailyLossLimit: num('DAILY_LOSS_LIMIT', 100),
    maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 6),
  },

  // ── Execution ────────────────────────────────────────────────────────────
  exec: {
    // Le mode reel exige DEUX drapeaux explicites : ceinture et bretelles.
    live: bool('LIVE_TRADING', false),
    liveConfirm: str('LIVE_CONFIRM', ''),
    // Latence aller-retour simulee en papier (reseau + traitement Polymarket).
    simLatencyMs: num('SIM_LATENCY_MS', 350),
    // Part du carnet que l'on suppose perdue par la concurrence pendant cette latence.
    simQueueLossPct: num('SIM_QUEUE_LOSS_PCT', 0.5),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY ?? '',
    apiKey: process.env.POLYMARKET_API_KEY ?? '',
    apiSecret: process.env.POLYMARKET_API_SECRET ?? '',
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE ?? '',
    funderAddress: process.env.POLYMARKET_FUNDER ?? '',
  },

  // ── Divers ───────────────────────────────────────────────────────────────
  dashboard: { enabled: bool('DASHBOARD', true), port: num('DASHBOARD_PORT', 8787) },
  recordPath: str('RECORD_PATH', './data/session.ndjson'),
};

/** Verifications de coherence, appelees au demarrage du moteur. */
export function validateConfig(cfg = config) {
  const errs = [];
  if (cfg.strategy.minEdge <= cfg.strategy.exitEdge) errs.push('MIN_EDGE doit etre > EXIT_EDGE');
  if (cfg.strategy.minPrice >= cfg.strategy.maxPrice) errs.push('MIN_PRICE doit etre < MAX_PRICE');
  if (cfg.risk.maxNotionalPerMarket > cfg.risk.maxTotalNotional) errs.push('MAX_NOTIONAL_PER_MARKET doit etre <= MAX_TOTAL_NOTIONAL');
  if (cfg.risk.minNotional > cfg.risk.maxNotionalPerMarket) errs.push('MIN_NOTIONAL doit etre <= MAX_NOTIONAL_PER_MARKET');
  if (cfg.strategy.kellyFraction <= 0 || cfg.strategy.kellyFraction > 1) errs.push('KELLY_FRACTION doit etre dans ]0,1]');
  if (cfg.strategy.minTimeToExpiryMs >= cfg.strategy.maxTimeToExpiryMs) errs.push('MIN_TTE_MS doit etre < MAX_TTE_MS');
  if (cfg.exec.live && cfg.exec.liveConfirm !== 'JE COMPRENDS LES RISQUES') {
    errs.push('LIVE_TRADING=1 exige LIVE_CONFIRM="JE COMPRENDS LES RISQUES"');
  }
  if (errs.length) throw new Error(`Configuration invalide :\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

/** Copie profonde de la configuration avec surcharges (utilisee par la simulation). */
export function withOverrides(overrides = {}, base = config) {
  const clone = structuredClone(base);
  const merge = (target, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        target[k] ??= {};
        merge(target[k], v);
      } else {
        target[k] = v;
      }
    }
    return target;
  };
  return merge(clone, overrides);
}
