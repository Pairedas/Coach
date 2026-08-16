import { EventEmitter } from 'node:events';
import { ReconnectingSocket } from '../feeds/socket.js';
import { logger } from '../util/log.js';

/**
 * Carnet d'ordres d'un jeton CLOB.
 *
 * Deux horodatages distincts, et la distinction est le coeur de la strategie :
 *  - `lastUpdateTs` : dernier message recu, meme sans effet sur la meilleure limite ;
 *  - `lastTopChangeTs` : derniere fois que la meilleure limite a bouge.
 * Un carnet qui recoit des messages mais dont le sommet ne bouge pas apres un
 * mouvement du BTC, c'est exactement le retard que l'on cherche.
 */
export class Book {
  constructor(assetId) {
    this.assetId = assetId;
    this.bids = []; // { price, size }, prix decroissant
    this.asks = []; // { price, size }, prix croissant
    this.lastUpdateTs = 0;
    this.lastTopChangeTs = 0;
    this.snapshotTs = 0;
    // Nombre de fois que la meilleure limite a bouge : sert a savoir si le
    // carnet a « repris la main » depuis notre entree.
    this.topChanges = 0;
  }

  #topSignature() {
    return `${this.bids[0]?.price ?? ''}|${this.bids[0]?.size ?? ''}|${this.asks[0]?.price ?? ''}|${this.asks[0]?.size ?? ''}`;
  }

  applySnapshot({ bids, asks, ts }) {
    const before = this.#topSignature();
    this.bids = normalize(bids, 'desc');
    this.asks = normalize(asks, 'asc');
    this.lastUpdateTs = ts;
    this.snapshotTs = ts;
    if (this.#topSignature() !== before) {
      this.lastTopChangeTs = ts;
      this.topChanges += 1;
    }
  }

  /** Applique un delta { price, side: 'BUY'|'SELL', size } ; size 0 supprime le niveau. */
  applyChanges(changes, ts) {
    const before = this.#topSignature();
    for (const c of changes ?? []) {
      const price = Number(c.price);
      const size = Number(c.size);
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
      const side = String(c.side ?? '').toUpperCase() === 'BUY' ? 'bids' : 'asks';
      const levels = this[side];
      const idx = levels.findIndex((l) => l.price === price);
      if (size <= 0) {
        if (idx >= 0) levels.splice(idx, 1);
      } else if (idx >= 0) {
        levels[idx].size = size;
      } else {
        levels.push({ price, size });
        levels.sort((a, b) => (side === 'bids' ? b.price - a.price : a.price - b.price));
      }
    }
    this.lastUpdateTs = ts;
    if (this.#topSignature() !== before) {
      this.lastTopChangeTs = ts;
      this.topChanges += 1;
    }
  }

  get bestBid() { return this.bids[0]?.price ?? null; }
  get bestAsk() { return this.asks[0]?.price ?? null; }
  get mid() {
    const b = this.bestBid;
    const a = this.bestAsk;
    return b !== null && a !== null ? (b + a) / 2 : null;
  }
  get spread() {
    const b = this.bestBid;
    const a = this.bestAsk;
    return b !== null && a !== null ? a - b : null;
  }
  get isCrossed() { return this.bestBid !== null && this.bestAsk !== null && this.bestBid >= this.bestAsk; }
  get hasTop() { return this.bestBid !== null && this.bestAsk !== null; }

  /**
   * Prix moyen d'execution en consommant le carnet.
   * @param {'buy'|'sell'} direction
   * @param {number} shares quantite souhaitee
   * @param {number} availability part du carnet reellement atteignable (0..1)
   * @param {number|null} limitPrice prix limite : on ignore les niveaux au-dela
   */
  sweep(direction, shares, availability = 1, limitPrice = null) {
    const levels = direction === 'buy' ? this.asks : this.bids;
    let remaining = shares;
    let cost = 0;
    let filled = 0;
    for (const lvl of levels) {
      if (remaining <= 0) break;
      if (limitPrice !== null) {
        const acceptable = direction === 'buy' ? lvl.price <= limitPrice + 1e-9 : lvl.price >= limitPrice - 1e-9;
        if (!acceptable) break;
      }
      const take = Math.min(remaining, lvl.size * availability);
      if (take <= 0) continue;
      cost += take * lvl.price;
      filled += take;
      remaining -= take;
    }
    return { filled, avgPrice: filled > 0 ? cost / filled : null, shortfall: Math.max(0, shares - filled) };
  }

  /** Quantite disponible jusqu'a un prix limite inclus. */
  depthTo(direction, limitPrice, availability = 1) {
    const levels = direction === 'buy' ? this.asks : this.bids;
    let total = 0;
    for (const lvl of levels) {
      const within = direction === 'buy' ? lvl.price <= limitPrice : lvl.price >= limitPrice;
      if (!within) break;
      total += lvl.size * availability;
    }
    return total;
  }
}

