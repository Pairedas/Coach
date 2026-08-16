import { logger } from '../util/log.js';

/**
 * Garde-fous de risque. Ils sont volontairement contraignants : la strategie
 * gagne peu par operation, donc une seule perte non bornee efface des dizaines
 * de gains. Le coupe-circuit journalier ne se rearme pas tout seul.
 */
export class RiskManager {
  constructor(cfg) {
    this.cfg = cfg.risk;
    this.log = logger('risque');
    this.realizedPnl = 0;
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.consecutiveLosses = 0;
    this.halted = false;
    this.haltReason = '';
  }

  #rollDayIfNeeded(now) {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.realizedPnl = 0;
      this.consecutiveLosses = 0;
      // Un arret journalier expire avec la journee ; un arret manuel, non.
      if (this.haltReason === 'limite de perte journaliere') this.resume();
    }
  }

  /** @returns {{ok: boolean, reason?: string}} */
  canOpen({ now, openPositions, exposure, marketId, notional }) {
    this.#rollDayIfNeeded(now);
    if (this.halted) return { ok: false, reason: `arret : ${this.haltReason}` };
    if (openPositions.length >= this.cfg.maxPositions) return { ok: false, reason: 'nombre maximal de positions atteint' };
    if (openPositions.some((p) => p.marketId === marketId)) return { ok: false, reason: 'position deja ouverte sur ce marche' };
    if (notional < this.cfg.minNotional) return { ok: false, reason: 'notionnel sous le minimum' };
    if (notional > this.cfg.maxNotionalPerMarket) return { ok: false, reason: 'notionnel au-dessus du plafond par marche' };
    if (exposure + notional > this.cfg.maxTotalNotional) return { ok: false, reason: 'exposition totale au plafond' };
    return { ok: true };
  }

  /** Enregistre un resultat realise et declenche l'arret si les limites sont franchies. */
  recordClose(pnl, now = Date.now()) {
    this.#rollDayIfNeeded(now);
    this.realizedPnl += pnl;
    this.consecutiveLosses = pnl < 0 ? this.consecutiveLosses + 1 : 0;

    if (this.realizedPnl <= -this.cfg.dailyLossLimit) {
      this.halt('limite de perte journaliere');
    } else if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      // Une serie de pertes signale generalement un modele fausse, pas de la malchance.
      this.halt('trop de pertes consecutives');
    }
  }

  halt(reason) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    this.log.error(`COUPE-CIRCUIT ACTIVE — ${reason}. Plus aucune ouverture.`);
  }

  resume() {
    this.halted = false;
    this.haltReason = '';
    this.log.warn('coupe-circuit desarme');
  }

  snapshot() {
    return {
      realizedPnl: this.realizedPnl,
      consecutiveLosses: this.consecutiveLosses,
      halted: this.halted,
      haltReason: this.haltReason,
      dayKey: this.dayKey,
    };
  }
}
