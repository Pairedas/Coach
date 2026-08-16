import { config, validateConfig } from '../config.js';
import { discoverMarkets } from '../polymarket/discovery.js';
import { buildSession } from './session.js';
import { PaperBroker } from '../exec/paper.js';
import { LiveBroker } from '../exec/live.js';
import { Recorder } from '../replay/recorder.js';
import { startDashboard } from '../dashboard.js';
import { logger } from '../util/log.js';

const log = logger('session');

/**
 * Session temps reel. `record: true` journalise les flux pour pouvoir rejouer
 * la seance plus tard et tester des reglages sur des donnees vraies.
 */
export async function runLive({ record = false } = {}) {
  const cfg = validateConfig(config);
  const recorder = record ? new Recorder(cfg.recordPath) : null;

  const broker = cfg.exec.live ? await new LiveBroker(cfg).connect() : new PaperBroker(cfg);
  if (!cfg.exec.live) log.info('mode PAPIER — aucun ordre reel n\'est envoye');

  const { engine, books, refresh, start, stop: stopSession } = buildSession(cfg, { broker, recorder });

  start();

  for (const m of await refresh()) {
    log.info(`suivi : ${m.question} (seuil ${m.strike?.toFixed(0)}, echeance ${new Date(m.expiryTs).toISOString()})`);
  }
  books.start();
  const rediscover = setInterval(refresh, cfg.polymarket.rediscoverMs);

  // Sans activite sur les flux, rien ne cadence le moteur : ce battement garantit
  // que les sorties (echeance, duree maximale) sont evaluees malgre tout.
  const heartbeat = setInterval(() => engine.step(Date.now()), 1_000);

  const status = setInterval(() => {
    const s = engine.snapshot();
    log.info(
      `spot ${s.spot.price ? s.spot.price.toFixed(1) : 'n/d'} | vol ${(s.spot.volAnnual * 100).toFixed(0)}% | ` +
      `positions ${s.stats.openPositions} | operations ${s.stats.trades} | ` +
      `resultat ${s.stats.realizedPnl >= 0 ? '+' : ''}${s.stats.realizedPnl.toFixed(2)} USDC`,
    );
  }, 30_000);

  const dashboard = cfg.dashboard.enabled ? startDashboard(cfg, engine) : null;

  const shutdown = async () => {
    log.warn('arret demande');
    clearInterval(rediscover);
    clearInterval(heartbeat);
    clearInterval(status);
    stopSession();
    dashboard?.close();
    await recorder?.close();
    const s = engine.snapshot();
    log.info(`bilan : ${JSON.stringify(s.stats)}`);
    if (s.positions.length > 0) {
      log.warn(`${s.positions.length} position(s) restent OUVERTES — a denouer manuellement si le mode reel etait actif`);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return engine;
}

/** Mode `scan` : liste ce que le moteur suivrait, sans rien engager. */
export async function runScan() {
  const cfg = validateConfig(config);
  const markets = await discoverMarkets(cfg);
  if (markets.length === 0) {
    console.log('Aucun marche exploitable trouve avec les filtres actuels.');
    return;
  }
  console.log(`\n${markets.length} marche(s) exploitable(s) :\n`);
  for (const m of markets) {
    const minutes = Math.round((m.expiryTs - Date.now()) / 60_000);
    console.log(`  ${m.question}`);
    console.log(`    type ${m.kind} · seuil ${m.strike?.toFixed(0) ?? 'n/d'} · echeance dans ${minutes} min · volume 24 h ${Math.round(m.volume24h)}`);
  }
  console.log('');
}
