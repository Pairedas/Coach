import { fairProbability } from '../model/pricer.js';
import { roundTripCostPerShare } from '../model/costs.js';
import { PriceHistory, clamp } from '../util/stats.js';
import { TokenView } from './token-view.js';

/**
 * Strategie d'arbitrage de latence.
 *
 * On ne prend jamais de vue directionnelle sur le BTC. On cherche uniquement les
 * instants ou le spot a deja bouge et ou le carnet Polymarket n'a pas encore
 * integre ce mouvement. Trois conditions doivent tenir ensemble :
 *
 *   1. IMPULSION — le juste prix implique par le spot a bouge d'au moins
 *      `minImpulse` sur la fenetre `lagWindowMs` ;
 *   2. NON-ABSORPTION — le milieu du carnet Polymarket n'a pas suivi ce
 *      mouvement, et son sommet est fige depuis `minBookStalenessMs` ;
 *   3. MARGE — apres avoir traverse le spread, paye les frais et retranche
 *      l'incertitude du modele, il reste `minEdge` de marge.
 *
 * La condition 2 est ce qui distingue un vrai retard d'un simple desaccord avec
 * le marche. Un desaccord persistant signifie presque toujours que c'est le
 * modele qui a tort, pas le marche.
 */
export class LatencyArbStrategy {
  constructor(cfg) {
    this.cfg = cfg;
    this.states = new Map(); // marketId -> { midHistory, lastEntryTs }
    this.rejections = new Map(); // motif -> compteur, pour le diagnostic
  }

  state(marketId) {
    let s = this.states.get(marketId);
    if (!s) {
      s = { midHistory: new PriceHistory(this.cfg.spot.historyMs), lastEntryTs: 0 };
      this.states.set(marketId, s);
    }
    return s;
  }

  /** A appeler a chaque rafraichissement de carnet : entretient l'historique des cotes. */
  observe(market, yesBook, now) {
    const mid = yesBook?.mid;
    if (mid > 0) this.state(market.id).midHistory.push(now, mid);
  }

  markEntry(marketId, now) {
    this.state(marketId).lastEntryTs = now;
  }

