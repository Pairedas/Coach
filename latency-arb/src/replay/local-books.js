import { Book } from '../polymarket/book.js';

/** Depot de carnets en memoire, meme interface que PolymarketBooks. */
export class LocalBookStore {
  constructor() { this.books = new Map(); }

  book(assetId) {
    let b = this.books.get(assetId);
    if (!b) {
      b = new Book(assetId);
      this.books.set(assetId, b);
    }
    return b;
  }

  set(assetId, { bids, asks, ts }) {
    this.book(assetId).applySnapshot({ bids, asks, ts });
  }
}
