import { EventEmitter } from 'node:events';
import { ReconnectingSocket } from './socket.js';

/**
 * Flux Binance : `bookTicker` (meilleure limite, pousse a chaque changement)
 * complete par `aggTrade` pour horodater les transactions reelles.
 * Aucune cle API n'est requise pour les flux publics.
 */
export class BinanceFeed extends EventEmitter {
  constructor({ symbol = 'btcusdt' } = {}) {
    super();
    this.venue = 'binance';
    this.symbol = symbol.toLowerCase();
    const streams = `${this.symbol}@bookTicker/${this.symbol}@aggTrade`;
    this.socket = new ReconnectingSocket(
      `wss://stream.binance.com:9443/stream?streams=${streams}`,
      { name: 'binance' },
    );
    this.socket.on('message', (msg) => this.#handle(msg));
  }

  start() { this.socket.start(); return this; }
  stop() { this.socket.stop(); }

  #handle(msg) {
    const data = msg?.data ?? msg;
    if (!data) return;
    const now = Date.now();

    if (data.b !== undefined && data.a !== undefined) {
      const bid = Number(data.b);
      const ask = Number(data.a);
      if (!(bid > 0) || !(ask > 0)) return;
      this.emit('quote', {
        venue: this.venue,
        bid,
        ask,
        mid: (bid + ask) / 2,
        bidSize: Number(data.B),
        askSize: Number(data.A),
        ts: now,
      });
      return;
    }

    if (data.e === 'aggTrade') {
      const price = Number(data.p);
      if (!(price > 0)) return;
      this.emit('trade', {
        venue: this.venue,
        price,
        size: Number(data.q),
        // data.T = horodatage de la transaction cote Binance ; l'ecart avec `now`
        // mesure la latence reseau du flux.
        exchangeTs: Number(data.T),
        ts: now,
      });
    }
  }
}
