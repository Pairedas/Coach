#!/usr/bin/env node
import { runLive, runScan } from './runners/live.js';
import { runReplay } from './runners/replay.js';
import { runProbe } from './runners/probe.js';
import { runOneSim, runSimBatch } from './runners/sim.js';

const USAGE = `
Arbitrage de latence BTC — Binance/Coinbase vs Polymarket

  node src/index.js <commande> [options]

Commandes
  scan                  Liste les marches Polymarket exploitables, sans rien engager
  probe [--seconds=n]   Observe les carnets sans engager d'ordre et mesure le
                        temps pendant lequel ils restent figes (defaut 120 s)
  paper                 Session temps reel en execution simulee (par defaut)
  record                Comme paper, en journalisant les flux pour rejeu
  replay <fichier>      Rejoue une seance enregistree avec la configuration courante
  sim                   Simulation hors ligne sur marche synthetique

Options de sim
  --lag=<ms>            Retard injecte dans le carnet (defaut 2000)
  --minutes=<n>         Duree d'une session (defaut 60)
  --runs=<n>            Nombre de graines (defaut 1 ; >1 agrege les statistiques)
  --compare             Compare le retard demande avec un marche sans retard

Le mode reel n'est jamais actif par defaut. Il exige LIVE_TRADING=1 et
LIVE_CONFIRM="JE COMPRENDS LES RISQUES" — voir README.md avant d'y toucher.
`;

function flag(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = Number(hit.split('=')[1]);
  return Number.isFinite(v) ? v : dflt;
}

function line(label, value) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

function report(title, b) {
  console.log(`\n${title}`);
  line('sessions', `${b.runs} x ${b.minutes} min`);
  line('operations', `${b.totalTrades} (${b.tradesPerRun.toFixed(1)} par session)`);
  line('taux de reussite', `${(b.winRate * 100).toFixed(1)} %`);
  line('resultat moyen', `${b.pnlMean >= 0 ? '+' : ''}${b.pnlMean.toFixed(2)} USDC`);
  line('resultat median', `${b.pnlMedian >= 0 ? '+' : ''}${b.pnlMedian.toFixed(2)} USDC`);
  line('pire / meilleur', `${b.pnlWorst.toFixed(2)} / ${b.pnlBest.toFixed(2)} USDC`);
  line('sessions gagnantes', `${b.profitableRuns}/${b.runs}`);
  line('duree moyenne', `${b.avgHoldSec.toFixed(0)} s`);
}

const command = process.argv[2] ?? 'paper';

try {
  switch (command) {
    case 'scan':
      await runScan();
      break;
    case 'probe':
      await runProbe({ seconds: flag('seconds', 120) });
      process.exit(0);
      break;
    case 'paper':
      await runLive({ record: false });
      break;
    case 'record':
      await runLive({ record: true });
      break;
    case 'replay': {
      const file = process.argv[3];
      if (!file) throw new Error('chemin du fichier manquant : node src/index.js replay <fichier>');
      await runReplay(file);
      break;
    }
    case 'sim': {
      const lagMs = flag('lag', 2_000);
      const minutes = flag('minutes', 60);
      const runs = flag('runs', 1);
      const compare = process.argv.includes('--compare');

      if (runs <= 1 && !compare) {
        const r = runOneSim({ seed: flag('seed', 1), lagMs, minutes });
        console.log(`\nSession simulee — retard ${lagMs} ms, ${minutes} min`);
        line('operations', `${r.trades} (${(r.winRate * 100).toFixed(1)} % gagnantes)`);
        line('resultat', `${r.realizedPnl >= 0 ? '+' : ''}${r.realizedPnl.toFixed(2)} USDC`);
        line('duree moyenne', `${r.avgHoldSec.toFixed(0)} s`);
        console.log('');
        break;
      }

      report(`Marche avec retard de ${lagMs} ms`, runSimBatch({ runs: Math.max(runs, 2), lagMs, minutes }));
      if (compare) {
        // Test de controle : sans retard a exploiter, une strategie d'arbitrage
        // de latence doit s'approcher de zero. Si elle gagne quand meme, elle
        // ne fait pas de l'arbitrage — elle parie sur la direction.
        report('Marche de controle, sans retard (0 ms)', runSimBatch({ runs: Math.max(runs, 2), lagMs: 0, minutes }));
      }
      console.log('');
      break;
    }
    default:
      console.log(USAGE);
      process.exit(command === '--help' || command === 'help' ? 0 : 1);
  }
} catch (err) {
  console.error(`\nErreur : ${err.message}\n`);
  process.exit(1);
}
