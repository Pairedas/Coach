import { EventEmitter } from 'node:events';
import { SpotTape } from './feeds/spot.js';
import { LatencyArbStrategy } from './strategy/latency-arb.js';
import { TokenView } from './strategy/token-view.js';
import { RiskManager } from './risk/limits.js';
import { Portfolio } from './portfolio.js';
import { logger } from './util/log.js';

/**
 * Moteur : assemble les flux, la strategie, le risque et l'execution.
 *
 * Il est volontairement agnostique de la source des donnees — les memes
 * fonctions traitent un flux temps reel, un rejeu d'enregistrement ou une
 * simulation. C'est ce qui permet de tester la logique sans marche ouvert.
 */
export class Engine extends EventEmitter {
  constructor(cfg, { broker, bookProvider, now = () => Date.now(), recorder = null }) {
    super();
    this.cfg = cfg;
    this.log = logger('moteur');
    this.now = now;
    this.broker = broker;
    this.books = bookProvider;
    this.recorder = recorder;

    this.spot = new SpotTape({
      weights: cfg.spot.weights,
      stalenessMs: cfg.spot.stalenessMs,
      historyMs: cfg.spot.historyMs,
      volHalfLifeSec: cfg.model.volHalfLifeSec,
      seedVolAnnual: cfg.model.seedVolAnnual,
      volSampleMs: cfg.model.volSampleMs,
      referenceVenue: cfg.spot.referenceVenue,
      basisHalfLifeSec: cfg.spot.basisHalfLifeSec,
    });
    this.strategy = new LatencyArbStrategy(cfg);
    this.risk = new RiskManager(cfg);
    this.portfolio = new Portfolio();

    this.markets = new Map();
    this.inFlight = new Map(); // marketId -> { kind: 'entry'|'exit', ts }
    this.lastEvalTs = 0;
    this.signalsSeen = 0;
    this.ordersSubmitted = 0;
    this.ordersRejected = 0;

    this.broker.on('fill', (f) => this.#onFill(f));
    this.broker.on('reject', (r) => this.#onReject(r));
  }

  setMarkets(markets) {
    this.markets = new Map(markets.map((m) => [m.id, m]));
  }

  market(id) { return this.markets.get(id); }

  /** Vue du jeton detenu / vise, cote YES ou NO. */
  viewFor(market, outcome) {
    return TokenView.for(outcome, this.books.book(market.tokenYes), this.books.book(market.tokenNo));
  }

  /** Point d'entree unique : appele apres chaque mise a jour de prix ou de carnet. */
  step(now = this.now()) {
    this.broker.tick(now);

    // Les carnets alimentent l'historique des cotes meme sans evaluation :
    // la detection de non-absorption en depend.
    for (const market of this.markets.values()) {
      this.strategy.observe(market, this.books.book(market.tokenYes), now);
    }

    this.#manageExits(now);

    // On limite la frequence d'evaluation : au-dela, on brule du CPU sans
    // information nouvelle, les carnets Polymarket ne bougeant pas si vite.
    if (now - this.lastEvalTs < 50) return;
    this.lastEvalTs = now;
    this.#lookForEntries(now);
  }

  #lookForEntries(now) {
    for (const market of this.markets.values()) {
      if (this.inFlight.has(market.id)) continue;
      if (this.portfolio.positions.has(market.id)) continue;

      const { signal } = this.strategy.evaluateEntry({
        market,
        yesBook: this.books.book(market.tokenYes),
        noBook: this.books.book(market.tokenNo),
        spot: this.spot,
        now,
        exposure: this.portfolio.exposure,
      });
      if (!signal) continue;

      this.signalsSeen += 1;
      const gate = this.risk.canOpen({
        now,
        openPositions: this.portfolio.open,
        exposure: this.portfolio.exposure,
        marketId: market.id,
        notional: signal.notional,
      });
      if (!gate.ok) {
        this.log.debug(`signal bloque par le risque : ${gate.reason}`);
        this.emit('blocked', { signal, reason: gate.reason });
        continue;
      }

      // Limite d'entree : on accepte de payer un peu plus que le sommet affiche,
      // mais jamais au point d'effacer la marge minimale.
      const slack = Math.max(0, signal.netEdge - this.cfg.strategy.minEdge);
      const limitPrice = Math.min(signal.entryPrice + slack, signal.sideProb - this.cfg.strategy.minEdge);

      this.strategy.markEntry(market.id, now);
      this.inFlight.set(market.id, { kind: 'entry', ts: now, signal });
      this.ordersSubmitted += 1;
      this.broker.submit({
        marketId: market.id,
        token: signal.token,
        outcome: signal.outcome,
        side: 'buy',
        shares: signal.shares,
        limitPrice,
        now,
        resolveView: () => this.viewFor(market, signal.outcome),
      });
      this.emit('signal', signal);
      this.recorder?.write({ type: 'signal', ts: now, signal });
    }
  }

  #manageExits(now) {
    for (const position of this.portfolio.open) {
      if (this.inFlight.has(position.marketId)) continue;
      const market = this.market(position.marketId);
      if (!market) continue;

      const decision = this.strategy.evaluateExit({
        position,
        market,
        yesBook: this.books.book(market.tokenYes),
        noBook: this.books.book(market.tokenNo),
        spot: this.spot,
        now,
      });
      if (!decision.exit || decision.price === null) continue;

      // A la sortie on accepte de ceder quelques ticks : rester coince dans une
      // position parce que la limite est trop serree coute plus cher que le tick.
      const limitPrice = Math.max(0.001, decision.price - 3 * this.cfg.polymarket.minTickSize);
      this.inFlight.set(position.marketId, { kind: 'exit', ts: now, reason: decision.reason });
      this.broker.submit({
        marketId: position.marketId,
        token: position.token,
        outcome: position.outcome,
        side: 'sell',
        shares: position.shares,
        limitPrice,
        now,
        reason: decision.reason,
        resolveView: () => this.viewFor(market, position.outcome),
      });
    }
  }

