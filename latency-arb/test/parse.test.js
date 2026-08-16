import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseStrike, parseMarket } from '../src/polymarket/parse.js';

const baseRaw = {
  conditionId: '0xabc',
  slug: 'btc-test',
  clobTokenIds: '["111","222"]',
  outcomes: '["Yes","No"]',
  endDate: '2026-08-15T20:00:00Z',
};

test('parseMoney gere les formats courants', () => {
  assert.equal(parseMoney('$118,500'), 118_500);
  assert.equal(parseMoney('118.5k'), 118_500);
  assert.equal(parseMoney('$120K'), 120_000);
  assert.ok(Number.isNaN(parseMoney('')));
});

test('parseStrike ignore les montants implausibles', () => {
  assert.equal(parseStrike('Will Bitcoin be above $118,000 on August 15?'), 118_000);
  assert.ok(Number.isNaN(parseStrike('Will Bitcoin gain $5 today?')));
});

test('un marche « above » est accepte avec son seuil', () => {
  const r = parseMarket({ ...baseRaw, question: 'Will Bitcoin be above $118,000 on August 15?' });
  assert.ok(r.ok);
  assert.equal(r.market.side, 'above');
  assert.equal(r.market.strike, 118_000);
  assert.equal(r.market.tokenYes, '111');
  assert.equal(r.market.tokenNo, '222');
});

test('un marche « below » inverse le sens', () => {
  const r = parseMarket({ ...baseRaw, question: 'Will Bitcoin close below $110,000 today?' });
  assert.ok(r.ok);
  assert.equal(r.market.side, 'below');
});

test('un marche up/down est accepte sans seuil, a completer plus tard', () => {
  const r = parseMarket({ ...baseRaw, question: 'Bitcoin Up or Down - August 15, 3PM ET' });
  assert.ok(r.ok);
  assert.equal(r.market.kind, 'updown');
  assert.equal(r.market.strike, null);
  assert.equal(r.market.periodMs, 3_600_000);
});

test('un marche a barriere est rejete : le modele ne sait pas le valoriser', () => {
  const r = parseMarket({ ...baseRaw, question: 'Will Bitcoin dip to $100,000 in August?' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /barriere/);
});

test('les marches inexploitables sont rejetes avec un motif', () => {
  assert.equal(parseMarket({ ...baseRaw, question: 'Who will win the election?' }).ok, false);
  assert.equal(parseMarket({ ...baseRaw, question: 'Bitcoin above $118,000?', clobTokenIds: '[]' }).ok, false);
  assert.equal(parseMarket({ ...baseRaw, question: 'Bitcoin above $118,000?', endDate: 'jamais' }).ok, false);
});

test('l\'ordre des resultats est respecte quand « Yes » n\'est pas en premier', () => {
  const r = parseMarket({
    ...baseRaw,
    question: 'Will Bitcoin be above $118,000 on August 15?',
    outcomes: '["No","Yes"]',
  });
  assert.ok(r.ok);
  assert.equal(r.market.tokenYes, '222');
  assert.equal(r.market.tokenNo, '111');
});
