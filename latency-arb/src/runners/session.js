import { BinanceFeed } from '../feeds/binance.js';
import { CoinbaseFeed } from '../feeds/coinbase.js';
import { PolymarketBooks } from '../polymarket/book.js';
import { discoverMarkets } from '../polymarket/discovery.js';
import { Engine } from '../engine.js';
import { logger } from '../util/log.js';

const log = logger('session');

/**
 * Cablage commun a toutes les sessions temps reel : flux spot, carnets
 * Polymarket, moteur, decouverte periodique des marches.
 *
 * Partage entre le mode d'exploitation et le mode diagnostic pour qu'ils
 * observent exactement le meme marche — un diagnostic qui ne verrait pas ce que
 * voit le moteur ne servirait a rien.
 */
export function buildSession(cfg, { broker, recorder = null } = {}) {
  const books = new PolymarketBooks(cfg);
  const engine = new Engine(cfg, { broker, bookProvider: books, now: () => Date.now(), recorder });

  const binance = new BinanceFeed({ symbol: cfg.spot.binanceSymbol });
  const coinbase = new CoinbaseFeed({ product: cfg.spot.coinbaseProduct });
  engine.spot.attach(binance).attach(coinbase);

  for (const feed of [binance, coinbase]) {
    feed.on('quote', (q) => {
      recorder?.write({ type: 'quote', ...q });
      engine.step(Date.now());
    });
  }

  books.on('book', (assetId) => {
    const now = Date.now();
    if (recorder) {
      const b = books.book(assetId);
      // Cinq niveaux de chaque cote suffisent au rejeu : au-dela, le fichier
      // grossit sans changer une decision d'execution.
      recorder.write({ type: 'book', ts: now, assetId, bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5) });
    }
    engine.step(now);
  });

  const refresh = async () => {
    try {
      const markets = await discoverMarkets(cfg);
      if (markets.length === 0) {
        log.warn('aucun marche exploitable pour le moment');
        return [];
      }
      engine.setMarkets(markets);
      await books.track(markets.flatMap((m) => [m.tokenYes, m.tokenNo]));
      recorder?.write({ type: 'markets', ts: Date.now(), markets });
      return markets;
    } catch (err) {
      log.error(`decouverte des marches impossible : ${err.message}`);
      return [];
    }
  };

  const start = () => {
    binance.start();
    coinbase.start();
  };

  const stop = () => {
    binance.stop();
    coinbase.stop();
    books.stop();
    broker.stop();
  };

  return { engine, books, binance, coinbase, refresh, start, stop };
}