  #onFill(fill) {
    const { order } = fill;
    const market = this.market(order.marketId);
    const flight = this.inFlight.get(order.marketId);
    this.inFlight.delete(order.marketId);
    if (!market) return;

    if (order.side === 'buy') {
      const position = this.portfolio.openPosition({ market, signal: flight?.signal ?? order, fill, now: fill.ts });
      this.emit('open', position);
      this.recorder?.write({ type: 'open', ts: fill.ts, position });
    } else {
      const record = this.portfolio.closePosition({
        marketId: order.marketId,
        exitPrice: fill.avgPrice,
        exitFee: fill.fee,
        reason: order.reason ?? 'sortie',
        now: fill.ts,
        filledShares: fill.filled,
      });
      if (record) {
        this.risk.recordClose(record.pnl, fill.ts);
        this.emit('close', record);
        this.recorder?.write({ type: 'close', ts: fill.ts, record });
      }
    }
  }

  #onReject({ order, reason, ts }) {
    this.inFlight.delete(order.marketId);
    this.ordersRejected += 1;
    this.log.info(`ordre non execute (${order.side}) : ${reason}`);
    this.emit('reject', { order, reason, ts });
    this.recorder?.write({ type: 'reject', ts, marketId: order.marketId, side: order.side, reason });
  }

  /** Etat complet, consomme par le tableau de bord et les rapports. */
  snapshot() {
    return {
      ts: this.now(),
      mode: this.broker.mode,
      spot: this.spot.snapshot(),
      markets: [...this.markets.values()].map((m) => {
        const yesBook = this.books.book(m.tokenYes);
        return {
          id: m.id,
          question: m.question,
          kind: m.kind,
          strike: m.strike,
          expiryTs: m.expiryTs,
          bestBid: yesBook.bestBid,
          bestAsk: yesBook.bestAsk,
          bookAgeMs: yesBook.lastTopChangeTs ? this.now() - yesBook.lastTopChangeTs : null,
        };
      }),
      positions: this.portfolio.open,
      closed: this.portfolio.closed.slice(-25),
      stats: this.portfolio.stats(),
      risk: this.risk.snapshot(),
      counters: {
        signals: this.signalsSeen,
        submitted: this.ordersSubmitted,
        rejected: this.ordersRejected,
        pending: this.broker.pendingCount,
      },
      rejections: Object.fromEntries([...this.strategy.rejections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    };
  }
}
