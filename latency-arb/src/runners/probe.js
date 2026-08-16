import { config, validateConfig } from '../config.js';
import { NullBroker } from '../exec/null.js';
import { buildSession } from './session.js';
import { quantile } from '../util/stats.js';
import { fairProbability } from '../model/pricer.js';
import { logger } from '../util/log.js';

const log = logger('diagnostic');

/**
 * Mode diagnostic : observe le marche sans jamais engager d'ordre, et repond a
 * la seule question qui decide de la viabilite de la strategie —
 *
 *   « Combien de temps le carnet Polymarket reste-t-il fige, et cette duree
 *     est-elle superieure a ma propre latence ? »
 *
 * Si la mediane des intervalles entre deux re-cotations est inferieure a la
 * latence d'execution, il n'y a rien a prendre, et aucun reglage n'y changera
 * quoi que ce soit.
 */
export async function runProbe({ seconds = 120 } = {}) {
  const cfg = validateConfig(config);
  const broker = new NullBroker();
  const { engine, books, refresh, start, stop } = buildSession(cfg, { broker });

  // Intervalles entre deux changements de sommet de carnet, par jeton.
  const intervals = new Map();
  const lastChange = new Map();
  const lastCount = new Map();

  books.on('book', (assetId) => {
    const b = books.book(assetId);
    if ((lastCount.get(assetId) ?? 0) === b.topChanges) return; // le sommet n'a pas bouge
    lastCount.set(assetId, b.topChanges);
    const previous = lastChange.get(assetId);
    if (previous) {
      if (!intervals.has(assetId)) intervals.set(assetId, []);
      intervals.get(assetId).push(b.lastTopChangeTs - previous);
    }
    lastChange.set(assetId, b.lastTopChangeTs);
  });

  start();
  const markets = await refresh();
  books.start();
  if (markets.length === 0) {
    log.error('aucun marche a observer — rien a diagnostiquer');
    stop();
    return null;
  }

  log.info(`observation de ${markets.length} marche(s) pendant ${seconds} s — aucun ordre ne sera envoye`);
  const heartbeat = setInterval(() => engine.step(Date.now()), 500);

  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  clearInterval(heartbeat);

  const rapport = buildReport({ cfg, engine, books, markets, intervals });
  printReport(rapport, cfg);
  stop();
  return rapport;
}

function buildReport({ cfg, engine, books, markets, intervals }) {
  const now = Date.now();
  const spot = engine.spot.price;

  const lignes = markets.map((m) => {
    const book = books.book(m.tokenYes);
    const ech = intervals.get(m.tokenYes) ?? [];
    const { signal, reason } = engine.strategy.evaluateEntry({
      market: m,
      yesBook: book,
      noBook: books.book(m.tokenNo),
      spot: engine.spot,
      now,
      exposure: 0,
    });
    // Juste prix implique par le spot, a comparer a la cote affichee : c'est
    // l'ecart brut, avant tout filtre de retard.
    const fair = spot > 0 && m.strike > 0
      ? fairProbability(m, { spot, volAnnual: engine.spot.volAnnual * cfg.model.volMultiplier, now }).prob
      : null;

    return {
      question: m.question,
      strike: m.strike,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      recotations: book.topChanges,
      figeMedianMs: ech.length ? quantile(ech, 0.5) : null,
      figeP90Ms: ech.length ? quantile(ech, 0.9) : null,
      verdict: signal ? 'signal' : reason,
      juste: Number.isFinite(fair) ? fair : null,
      ecart: Number.isFinite(fair) && book.bestAsk !== null ? fair - book.bestAsk : null,
    };
  });

  const toutes = [...intervals.values()].flat();
  return {
    spot,
    volAnnual: engine.spot.volAnnual,
    venueSpreadBps: engine.spot.venueSpreadBps(),
    spotUpdates: engine.spot.updates,
    lignes,
    figeGlobal: toutes.length
      ? { echantillons: toutes.length, p25: quantile(toutes, 0.25), median: quantile(toutes, 0.5), p75: quantile(toutes, 0.75), p90: quantile(toutes, 0.9) }
      : null,
    rejets: Object.fromEntries(
      [...engine.strategy.rejections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    ),
    latenceExecMs: cfg.exec.simLatencyMs,
  };
}

function printReport(r, cfg) {
  const ms = (x) => (x === null ? '—' : `${Math.round(x)} ms`);
  const px = (x) => (x === null || x === undefined ? '—' : x.toFixed(3));

  console.log('\n═══ DIAGNOSTIC ═══\n');
  console.log(`Spot consolide      : ${r.spot ? r.spot.toFixed(1) : 'indisponible'} USD`);
  console.log(`Volatilite estimee  : ${(r.volAnnual * 100).toFixed(0) } %`);
  console.log(`Ecart entre places  : ${r.venueSpreadBps.toFixed(2)} points de base`);
  console.log(`Ticks spot recus    : ${r.spotUpdates}`);

  console.log('\n── Marches observes ──\n');
  for (const l of r.lignes) {
    console.log(`  ${l.question.slice(0, 68)}`);
    console.log(`    seuil ${l.strike?.toFixed(0) ?? '—'} · achat ${px(l.bestBid)} · vente ${px(l.bestAsk)} · spread ${px(l.spread)}`);
    console.log(`    juste prix ${px(l.juste)} · ecart brut ${l.ecart === null ? '—' : (l.ecart * 100).toFixed(1) + ' pts'}`);
    console.log(`    re-cotations ${l.recotations} · fige median ${ms(l.figeMedianMs)} · p90 ${ms(l.figeP90Ms)}`);
    console.log(`    verdict : ${l.verdict}`);
  }

  console.log('\n── Duree pendant laquelle le carnet reste fige (tous marches) ──\n');
  if (!r.figeGlobal) {
    console.log('  Aucune re-cotation observee. Soit les carnets sont morts, soit le flux');
    console.log('  WebSocket ne remonte pas — verifie que des messages arrivent.');
  } else {
    const g = r.figeGlobal;
    console.log(`  echantillons ${g.echantillons} · p25 ${ms(g.p25)} · median ${ms(g.median)} · p75 ${ms(g.p75)} · p90 ${ms(g.p90)}`);
    console.log(`\n  Ta latence d'execution supposee : ${r.latenceExecMs} ms`);
    if (g.median > r.latenceExecMs * 3) {
      console.log('  => Le carnet reste fige nettement plus longtemps que ta latence.');
      console.log('     Il y a une fenetre a exploiter. Passe a `npm run record`.');
    } else if (g.median > r.latenceExecMs) {
      console.log('  => La fenetre existe mais elle est etroite. La marge sera fragile,');
      console.log('     et tres sensible a ta latence reelle. Mesure avant d\'engager.');
    } else {
      console.log('  => Le carnet se re-cote plus vite que tu ne peux agir.');
      console.log('     Il n\'y a rien a prendre ici, et aucun reglage n\'y changera rien.');
    }
  }

  if (Object.keys(r.rejets).length) {
    console.log('\n── Pourquoi aucun signal n\'a ete retenu ──\n');
    for (const [motif, n] of Object.entries(r.rejets)) {
      console.log(`  ${String(n).padStart(7)}  ${motif}`);
    }
  }
  console.log('');
}
