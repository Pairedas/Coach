import { EventEmitter } from 'node:events';
import { logger } from '../util/log.js';

/**
 * Execution reelle sur Polymarket.
 *
 * Ce module ne reimplemente PAS la signature EIP-712 des ordres : la faire soi-
 * meme est le meilleur moyen de perdre des fonds sur une erreur de domaine ou de
 * nonce. Il s'appuie sur le client officiel `@polymarket/clob-client`, qui n'est
 * volontairement pas une dependance du projet — tant qu'il n'est pas installe,
 * le mode reel refuse simplement de demarrer.
 *
 *   npm install @polymarket/clob-client ethers
 *
 * Avant d'activer quoi que ce soit ici : verifie que le trading Polymarket est
 * autorise depuis ta juridiction, et que les cles fournies pointent vers un
 * portefeuille dedie, jamais ton portefeuille principal.
 */
export class LiveBroker extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = logger('reel');
    this.client = null;
    this.mode = 'reel';
    this.pending = new Map();
  }

  async connect() {
    const { exec } = this.cfg;
    if (!exec.live) throw new Error('mode reel non active (LIVE_TRADING)');
    if (exec.liveConfirm !== 'JE COMPRENDS LES RISQUES') {
      throw new Error('LIVE_CONFIRM manquant : le mode reel exige une confirmation explicite');
    }
    if (!exec.privateKey) throw new Error('POLYMARKET_PRIVATE_KEY manquante');
    if (!exec.apiKey || !exec.apiSecret || !exec.apiPassphrase) {
      throw new Error('cles API CLOB incompletes (POLYMARKET_API_KEY / _SECRET / _PASSPHRASE)');
    }

    let ClobClient;
    let Wallet;
    try {
      ({ ClobClient } = await import('@polymarket/clob-client'));
      ({ Wallet } = await import('ethers'));
    } catch (err) {
      throw new Error(
        'client officiel absent. Installe-le avant d\'activer le mode reel :\n' +
        '  npm install @polymarket/clob-client ethers\n' +
        `(cause : ${err.message})`,
      );
    }

    const signer = new Wallet(exec.privateKey);
    this.client = new ClobClient(
      this.cfg.polymarket.clobUrl,
      137, // Polygon
      signer,
      { key: exec.apiKey, secret: exec.apiSecret, passphrase: exec.apiPassphrase },
      exec.funderAddress ? 1 : undefined,
      exec.funderAddress || undefined,
    );
    this.log.warn(`mode REEL actif — portefeuille ${await signer.getAddress()}`);
    return this;
  }

  /**
   * Ordre limite immediat-ou-annule : jamais d'ordre au marche sur un carnet
   * fin, la limite est la seule protection contre un carnet vide.
   */
  submit(order) {
    if (!this.client) throw new Error('LiveBroker.connect() n\'a pas ete appele');
    const id = `${order.token}-${order.now}`;
    this.pending.set(id, order);

    void (async () => {
      try {
        const signed = await this.client.createOrder({
          tokenID: order.token,
          price: round(order.limitPrice, this.cfg.polymarket.minTickSize),
          size: Number(order.shares.toFixed(2)),
          side: order.side === 'buy' ? 'BUY' : 'SELL',
        });
        // FOK : soit l'ordre est servi immediatement, soit il disparait.
        const res = await this.client.postOrder(signed, 'FOK');
        this.pending.delete(id);

        const filled = Number(res?.takingAmount ?? res?.size_matched ?? 0);
        if (!res?.success || !(filled > 0)) {
          this.emit('reject', { order, reason: res?.errorMsg ?? 'ordre non execute', ts: Date.now() });
          return;
        }
        const avgPrice = Number(res?.price ?? order.limitPrice);
        this.emit('fill', { order, filled, avgPrice, fee: Number(res?.fee ?? 0), partial: false, ts: Date.now() });
      } catch (err) {
        this.pending.delete(id);
        this.log.error(`echec d'envoi : ${err.message}`);
        this.emit('reject', { order, reason: err.message, ts: Date.now() });
      }
    })();

    return id;
  }

  tick() { /* le CLOB nous notifie, rien a cadencer */ }
  get pendingCount() { return this.pending.size; }
  stop() { this.pending.clear(); }
}

function round(price, tick) {
  const t = tick > 0 ? tick : 0.001;
  return Math.round(price / t) * t;
}
