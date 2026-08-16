import { EventEmitter } from 'node:events';
import { takerFee } from '../model/costs.js';
import { clamp } from '../util/stats.js';
import { logger } from '../util/log.js';

/**
 * Execution simulee, mais pas complaisante. Deux effets sont modelises parce
 * qu'ils suffisent a effacer la marge d'une strategie de latence :
 *
 *  - LATENCE : l'ordre n'est pas execute a l'instant de la decision mais
 *    `simLatencyMs` plus tard, contre le carnet tel qu'il est devenu. Si le
 *    retard a ete comble entre-temps, l'ordre n'est pas execute — c'est
 *    exactement ce qui arrive en reel quand un acteur plus rapide passe devant.
 *  - FILE D'ATTENTE : seule une fraction `1 - simQueueLossPct` de la taille
 *    affichee est reellement atteignable.
 *
 * Les ordres sont declenches par `tick(now)`, ce qui rend la simulation
 * identique en temps reel et en rejeu accelere.
 */
export class PaperBroker extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = logger('papier');
    this.pending = [];
    this.seq = 0;
    this.mode = 'papier';
  }

  /**
   * @param {object} order
   * @param {'buy'|'sell'} order.side
   * @param {number} order.shares
   * @param {number} order.limitPrice prix limite dans l'espace du jeton
   * @param {() => object} order.resolveView renvoie la TokenView courante
   */
  submit(order) {
    const id = ++this.seq;
    this.pending.push({ ...order, id, fillAtTs: order.now + this.cfg.exec.simLatencyMs });
    return id;
  }

  /** Traite les ordres arrives a echeance de latence. */
  tick(now) {
    if (this.pending.length === 0) return;
    const due = this.pending.filter((o) => o.fillAtTs <= now);
    if (due.length === 0) return;
    this.pending = this.pending.filter((o) => o.fillAtTs > now);

    const availability = clamp(1 - this.cfg.exec.simQueueLossPct, 0, 1);
    for (const order of due) {
      const view = order.resolveView();
      if (!view?.hasTop) {
        this.emit('reject', { order, reason: 'carnet indisponible a l\'execution', ts: now });
        continue;
      }
      const swept = order.side === 'buy'
        ? view.buySweep(order.shares, availability, order.limitPrice)
        : view.sellSweep(order.shares, availability, order.limitPrice);

      if (!(swept.filled > 0)) {
        // Le prix a bouge au-dela de la limite pendant la latence : ordre mort.
        this.emit('reject', { order, reason: 'prix parti avant execution', ts: now });
        continue;
      }
      const fee = takerFee(swept.avgPrice, swept.filled, this.cfg.polymarket.takerFeeBps);
      this.emit('fill', {
        order,
        filled: swept.filled,
        avgPrice: swept.avgPrice,
        fee,
        partial: swept.filled < order.shares - 1e-9,
        ts: now,
      });
    }
  }

  get pendingCount() { return this.pending.length; }
  stop() { this.pending = []; }
}
