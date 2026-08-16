import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarketSimulator } from '../src/replay/simulator.js';
import { Recorder, readSession } from '../src/replay/recorder.js';
import { runReplay } from '../src/runners/replay.js';

/**
 * Valide la chaine enregistrement -> rejeu au format exact d'une session reelle.
 * Sans ce test, rien ne garantit qu'un fichier enregistre en production soit
 * rejouable — et le rejeu est le seul moyen honnete de regler les seuils.
 */
test('une session enregistree se rejoue et reproduit des operations', { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-arb-'));
  const file = path.join(dir, 'session.ndjson');

  try {
    const sim = new MarketSimulator({ seed: 21, lagMs: 4_000, horizonMs: 3_600_000 });
    const rec = new Recorder(file);
    rec.write({ type: 'markets', ts: sim.ts, markets: [sim.market] });
    for (let i = 0; i < 18_000; i += 1) {
      const { quotes, ts } = sim.step();
      for (const q of quotes) rec.write({ type: 'quote', ...q });
      if (i % 5 === 0) {
        for (const token of [sim.market.tokenYes, sim.market.tokenNo]) {
          const b = sim.books.book(token);
          rec.write({ type: 'book', ts, assetId: token, bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5) });
        }
      }
    }
    await rec.close();

    const { stats } = await runReplay(file);
    assert.ok(stats.trades > 0, 'le rejeu doit reproduire des operations');
    assert.ok(stats.avgHoldSec > 0 && stats.avgHoldSec < 300);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('une ligne tronquee ne casse pas la lecture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-arb-'));
  const file = path.join(dir, 'abime.ndjson');
  try {
    fs.writeFileSync(file, '{"type":"quote","ts":1}\n{"type":"quo\n\n{"type":"quote","ts":2}\n');
    const lus = [];
    for await (const ev of readSession(file)) lus.push(ev);
    assert.equal(lus.length, 2, 'les lignes valides doivent survivre a une session interrompue');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
