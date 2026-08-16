/**
 * Vue d'un cote (YES ou NO) exprimee dans l'espace de prix du jeton detenu.
 *
 * Polymarket cote deux jetons complementaires : acheter NO a q equivaut a vendre
 * YES a 1-q, et le mecanisme de fusion rend les deux carnets economiquement
 * equivalents. On privilegie toujours le carnet reel du jeton ; on ne retombe
 * sur le complement synthetique que si ce carnet n'est pas encore amorce.
 */
export class TokenView {
  constructor({ outcome, book, synthetic }) {
    this.outcome = outcome;
    this.book = book;
    this.synthetic = synthetic;
  }

  static for(outcome, yesBook, noBook) {
    if (outcome === 'YES') return new TokenView({ outcome, book: yesBook, synthetic: false });
    if (noBook?.hasTop) return new TokenView({ outcome, book: noBook, synthetic: false });
    return new TokenView({ outcome, book: yesBook, synthetic: true });
  }

  get hasTop() { return Boolean(this.book?.hasTop); }
  // En mode synthetique, les cotes s'inversent : ask_NO = 1 - bid_YES.
  get ask() {
    if (!this.hasTop) return null;
    return this.synthetic ? 1 - this.book.bestBid : this.book.bestAsk;
  }
  get bid() {
    if (!this.hasTop) return null;
    return this.synthetic ? 1 - this.book.bestAsk : this.book.bestBid;
  }
  get lastTopChangeTs() { return this.book?.lastTopChangeTs ?? 0; }
  get topChanges() { return this.book?.topChanges ?? 0; }

  /**
   * Achat de `shares` jetons : balaie les offres et renvoie le prix moyen paye.
   * `limitPrice` est exprime dans l'espace de prix du jeton achete.
   */
  buySweep(shares, availability, limitPrice = null) {
    if (!this.hasTop) return { filled: 0, avgPrice: null };
    const r = this.synthetic
      ? this.book.sweep('sell', shares, availability, limitPrice === null ? null : 1 - limitPrice)
      : this.book.sweep('buy', shares, availability, limitPrice);
    return this.#convert(r);
  }

  /** Vente de `shares` jetons detenus : balaie les demandes. */
  sellSweep(shares, availability, limitPrice = null) {
    if (!this.hasTop) return { filled: 0, avgPrice: null };
    const r = this.synthetic
      ? this.book.sweep('buy', shares, availability, limitPrice === null ? null : 1 - limitPrice)
      : this.book.sweep('sell', shares, availability, limitPrice);
    return this.#convert(r);
  }

  #convert(r) {
    return {
      filled: r.filled,
      avgPrice: r.avgPrice === null ? null : (this.synthetic ? 1 - r.avgPrice : r.avgPrice),
    };
  }
}
