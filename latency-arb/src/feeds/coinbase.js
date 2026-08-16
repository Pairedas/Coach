import { EventEmitter } from 'node:events';
import { ReconnectingSocket } from './socket.js';

/**
 * Flux Coinbase Exchange, canal `ticker` public (sans authentification).
 * Chaque message porte le dernier prix traite et la meilleure limite.
 */
export class CoinbaseFeed extends EventEmitter {
  constructor({ product = 'BTC-USD' } = {}) {
    super();
    this.venue = 'coinbase';
    this.product = product;
    this.socket = new ReconnectingSocket('wss://ws-feed.exchange.coinbase.com', {
      name: 'coinbase',
      onOpen: () => ({ type: 'subscribe', product_ids: [this.product], channels: ['ticker'] }),
    });
    this.socket.on('message', (msg) => this.#handle(msg));
  }

  start() { this.socket.start(); return this; }
  stop() { this.socket.stop(); }

  #handle(msg) {
    if (msg?.type === 'error') {
      this.emit('error', new Error(msg.message ?? 'erreur Coinbase'));
      return;
    }
    if (msg?.type !== 'ticker') return;
    const bid = Number(msg.best_bid);
    const ask = Number(msg.best_ask);
    const price = Number(msg.price);
    const now = Date.now();

    if (bid > 0 && ask > 0) {
      this.emit('quote', {
        venue: this.venue,
        bid,
        ask,
        mid: (bid + ask) / 2,
        bidSize: Number(msg.best_bid_size),
        askSize: Number(msg.best_ask_size),
        ts: now,
      });
    }
    if (price > 0) {
      this.emit('trade', {
        venue: this.venue,
        price,
        size: Number(msg.last_size),
        exchangeTs: msg.time ? Date.parse(msg.time) : now,
        ts: now,
      });
    }
  }
}