function normalize(levels, order) {
  return (levels ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && l.size > 0)
    .sort((a, b) => (order === 'desc' ? b.price - a.price : a.price - b.price));
}

/**
 * Gere les carnets de tous les jetons suivis : amorcage REST puis maintien par
 * WebSocket. Sur reconnexion, un nouvel amorcage REST evite de travailler sur un
 * carnet reconstruit a partir de deltas incomplets.
 */
export class PolymarketBooks extends EventEmitter {
  constructor(cfg, deps = {}) {
    super();
    this.cfg = cfg;
    this.log = logger('clob');
    this.books = new Map(); // assetId -> Book
    this.assetIds = [];
    this.socket = null;
    this.fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
    this.now = deps.now ?? (() => Date.now());
  }

  book(assetId) {
    let b = this.books.get(assetId);
    if (!b) {
      b = new Book(assetId);
      this.books.set(assetId, b);
    }
    return b;
  }

  /** (Re)definit la liste des jetons suivis et relance l'abonnement. */
  async track(assetIds) {
    const next = [...new Set(assetIds)];
    const changed = next.length !== this.assetIds.length || next.some((id) => !this.assetIds.includes(id));
    this.assetIds = next;
    for (const id of [...this.books.keys()]) if (!next.includes(id)) this.books.delete(id);
    await this.bootstrap();
    if (changed) this.#resubscribe();
  }

  /** Amorcage REST des carnets (source de verite au demarrage et apres coupure). */
  async bootstrap() {
    if (this.assetIds.length === 0) return;
    try {
      const res = await this.fetchImpl(`${this.cfg.polymarket.clobUrl}/books`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.assetIds.map((token_id) => ({ token_id }))),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`/books a repondu ${res.status}`);
      const payload = await res.json();
      const ts = this.now();
      for (const entry of payload ?? []) {
        const id = String(entry.asset_id ?? entry.assetId ?? '');
        if (!id) continue;
        this.book(id).applySnapshot({
          bids: entry.bids ?? entry.buys,
          asks: entry.asks ?? entry.sells,
          ts,
        });
      }
      this.log.info(`carnets amorces : ${payload?.length ?? 0}`);
    } catch (err) {
      this.log.error(`amorcage des carnets impossible : ${err.message}`);
    }
  }

  start() {
    this.socket = new ReconnectingSocket(this.cfg.polymarket.wsUrl, {
      name: 'clob-ws',
      pingMs: 10_000,
      onOpen: () => ({ assets_ids: this.assetIds, type: 'market' }),
    });
    this.socket.on('message', (msg) => this.#handle(msg));
    // Une reconnexion signifie des deltas manques : on repart d'un instantane REST.
    this.socket.on('open', () => { void this.bootstrap(); });
    this.socket.start();
    return this;
  }

  #resubscribe() {
    this.socket?.send({ assets_ids: this.assetIds, type: 'market' });
  }

  #handle(msg) {
    const events = Array.isArray(msg) ? msg : [msg];
    const ts = this.now();
    for (const ev of events) {
      const assetId = String(ev?.asset_id ?? ev?.assetId ?? '');
      if (!assetId) continue;
      const type = ev.event_type ?? ev.type;
      if (type === 'book') {
        this.book(assetId).applySnapshot({ bids: ev.bids ?? ev.buys, asks: ev.asks ?? ev.sells, ts });
        this.emit('book', assetId);
      } else if (type === 'price_change') {
        this.book(assetId).applyChanges(ev.changes ?? [], ts);
        this.emit('book', assetId);
      } else if (type === 'last_trade_price') {
        this.emit('trade', { assetId, price: Number(ev.price), size: Number(ev.size), ts });
      }
    }
  }

  stop() { this.socket?.stop(); }
}