  #reject(reason, diag) {
    this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
    return { signal: null, reason, diag };
  }

  /**
   * @param {object} ctx
   * @param {object} ctx.market marche normalise
   * @param {object} ctx.yesBook carnet du jeton YES
   * @param {object} [ctx.noBook] carnet du jeton NO (facultatif)
   * @param {object} ctx.spot bande consolidee
   * @param {number} ctx.now horodatage courant
   * @param {number} ctx.exposure notionnel deja engage, tous marches confondus
   * @returns {{signal: object|null, reason: string, diag: object}}
   */
  evaluateEntry({ market, yesBook, noBook, spot, now, exposure = 0 }) {
    const { strategy: S, model: M, polymarket: P } = this.cfg;
    const diag = { marketId: market.id, question: market.question };

    if (spot.isStale(now)) return this.#reject('spot fige', diag);
    if (!(market.strike > 0)) return this.#reject('seuil inconnu', diag);
    if (!yesBook?.hasTop) return this.#reject('carnet vide', diag);
    if (yesBook.isCrossed) return this.#reject('carnet croise', diag);

    const tteMs = market.expiryTs - now;
    if (tteMs < S.minTimeToExpiryMs) return this.#reject('echeance trop proche', diag);
    if (tteMs > S.maxTimeToExpiryMs) return this.#reject('echeance trop lointaine', diag);

    const st = this.state(market.id);
    if (now - st.lastEntryTs < S.cooldownMs) return this.#reject('periode de refroidissement', diag);

    const volAnnual = spot.volAnnual * M.volMultiplier;
    if (!(volAnnual > 0)) return this.#reject('volatilite indisponible', diag);

    // ── 1. Impulsion : de combien le spot a-t-il deplace le juste prix ? ──
    const spotNow = spot.price;
    const spotBefore = spot.priceAgo(S.lagWindowMs, now);
    if (!(spotBefore > 0)) return this.#reject('historique spot insuffisant', diag);

    const fairNow = fairProbability(market, { spot: spotNow, volAnnual, now });
    const fairBefore = fairProbability(market, { spot: spotBefore, volAnnual, now });
    if (!Number.isFinite(fairNow.prob) || !Number.isFinite(fairBefore.prob)) {
      return this.#reject('valorisation impossible', diag);
    }
    const impulse = fairNow.prob - fairBefore.prob;

    // ── 2. Non-absorption : le carnet a-t-il suivi ? ──
    const midNow = yesBook.mid;
    const midBefore = st.midHistory.priceAt(now - S.lagWindowMs);
    const marketMove = midBefore === null ? 0 : midNow - midBefore;
    const unabsorbed = impulse - marketMove;
    const bookStalenessMs = now - (yesBook.lastTopChangeTs || yesBook.snapshotTs || now);

    Object.assign(diag, {
      spot: spotNow,
      spotBefore,
      strike: market.strike,
      volAnnual,
      fairProb: fairNow.prob,
      impulse,
      marketMove,
      unabsorbed,
      bookStalenessMs,
      tteMs,
      bestBid: yesBook.bestBid,
      bestAsk: yesBook.bestAsk,
    });

    if (Math.abs(impulse) < S.minImpulse) return this.#reject('impulsion trop faible', diag);
    if (Math.abs(unabsorbed) < S.minImpulse) return this.#reject('mouvement deja absorbe', diag);
    if (bookStalenessMs < S.minBookStalenessMs) return this.#reject('carnet trop reactif', diag);
    // Le retard doit aller dans le sens de l'impulsion, sinon c'est du bruit.
    if (Math.sign(unabsorbed) !== Math.sign(impulse)) return this.#reject('retard incoherent', diag);

    // ── 3. Marge apres couts ──
    // Le BTC est monte : on achete YES. Il est descendu : on achete NO.
    const outcome = impulse > 0 ? 'YES' : 'NO';
    const view = TokenView.for(outcome, yesBook, noBook);
    if (!view.hasTop) return this.#reject('carnet du cote vise vide', diag);

    const fair = fairNow.prob;
    const sideProb = outcome === 'YES' ? fair : 1 - fair;
    const topAsk = view.ask;
    diag.outcome = outcome;
    diag.topAsk = topAsk;
    diag.sideProb = sideProb;

    if (!(topAsk > 0)) return this.#reject('pas de cote a l\'achat', diag);
    if (topAsk < S.minPrice || topAsk > S.maxPrice) return this.#reject('prix hors bornes', diag);
    if (sideProb <= topAsk) return this.#reject('pas de cote favorable', diag);

    const costsTop = roundTripCostPerShare({ entryPrice: topAsk, expectedExitPrice: sideProb, feeBps: P.takerFeeBps });
    const netEdgeTop = sideProb - topAsk - costsTop - M.modelUncertainty;
    diag.netEdgeTop = netEdgeTop;
    if (netEdgeTop < S.minEdge) return this.#reject('marge insuffisante', diag);

    // ── Dimensionnement : Kelly fractionnaire, puis plafonds de risque ──
    // Pari binaire achete au prix c avec probabilite de gain p : f* = (p-c)/(1-c).
    const kelly = clamp((sideProb - topAsk) / (1 - topAsk), 0, 1);
    const budget = Math.min(
      this.cfg.risk.bankroll * S.kellyFraction * kelly,
      this.cfg.risk.maxNotionalPerMarket,
      Math.max(0, this.cfg.risk.maxTotalNotional - exposure),
    );
    diag.kelly = kelly;
    diag.budget = budget;
    if (budget < this.cfg.risk.minNotional) return this.#reject('budget sous le minimum', diag);

    // Impact de marche : on suppose qu'une partie de la liquidite affichee
    // disparait pendant notre latence, prise par des acteurs plus rapides.
    const availability = clamp(1 - this.cfg.exec.simQueueLossPct, 0, 1);
    const swept = view.buySweep(budget / topAsk, availability);
    if (!(swept.filled > 0) || !(swept.avgPrice > 0)) return this.#reject('liquidite insuffisante', diag);

    const shares = swept.filled;
    const entryPrice = swept.avgPrice;
    const notional = shares * entryPrice;
    diag.notional = notional;
    if (notional < this.cfg.risk.minNotional) return this.#reject('taille executable trop petite', diag);

    const netEdge = sideProb - entryPrice
      - roundTripCostPerShare({ entryPrice, expectedExitPrice: sideProb, feeBps: P.takerFeeBps })
      - M.modelUncertainty;
    diag.netEdge = netEdge;
    if (netEdge < S.minEdge) return this.#reject('marge insuffisante apres impact', diag);

    return {
      signal: {
        marketId: market.id,
        question: market.question,
        token: outcome === 'YES' ? market.tokenYes : market.tokenNo,
        outcome,
        syntheticBook: view.synthetic,
        entryPrice,
        topPrice: topAsk,
        shares,
        notional,
        fairProb: fair,
        sideProb,
        netEdge,
        grossEdge: sideProb - entryPrice,
        kelly,
        impulse,
        marketMove,
        unabsorbed,
        bookStalenessMs,
        bookTopChanges: view.topChanges,
        volAnnual,
        spot: spotNow,
        strike: market.strike,
        tteMs,
        ts: now,
      },
      reason: 'signal',
      diag,
    };
  }

  /**
   * Decide de la sortie d'une position ouverte.
   * @returns {{exit: boolean, reason: string, price: number|null, edge: number}}
   */
  evaluateExit({ position, market, yesBook, noBook, spot, now }) {
    const S = this.cfg.strategy;
    const view = TokenView.for(position.outcome, yesBook, noBook);
    if (!view.hasTop) return { exit: false, reason: 'carnet vide', price: null, edge: 0 };

    // On liquide en vendant ce que l'on detient : prix atteignable = meilleure demande.
    const exitPrice = view.bid;
    const volAnnual = spot.volAnnual * this.cfg.model.volMultiplier;
    const fair = fairProbability(market, { spot: spot.price, volAnnual, now });
    const sideProb = position.outcome === 'YES' ? fair.prob : 1 - fair.prob;
    // Marge residuelle : ce qu'il reste a capturer si l'on garde la position.
    const residual = Number.isFinite(sideProb) && exitPrice !== null ? sideProb - exitPrice : 0;
    const held = now - position.openedTs;

    if (market.expiryTs - now < S.minTimeToExpiryMs) {
      return { exit: true, reason: 'echeance imminente', price: exitPrice, edge: residual };
    }
    if (residual < -S.stopEdge) {
      return { exit: true, reason: 'coupe-circuit', price: exitPrice, edge: residual };
    }
    if (held > S.maxHoldMs) {
      return { exit: true, reason: 'duree maximale atteinte', price: exitPrice, edge: residual };
    }
    // Le marche s'est realigne sur le juste prix : le retard est consomme, on sort.
    if (residual <= S.exitEdge) {
      return { exit: true, reason: 'realignement du marche', price: exitPrice, edge: residual };
    }
    // Le carnet a repris la main (son sommet a rebouge plusieurs fois depuis
    // notre entree) mais la marge n'est pas revenue a zero : ce qui reste n'est
    // plus du retard, c'est un desaccord avec le marche. Garder la position
    // reviendrait a parier sur la direction du BTC — precisement ce que cette
    // strategie s'interdit.
    const topMoves = view.topChanges - (position.entryTopChanges ?? 0);
    if (topMoves >= S.repriceExitTicks && residual < S.minEdge) {
      return { exit: true, reason: 'retard consomme', price: exitPrice, edge: residual };
    }
    return { exit: false, reason: 'en cours', price: exitPrice, edge: residual };
  }
}
