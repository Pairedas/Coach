import http from 'node:http';
import { logger } from './util/log.js';

const log = logger('tableau');

/**
 * Tableau de bord local. Volontairement lie a 127.0.0.1 : cette page expose
 * positions et resultats, elle n'a rien a faire sur une interface publique.
 */
export function startDashboard(cfg, engine) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/state') {
      const body = JSON.stringify(engine.snapshot());
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('introuvable');
  });

  server.listen(cfg.dashboard.port, '127.0.0.1', () => {
    log.info(`tableau de bord : http://127.0.0.1:${cfg.dashboard.port}`);
  });
  server.on('error', (err) => log.error(`tableau de bord indisponible : ${err.message}`));
  return server;
}

const PAGE = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arbitrage de latence — supervision</title>
<style>
:root{--ink:#05080f;--ink2:#0c1220;--ink3:#111d2e;--line:#1d2f45;--lime:#b8ff57;--cyan:#38f0d0;--red:#ff5f5f;--amber:#ffb830;--txt:#dce8f5;--txt2:#7a93ae}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--ink);color:var(--txt);font-family:system-ui,-apple-system,sans-serif;padding:20px;line-height:1.5}
h1{font-size:18px;font-weight:700;margin-bottom:4px}
.sub{color:var(--txt2);font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:14px}
.k{color:var(--txt2);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.v{font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
.pos{color:var(--lime)}.neg{color:var(--red)}.warn{color:var(--amber)}
section{background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px;overflow-x:auto}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--cyan);margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;min-width:560px}
th{text-align:left;color:var(--txt2);font-weight:600;font-size:11px;text-transform:uppercase;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 10px 7px 0;border-bottom:1px solid var(--ink3)}
.muted{color:var(--txt2)}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--ink3);font-size:11px}
.empty{color:var(--txt2);font-size:13px;padding:6px 0}
</style></head><body>
<h1>Arbitrage de latence — supervision</h1>
<div class="sub" id="mode">connexion…</div>
<div class="grid" id="tiles"></div>
<section><h2>Positions ouvertes</h2><div id="positions"></div></section>
<section><h2>Marches suivis</h2><div id="markets"></div></section>
<section><h2>Dernieres operations</h2><div id="closed"></div></section>
<section><h2>Motifs de rejet des signaux</h2><div id="rejections"></div></section>
<script>
const fmt=(x,d=2)=>x===null||x===undefined||Number.isNaN(x)?'—':Number(x).toFixed(d);
const cls=x=>x>0?'pos':x<0?'neg':'';
function table(rows,cols){
  if(!rows.length) return '<div class="empty">aucune donnee</div>';
  return '<table><thead><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
async function refresh(){
  let s; try{ s=await (await fetch('/api/state')).json(); }catch{ document.getElementById('mode').textContent='moteur injoignable'; return; }
  const st=s.stats, risk=s.risk;
  document.getElementById('mode').textContent =
    'mode '+s.mode+' · spot '+fmt(s.spot.price,1)+' USD · volatilite '+fmt(s.spot.volAnnual*100,0)+'% · '+new Date(s.ts).toLocaleTimeString('fr-FR');
  document.getElementById('tiles').innerHTML=[
    ['Resultat realise','<span class="'+cls(st.realizedPnl)+'">'+fmt(st.realizedPnl)+' USDC</span>'],
    ['Operations',st.trades+' <span class="muted">('+fmt(st.winRate*100,0)+'% gagnantes)</span>'],
    ['Positions',st.openPositions+' <span class="muted">/ expo '+fmt(st.exposure,0)+'</span>'],
    ['Duree moyenne',fmt(st.avgHoldSec,0)+' s'],
    ['Signaux',s.counters.signals+' <span class="muted">· '+s.counters.rejected+' non executes</span>'],
    ['Coupe-circuit',risk.halted?'<span class="neg">'+risk.haltReason+'</span>':'<span class="pos">inactif</span>'],
  ].map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');

  document.getElementById('positions').innerHTML=table(s.positions,[
    ['Marche',p=>'<span class="muted">'+p.question.slice(0,52)+'</span>'],
    ['Cote',p=>'<span class="badge">'+p.outcome+'</span>'],
    ['Parts',p=>fmt(p.shares,1)],['Entree',p=>fmt(p.entryPrice,3)],
    ['Marge entree',p=>fmt(p.entrySignal.netEdge*100,1)+' pts'],
    ['Age',p=>fmt((s.ts-p.openedTs)/1000,0)+' s'],
  ]);
  document.getElementById('markets').innerHTML=table(s.markets,[
    ['Marche',m=>'<span class="muted">'+m.question.slice(0,52)+'</span>'],
    ['Seuil',m=>fmt(m.strike,0)],['Achat',m=>fmt(m.bestBid,3)],['Vente',m=>fmt(m.bestAsk,3)],
    ['Carnet fige',m=>m.bookAgeMs===null?'—':fmt(m.bookAgeMs/1000,1)+' s'],
    ['Echeance',m=>fmt((m.expiryTs-s.ts)/60000,0)+' min'],
  ]);
  document.getElementById('closed').innerHTML=table([...s.closed].reverse(),[
    ['Heure',c=>new Date(c.closedTs).toLocaleTimeString('fr-FR')],
    ['Cote',c=>'<span class="badge">'+c.outcome+'</span>'],
    ['Entree',c=>fmt(c.entryPrice,3)],['Sortie',c=>fmt(c.exitPrice,3)],
    ['Resultat',c=>'<span class="'+cls(c.pnl)+'">'+fmt(c.pnl)+'</span>'],
    ['Duree',c=>fmt(c.holdMs/1000,0)+' s'],['Motif',c=>'<span class="muted">'+c.reason+'</span>'],
  ]);
  const rej=Object.entries(s.rejections);
  document.getElementById('rejections').innerHTML=rej.length
    ? table(rej,[['Motif',r=>'<span class="muted">'+r[0]+'</span>'],['Occurrences',r=>r[1]]])
    : '<div class="empty">aucun rejet enregistre</div>';
}
refresh(); setInterval(refresh,2000);
</script></body></html>`;
