import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/runners/probe.js';
import { Engine } from '../src/engine.js';
import { NullBroker } from '../src/exec/null.js';
import { LocalBookStore } from '../src/replay/local-books.js';
import { withOverrides } from '../src/config.js';

const NOW = Date.now();

function marche(id, strike) {
  return {
    id,
    question: `Will Bitcoin be above $${strike} today?`,
    kind: 'threshold',
    side: 'above',
    strike,
    expiryTs: NOW + 2.4 * 3600_000,
    tokenYes: `${id}-Y`,
    tokenNo: `${id}-N`,
    minTickSize: 0.001,
  };
}

/** Monte un moteur reel alimente par des carnets en memoire. */
function contexte(marches, carnets, spot = 63_040) {
  const cfg = withOverrides({});
  const books = new LocalBookStore();
  const engine = new Engine(cfg, { broker: new NullBroker(), bookProvider: books, now: () => NOW });
  engine.setMarkets(marches);

  for (const [token, niveaux] of Object.entries(carnets)) {
    books.set(token, { ...niveaux, ts: NOW - 60_000 });
  }
  // Une trajectoire spot plate mais reelle, pour que la volatilite existe.
  for (let i = 0; i < 400; i += 1) {
    const p = spot * (1 + Math.sin(i / 7) * 0.0002);
    engine.spot.onQuote({ venue: 'binance', bid: p - 1, ask: p + 1, mid: p, ts: NOW - (400 - i) * 1_000 });
  }
  return { cfg, engine, books };
}

test('un marche colle a 0,999 est classe joue, pas lent', () => {
  const m = marche('joue', 60_000);
  const { cfg, engine, books } = contexte([m], {
    'joue-Y': { bids: [{ price: 0.999, size: 500 }], asks: [] },
    'joue-N': { bids: [], asks: [{ price: 0.001, size: 500 }] },
  });

  // Un carnet immobile depuis trois minutes : sans filtre, il passerait pour
  // une enorme fenetre de retard.
  const r = buildReport({ cfg, engine, books, markets: [m], intervals: new Map([['joue-Y', [190_000, 195_000]]]) });

  assert.equal(r.lignes[0].vivant, false);
  assert.equal(r.nbVivants, 0);
  assert.equal(r.figeGlobal, null, 'un marche joue ne doit pas alimenter la statistique de figement');
});

test('un marche a deux cotes dans la fourchette est classe vivant', () => {
  const m = marche('vivant', 63_500);
  const { cfg, engine, books } = contexte([m], {
    'vivant-Y': { bids: [{ price: 0.44, size: 500 }], asks: [{ price: 0.46, size: 500 }] },
    'vivant-N': { bids: [{ price: 0.54, size: 500 }], asks: [{ price: 0.56, size: 500 }] },
  });

  const r = buildReport({ cfg, engine, books, markets: [m], intervals: new Map([['vivant-Y', [800, 1_200, 950]]]) });

  assert.equal(r.lignes[0].vivant, true);
  assert.equal(r.nbVivants, 1);
  assert.equal(r.figeGlobal.echantillons, 3);
  assert.equal(r.figeGlobal.median, 950);
});

test('la volatilite implicite du marche est rapportee a cote de celle mesuree', () => {
  const m = marche('calibrage', 64_000);
  const { cfg, engine, books } = contexte([m], {
    'calibrage-Y': { bids: [{ price: 0.08, size: 500 }], asks: [{ price: 0.10, size: 500 }] },
    'calibrage-N': { bids: [{ price: 0.90, size: 500 }], asks: [{ price: 0.92, size: 500 }] },
  });

  const r = buildReport({ cfg, engine, books, markets: [m], intervals: new Map() });
  assert.ok(r.lignes[0].volImplicite > 0, 'la volatilite implicite doit etre calculable');
  assert.equal(r.volImpliciteMediane, r.lignes[0].volImplicite);
});

test('seuls les marches vivants alimentent la statistique globale', () => {
  const vivant = marche('v', 63_500);
  const joue = marche('j', 50_000);
  const { cfg, engine, books } = contexte([vivant, joue], {
    'v-Y': { bids: [{ price: 0.44, size: 500 }], asks: [{ price: 0.46, size: 500 }] },
    'v-N': { bids: [{ price: 0.54, size: 500 }], asks: [{ price: 0.56, size: 500 }] },
    'j-Y': { bids: [{ price: 0.999, size: 500 }], asks: [] },
    'j-N': { bids: [], asks: [{ price: 0.001, size: 500 }] },
  });

  const r = buildReport({
    cfg,
    engine,
    books,
    markets: [vivant, joue],
    intervals: new Map([['v-Y', [1_000, 1_000]], ['j-Y', [200_000, 200_000]]]),
  });

  assert.equal(r.nbVivants, 1);
  assert.equal(r.figeGlobal.echantillons, 2);
  assert.equal(r.figeGlobal.median, 1_000, 'les 200 s du marche joue ne doivent pas polluer la mediane');
});
