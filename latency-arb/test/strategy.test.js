import test from 'node:test';
import assert from 'node:assert/strict';
import { LatencyArbStrategy } from '../src/strategy/latency-arb.js';
import { Book } from '../src/polymarket/book.js';
import { withOverrides } from '../src/config.js';

const NOW = 1_700_000_000_000;

const market = {
  id: 'm1',
  question: 'Bitcoin Up or Down (test)',
  kind: 'updown',
  side: 'above',
  strike: 100_000,
  expiryTs: NOW + 1_800_000,
  tokenYes: 'YES',
  tokenNo: 'NO',
  minTickSize: 0.01,
};

/** Bande spot factice : prix courant, prix passe et volatilite imposes. */
function fakeSpot({ price, before, vol = 0.6 }) {
  return {
    price,
    volAnnual: vol,
    isStale: () => false,
    priceAgo: () => before,
  };
}

function bookAt(mid, { ts = NOW - 5_000, size = 500 } = {}) {
  const b = new Book('YES');
  b.applySnapshot({
    bids: [{ price: +(mid - 0.01).toFixed(3), size }, { price: +(mid - 0.02).toFixed(3), size }],
    asks: [{ price: +(mid + 0.01).toFixed(3), size }, { price: +(mid + 0.02).toFixed(3), size }],
    ts,
  });
  return b;
}

const cfg = () => withOverrides({ risk: { bankroll: 1_000, maxNotionalPerMarket: 100 } });

