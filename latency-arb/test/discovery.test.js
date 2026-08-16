import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverMarkets } from '../src/polymarket/discovery.js';
import { withOverrides } from '../src/config.js';

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

function marche(i, over = {}) {
  return {
    conditionId: `0x${i}`,
    slug: `bitcoin-market-${i}`,
    question: `Will the price of Bitcoin be above $${100 + i},000 on August 16?`,
    clobTokenIds: `["y${i}","n${i}"]`,
    outcomes: '["Yes","No"]',
    endDate: new Date(NOW + 3_600_000).toISOString(),
    volume24hr: 1_000 - i,
    ...over,
  };
}

const cfg = () => withOverrides({ polymarket: { pageSize: 100, maxPages: 10, maxMarkets: 50 } });

test('la decouverte pagine jusqu\'a epuisement des resultats', async () => {
  const appels = [];
  const getJson = async (url) => {
    appels.push(url);
    const params = new URL(url).searchParams;
    if (params.get('order') !== 'volume24hr') return []; // second balayage vide
    const offset = Number(params.get('offset'));
    // Deux pages pleines puis une page partielle : la boucle doit s'arreter la.
    if (offset === 0) return Array.from({ length: 100 }, (_, i) => marche(i));
    if (offset === 100) return Array.from({ length: 100 }, (_, i) => marche(100 + i));
    return [marche(200)];
  };

  const markets = await discoverMarkets(cfg(), { getJson, now: NOW });
  const parVolume = appels.filter((u) => u.includes('order=volume24hr'));
  assert.equal(parVolume.length, 3, 'trois pages puis arret sur page incomplete');
  assert.ok(parVolume[1].includes('offset=100'));
  assert.equal(markets.length, 50, 'plafonne par maxMarkets');
});

test('un second balayage par echeance rattrape les marches courts', async () => {
  // Le tri par volume ne renvoie que des gros marches ; le marche horaire
  // n'apparait que dans le balayage par echeance croissante.
  const getJson = async (url) => {
    const params = new URL(url).searchParams;
    if (Number(params.get('offset')) !== 0) return [];
    if (params.get('order') === 'volume24hr') {
      return [marche(1, { question: 'Will Ethereum be above $3,000?', slug: 'eth-1' })];
    }
    assert.equal(params.get('ascending'), 'true', 'echeances les plus proches d\'abord');
    return [marche(42)];
  };

  const markets = await discoverMarkets(cfg(), { getJson, now: NOW });
  assert.equal(markets.length, 1);
  assert.equal(markets[0].id, '0x42');
});

test('un marche present dans les deux balayages n\'est compte qu\'une fois', async () => {
  const getJson = async (url) => (Number(new URL(url).searchParams.get('offset')) === 0 ? [marche(7)] : []);
  const markets = await discoverMarkets(cfg(), { getJson, now: NOW });
  assert.equal(markets.length, 1, 'la deduplication doit ecarter le doublon');
});

test('sans pagination, les marches au-dela de la premiere page seraient perdus', async () => {
  const getJson = async (url) => {
    const params = new URL(url).searchParams;
    if (params.get('order') !== 'volume24hr') return [];
    const offset = Number(params.get('offset'));
    // Cent marches sans rapport occupent toute la premiere page.
    if (offset === 0) {
      return Array.from({ length: 100 }, (_, i) => marche(i, {
        question: 'Will Ethereum be above $3,000 on August 16?',
        slug: `ethereum-market-${i}`,
      }));
    }
    if (offset === 100) return [marche(777)];
    return [];
  };
  const markets = await discoverMarkets(cfg(), { getJson, now: NOW });
  assert.equal(markets.length, 1, 'le marche BTC de la deuxieme page doit etre trouve');
  assert.equal(markets[0].id, '0x777');
});

test('les marches hors fenetre d\'echeance sont ecartes', async () => {
  const getJson = async (url) => {
    const params = new URL(url).searchParams;
    if (params.get('order') !== 'volume24hr' || Number(params.get('offset')) !== 0) return [];
    return [
      marche(1, { endDate: new Date(NOW + 30_000).toISOString() }),        // trop proche
      marche(2, { endDate: new Date(NOW + 30 * 3600_000).toISOString() }), // trop lointaine
      marche(3),                                                            // dans la fenetre
    ];
  };
  const markets = await discoverMarkets(cfg(), { getJson, now: NOW });
  assert.equal(markets.length, 1);
  assert.equal(markets[0].id, '0x3');
});

test('le seuil d\'un marche up/down est reconstruit depuis l\'ouverture horaire', async () => {
  const getJson = async (url) => {
    const params = new URL(url).searchParams;
    if (params.get('order') !== 'volume24hr' || Number(params.get('offset')) !== 0) return [];
    return [marche(1, { question: 'Bitcoin Up or Down - August 16, 1PM ET' })];
  };
  let demande = null;
  const fetchHourOpen = async (ts) => { demande = ts; return 118_400; };

  const markets = await discoverMarkets(cfg(), { getJson, fetchHourOpen, now: NOW });
  assert.equal(markets.length, 1);
  assert.equal(markets[0].strike, 118_400);
  assert.equal(markets[0].strikeSource, 'binance-kline-open');
  assert.equal(demande, markets[0].expiryTs - 3_600_000, 'l\'ouverture demandee est celle du debut de periode');
});

test('un seuil introuvable ecarte le marche au lieu d\'inventer un prix', async () => {
  const getJson = async (url) => {
    const params = new URL(url).searchParams;
    if (params.get('order') !== 'volume24hr' || Number(params.get('offset')) !== 0) return [];
    return [marche(1, { question: 'Bitcoin Up or Down - August 16, 1PM ET' })];
  };
  const fetchHourOpen = async () => { throw new Error('bougie indisponible'); };
  const markets = await discoverMarkets(cfg(), { getJson, fetchHourOpen, now: NOW });
  assert.equal(markets.length, 0);
});

test('une reponse Gamma inattendue leve une erreur explicite', async () => {
  await assert.rejects(
    () => discoverMarkets(cfg(), { getJson: async () => ({ erreur: 'nope' }), now: NOW }),
    /Gamma inattendue/,
  );
});
