import { EventEmitter } from 'node:events';
import { logger } from '../util/log.js';

/**
 * WebSocket avec reconnexion automatique (backoff exponentiel + gigue).
 * Utilise le WebSocket global de Node >= 22 : aucune dependance externe.
 */
export class ReconnectingSocket extends EventEmitter {
  constructor(url, { name = 'ws', onOpen = null, pingMs = 0, maxBackoffMs = 30_000 } = {}) {
    super();
    this.url = url;
    this.name = name;
    this.onOpen = onOpen;
    this.pingMs = pingMs;
    this.maxBackoffMs = maxBackoffMs;
    this.log = logger(name);
    this.attempt = 0;
    this.stopped = false;
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  #connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.log.error(`connexion impossible : ${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.log.info('connecte');
      this.emit('open');
      if (this.onOpen) {
        try {
          const payload = this.onOpen();
          if (payload) this.send(payload);
        } catch (err) {
          this.log.error(`echec du message d'abonnement : ${err.message}`);
        }
      }
      if (this.pingMs > 0) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: 'PING' }), this.pingMs);
        this.pingTimer.unref?.();
      }
    });

    ws.addEventListener('message', (ev) => {
      // Polymarket renvoie « PONG » en texte brut : on ne tente pas de le parser.
      if (typeof ev.data === 'string' && (ev.data === 'PONG' || ev.data === 'pong')) return;
      let parsed;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        this.log.debug('message non-JSON ignore');
        return;
      }
      this.emit('message', parsed);
    });

    ws.addEventListener('error', (ev) => {
      this.log.warn(`erreur socket : ${ev?.message ?? 'inconnue'}`);
    });

    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      this.emit('close');
      if (!this.stopped) {
        this.log.warn('deconnecte');
        this.#scheduleReconnect();
      }
    });
  }

  #scheduleReconnect() {
    this.attempt += 1;
    const base = Math.min(1000 * 2 ** (this.attempt - 1), this.maxBackoffMs);
    const delay = base * (0.7 + Math.random() * 0.6);
    this.log.info(`reconnexion dans ${Math.round(delay)} ms (essai ${this.attempt})`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    this.reconnectTimer.unref?.();
  }

  send(obj) {
    if (this.ws?.readyState === 1) {
      this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
      return true;
    }
    return false;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* deja ferme */ }
  }
}
