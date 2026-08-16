import { config, validateConfig } from '../config.js';
import { readSession } from '../replay/recorder.js';
import { LocalBookStore } from '../replay/local-books.js';
import { PaperBroker } from '../exec/paper.js';
import { Engine } from '../engine.js';
import { logger } from '../util/log.js';

const log = logger('rejeu');

/**
 * Rejoue une seance enregistree. Le temps est celui du fichier, pas l'horloge
 * murale : une heure de marche se rejoue en quelques secondes, et un changement
 * de reglage se compare sur exactement les memes donnees.
 */
export async function runReplay(filePath) {
  const cfg = validateConfig(config);
  const books = new LocalBookStore();
  const broker = new PaperBroker(cfg);
  let clock = 0;
  const engine = new Engine(cfg, { broker, bookProvider: books, now: () => clock });

  let events = 0;
  for await (const ev of readSession(filePath)) {
    if (!ev?.type) continue;
    clock = ev.ts ?? clock;
    events += 1;

    switch (ev.type) {
      case 'markets':
        engine.setMarkets(ev.markets);
        break;
      case 'quote':
        engine.spot.onQuote(ev);
        engine.step(clock);
        break;
      case 'book':
        books.set(ev.assetId, { bids: ev.bids, asks: ev.asks, ts: clock });
        engine.step(clock);
        break;
      default:
        // Les evenements de decision (signal, open, close) proviennent de la
        // session d'origine : on les ignore, le rejeu reprend ces decisions
        // depuis zero avec la configuration courante.
        break;
    }
  }

  const stats = engine.portfolio.stats();
  log.info(`${events} evenement(s) rejoue(s)`);
  console.log('\nResultat du rejeu :');
  console.log(`  operations      : ${stats.trades} (${(stats.winRate * 100).toFixed(1)} % gagnantes)`);
  console.log(`  resultat realise: ${stats.realizedPnl.toFixed(2)} USDC`);
  console.log(`  duree moyenne   : ${stats.avgHoldSec.toFixed(0)} s`);
  console.log(`  signaux         : ${engine.signalsSeen} · ordres non executes : ${engine.ordersRejected}`);
  console.log('\nMotifs de rejet les plus frequents :');
  for (const [reason, count] of Object.entries(engine.snapshot().rejections)) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
  console.log('');
  return { stats, engine };
}