test('un mouvement spot non absorbe par un carnet fige declenche un signal', () => {
  const strat = new LatencyArbStrategy(cfg());
  const book = bookAt(0.5);
  // Le carnet est reste a 0,50 pendant que le spot montait de 0,4 %.
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  const { signal, reason } = strat.evaluateEntry({
    market,
    yesBook: book,
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.ok(signal, `aucun signal (motif : ${reason})`);
  assert.equal(signal.outcome, 'YES', 'le BTC monte : on achete YES');
  assert.ok(signal.netEdge >= cfg().strategy.minEdge);
  assert.ok(signal.shares > 0 && signal.notional <= 100);
});

test('une baisse du spot fait acheter NO, jamais vendre a decouvert', () => {
  const strat = new LatencyArbStrategy(cfg());
  const book = bookAt(0.5);
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  const { signal } = strat.evaluateEntry({
    market,
    yesBook: book,
    spot: fakeSpot({ price: 99_600, before: 100_000 }),
    now: NOW,
  });
  assert.ok(signal);
  assert.equal(signal.outcome, 'NO');
});

test('aucun signal si le carnet a deja absorbe le mouvement', () => {
  const strat = new LatencyArbStrategy(cfg());
  // Le spot fait passer le juste prix de 0,499 a 0,810. Le carnet a suivi :
  // de 0,50 a 0,82. Il ne reste rien a arbitrer.
  const book = bookAt(0.82);
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  const { signal, reason } = strat.evaluateEntry({
    market,
    yesBook: book,
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.equal(signal, null);
  assert.equal(reason, 'mouvement deja absorbe');
});

test('un carnet qui ne suit qu\'a moitie laisse une marge exploitable', () => {
  const strat = new LatencyArbStrategy(cfg());
  // Juste prix 0,810 ; le carnet n'est monte qu'a 0,75 : le retard est partiel.
  const book = bookAt(0.75);
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  const { signal } = strat.evaluateEntry({
    market,
    yesBook: book,
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.ok(signal, 'un rattrapage incomplet reste un signal valide');
  assert.ok(signal.marketMove > 0 && Math.abs(signal.unabsorbed) > 0.02);
});

test('aucun signal si le carnet vient de bouger', () => {
  const strat = new LatencyArbStrategy(cfg());
  const book = bookAt(0.5, { ts: NOW - 100 }); // sommet rafraichi il y a 100 ms
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  const { signal, reason } = strat.evaluateEntry({
    market,
    yesBook: book,
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.equal(signal, null);
  assert.equal(reason, 'carnet trop reactif');
});

test('aucun signal quand le spot n\'a pas bouge', () => {
  const strat = new LatencyArbStrategy(cfg());
  const { signal, reason } = strat.evaluateEntry({
    market,
    yesBook: bookAt(0.5),
    spot: fakeSpot({ price: 100_000, before: 100_000 }),
    now: NOW,
  });
  assert.equal(signal, null);
  assert.equal(reason, 'impulsion trop faible');
});

test('un spot fige bloque toute entree', () => {
  const strat = new LatencyArbStrategy(cfg());
  const spot = { ...fakeSpot({ price: 100_400, before: 100_000 }), isStale: () => true };
  const { signal, reason } = strat.evaluateEntry({ market, yesBook: bookAt(0.5), spot, now: NOW });
  assert.equal(signal, null);
  assert.equal(reason, 'spot fige');
});

test('des frais suffisants effacent une marge qui passait sans eux', () => {
  // Juste prix 0,5691 contre une offre a 0,51 : environ 6 points de marge brute.
  const spot = fakeSpot({ price: 100_080, before: 100_000 });
  const entree = (config) => {
    const strat = new LatencyArbStrategy(config);
    strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
    return strat.evaluateEntry({ market, yesBook: bookAt(0.5), spot, now: NOW });
  };

  const sansFrais = entree(cfg());
  assert.ok(sansFrais.signal, `signal attendu sans frais (motif : ${sansFrais.reason})`);

  const avecFrais = entree(withOverrides({ polymarket: { takerFeeBps: 900 }, risk: { bankroll: 1_000 } }));
  assert.equal(avecFrais.signal, null, 'six points de marge ne survivent pas a 9 % de frais');
  assert.match(avecFrais.reason, /marge/);
});

test('un carnet fin reduit la taille, voire annule l\'operation', () => {
  const strat = new LatencyArbStrategy(cfg());
  const thin = new Book('YES');
  thin.applySnapshot({ bids: [{ price: 0.49, size: 2 }], asks: [{ price: 0.51, size: 2 }], ts: NOW - 5_000 });
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  const { signal, reason } = strat.evaluateEntry({
    market,
    yesBook: thin,
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.equal(signal, null);
  assert.match(reason, /taille executable|liquidite/);
});

test('la periode de refroidissement empeche de rentrer deux fois de suite', () => {
  const strat = new LatencyArbStrategy(cfg());
  strat.state(market.id).midHistory.push(NOW - 4_000, 0.5);
  strat.markEntry(market.id, NOW - 1_000);
  const { signal, reason } = strat.evaluateEntry({
    market,
    yesBook: bookAt(0.5),
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.equal(signal, null);
  assert.equal(reason, 'periode de refroidissement');
});

test('la sortie se declenche quand le marche s\'est realigne', () => {
  const strat = new LatencyArbStrategy(cfg());
  const position = { outcome: 'YES', openedTs: NOW - 10_000, entryTopChanges: 0, shares: 100 };
  // Juste prix 0,810 ; le carnet propose desormais 0,81 a l'achat : plus rien a prendre.
  const decision = strat.evaluateExit({
    position,
    market,
    yesBook: bookAt(0.82),
    spot: fakeSpot({ price: 100_400, before: 100_000 }),
    now: NOW,
  });
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, 'realignement du marche');
});

test('le coupe-circuit sort quand le spot repart en sens inverse', () => {
  const strat = new LatencyArbStrategy(cfg());
  const position = { outcome: 'YES', openedTs: NOW - 10_000, entryTopChanges: 0, shares: 100 };
  const decision = strat.evaluateExit({
    position,
    market,
    yesBook: bookAt(0.6),
    spot: fakeSpot({ price: 99_000, before: 100_000 }),
    now: NOW,
  });
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, 'coupe-circuit');
});

test('une position devenue pari directionnel est fermee quand le carnet a repris la main', () => {
  const strat = new LatencyArbStrategy(cfg());
  const book = bookAt(0.55);
  // Le sommet a rebouge quatre fois depuis notre entree.
  for (let i = 1; i <= 4; i += 1) {
    book.applyChanges([{ price: 0.54 + i * 0.001, side: 'BUY', size: 500 }], NOW - 1_000 + i);
  }
  const position = { outcome: 'YES', openedTs: NOW - 20_000, entryTopChanges: 0, shares: 100 };
  // Juste prix 0,5604 contre 0,544 a l'achat : 1,6 point residuel, sous le seuil
  // d'entree. Ce qui reste n'est plus du retard, c'est un desaccord de modele.
  const decision = strat.evaluateExit({
    position,
    market,
    yesBook: book,
    spot: fakeSpot({ price: 100_070, before: 100_000 }),
    now: NOW,
  });
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, 'retard consomme');
});

test('une position dont la marge reste entiere n\'est pas fermee', () => {
  const strat = new LatencyArbStrategy(cfg());
  const position = { outcome: 'YES', openedTs: NOW - 5_000, entryTopChanges: 0, shares: 100 };
  const decision = strat.evaluateExit({
    position,
    market,
    yesBook: bookAt(0.5),
    spot: fakeSpot({ price: 100_600, before: 100_000 }),
    now: NOW,
  });
  assert.equal(decision.exit, false);
});

test('sur une fourchette, le signal suit la probabilite et non la direction du BTC', () => {
  const fourchette = {
    ...market,
    id: 'range',
    kind: 'range',
    side: 'inside',
    strike: 62_000,
    strikeHigh: 64_000,
    question: 'Will Bitcoin be between $62,000 and $64,000?',
  };
  const strat = new LatencyArbStrategy(cfg());
  strat.state(fourchette.id).midHistory.push(NOW - 4_000, 0.5);

  // Le BTC monte de 61 000 vers 62 900 : il ENTRE dans la fourchette, donc la
  // probabilite grimpe. Une hausse du BTC ne signifie pas mecaniquement YES —
  // c'est le sens de la probabilite qui decide.
  const entrant = strat.evaluateEntry({
    market: fourchette,
    yesBook: bookAt(0.5),
    spot: fakeSpot({ price: 62_900, before: 61_000 }),
    now: NOW,
  });
  assert.ok(entrant.signal, `signal attendu (motif : ${entrant.reason})`);
  assert.equal(entrant.signal.outcome, 'YES');

  // Le BTC monte de 63 500 vers 65 500 : il SORT par le haut, la probabilite
  // s'effondre. Meme direction du BTC, decision inverse.
  const strat2 = new LatencyArbStrategy(cfg());
  strat2.state(fourchette.id).midHistory.push(NOW - 4_000, 0.5);
  const sortant = strat2.evaluateEntry({
    market: fourchette,
    yesBook: bookAt(0.5),
    spot: fakeSpot({ price: 65_500, before: 63_500 }),
    now: NOW,
  });
  assert.ok(sortant.signal, `signal attendu (motif : ${sortant.reason})`);
  assert.equal(sortant.signal.outcome, 'NO');
});
