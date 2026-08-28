/**
 * ═══════════════════════════════════════════════════════════
 *  AGENCE PRO — BACKEND + TABLEAU DE BORD ADMIN (version 4)
 * ═══════════════════════════════════════════════════════════
 *
 *  ✨ NOUVEAU : ouvre simplement ton URL /exec dans le navigateur
 *  → le TABLEAU DE BORD ADMIN s'affiche directement (aucun blocage
 *  possible : tout se passe chez Google).
 *
 *  INSTALLATION / MISE À JOUR :
 *  1. Google Sheet → Extensions → Apps Script
 *  2. Efface tout, colle TOUT ce fichier
 *  3. ⚠️ Remets ton CODE_SECRET ci-dessous
 *  4. 💾 Enregistrer, puis Déployer → Gérer les déploiements → ✏️
 *     → Version : « Nouvelle version » → Déployer (l'URL ne change pas)
 *
 *  L'app de l'agent envoie ses données ici (avec le code secret) ;
 *  la page admin GitHub reste utilisable, mais le plus simple est
 *  d'ouvrir l'URL /exec directement.
 */

const CODE_SECRET = 'CHANGE-MOI-ABSOLUMENT';

/* ────────────────────────────────────────────────────────── */

const DAY_HEADERS = ['date','maj','agence','agent','ouverture','entrees','sorties',
  'theorique','reel','manquant_jour','ancien_manquant','manquant_total',
  'pointages','cloturee','json'];

function doGet(e){
  const p = e.parameter || {};
  /* sans paramètres → tableau de bord intégré */
  if(!p.action && !p.secret){
    return HtmlService.createHtmlOutput(ADMIN_HTML)
      .setTitle('Agence Pro — Admin')
      .addMetaTag('viewport','width=device-width, initial-scale=1');
  }
  const cb = (p.callback && /^[\w$.]+$/.test(p.callback)) ? p.callback : null;
  /* envoi par navigation (onglet ouvert par l'app) : réponse lisible par l'humain */
  if(p.action === 'push' && !cb){
    if(p.secret !== CODE_SECRET) return htmlResult(false, 'Code secret invalide — vérifie que le code dans l\'app (Réglages → Synchronisation) est exactement celui écrit dans ce script.');
    try{
      applyPush(JSON.parse(p.data || '{}'));
      return htmlResult(true, '');
    }catch(err){ return htmlResult(false, String(err)); }
  }
  if(p.secret !== CODE_SECRET) return out({ok:false, error:'code secret invalide'}, cb);
  if(p.action === 'ping') return out({ok:true, version:4}, cb);
  if(p.action === 'push'){
    try{
      applyPush(JSON.parse(p.data || '{}'));
      return out({ok:true}, cb);
    }catch(err){ return out({ok:false, error:String(err)}, cb); }
  }
  return out({ok:true, days:getDays(90), events:getEvents(150)}, cb);
}

function applyPush(data){
  if(data.action === 'day'){ upsertDay(data.day); return; }
  if(data.action === 'event'){ addEvent(data.event); return; }
  if(data.action === 'batch'){
    (data.items || []).forEach(function(it){
      if(it.action === 'day') upsertDay(it.day);
      else if(it.action === 'event') addEvent(it.event);
    });
    return;
  }
  throw new Error('action inconnue');
}

/* petite page de confirmation affichée quand l'envoi passe par un onglet */
function htmlResult(ok, msg){
  const html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">'+
    '<meta name="viewport" content="width=device-width, initial-scale=1"><style>'+
    'body{background:#070b12;color:#e2ecf7;font-family:-apple-system,Roboto,Arial,sans-serif;'+
    'display:flex;align-items:center;justify-content:center;min-height:92vh;text-align:center;padding:20px}'+
    '.c{max-width:340px}.ic{font-size:60px}.t{font-size:20px;font-weight:800;margin-top:12px}'+
    '.s{font-size:13.5px;color:#8aa2bd;margin-top:10px;line-height:1.6}'+
    '</style></head><body><div class="c">'+
    (ok ? '<div class="ic">✅</div><div class="t">Données envoyées à l\'admin !</div>'+
          '<div class="s">La synchronisation a réussi.<br><b>Tu peux fermer cet onglet</b> et retourner dans l\'app.</div>'
        : '<div class="ic">⛔</div><div class="t">Envoi refusé</div><div class="s">'+msg+'</div>')+
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(ok ? 'Envoyé ✅' : 'Refusé ⛔');
}

function doPost(e){
  try{
    let data;
    try{ data = JSON.parse(e.postData.contents); }
    catch(err){ data = JSON.parse((e.parameter && e.parameter.data) || '{}'); }
    if(data.secret !== CODE_SECRET) return out({ok:false, error:'code secret invalide'}, null);
    applyPush(data);
    return out({ok:true}, null);
  }catch(err){
    return out({ok:false, error:String(err)}, null);
  }
}

/* appelé par le tableau de bord intégré (google.script.run) */
function api(payload){
  try{
    const p = JSON.parse(payload || '{}');
    if(p.secret !== CODE_SECRET) return JSON.stringify({ok:false, error:'code secret invalide'});
    return JSON.stringify({ok:true, version:4, days:getDays(90), events:getEvents(150)});
  }catch(err){
    return JSON.stringify({ok:false, error:String(err)});
  }
}

function out(o, cb){
  const s = JSON.stringify(o);
  if(cb) return ContentService.createTextOutput(cb+'('+s+')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

/* ── feuilles ── */
function sheet(name, headers){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold');
  }
  return sh;
}

/* dates : « 2026-08-26 » même si Sheets les a converties */
function norm(v){
  if(v instanceof Date){
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}
/* heures : « 20:05 » même si Sheets les a converties en valeur horaire */
function normTime(v){
  if(v instanceof Date){
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(v);
}

function upsertDay(d){
  const sh = sheet('Jours', DAY_HEADERS);
  const row = [d.date, d.maj, d.agence, d.agent, d.ouverture, d.entrees, d.sorties,
    d.theorique, d.reel, d.manquantJour, d.ancien, d.manquantTotal,
    d.nbPointages, d.cloturee ? 'oui' : 'non', JSON.stringify(d.detail || {})];
  const last = sh.getLastRow();
  if(last > 1){
    const dates = sh.getRange(2,1,last-1,1).getValues();
    for(let i=0;i<dates.length;i++){
      if(norm(dates[i][0]) === d.date){
        sh.getRange(i+2,1,1,row.length).setValues([row]);
        return;
      }
    }
  }
  sh.appendRow(row);
}

function addEvent(ev){
  const sh = sheet('Evenements', ['horodatage','date','type','texte']);
  sh.appendRow([ev.ts, ev.date, ev.type, ev.texte]);
  const max = 2000, n = sh.getLastRow();
  if(n > max+1) sh.deleteRows(2, n-max-1);
}

function getDays(limit){
  const sh = sheet('Jours', DAY_HEADERS);
  const last = sh.getLastRow();
  if(last < 2) return [];
  const rows = sh.getRange(2,1,last-1,DAY_HEADERS.length).getValues();
  const days = rows.map(function(r){
    const o = {};
    DAY_HEADERS.forEach(function(h,i){
      o[h] = h==='date' ? norm(r[i]) : (h==='maj' ? normTime(r[i]) : r[i]);
    });
    try{ o.detail = JSON.parse(o.json || '{}'); }catch(e){ o.detail = {}; }
    delete o.json;
    return o;
  });
  days.sort(function(a,b){ return a.date < b.date ? 1 : -1; });
  return days.slice(0, limit);
}

function getEvents(limit){
  const sh = sheet('Evenements', ['horodatage','date','type','texte']);
  const last = sh.getLastRow();
  if(last < 2) return [];
  const from = Math.max(2, last - limit + 1);
  const rows = sh.getRange(from,1,last-from+1,4).getValues();
  return rows.map(function(r){
    return {ts:normTime(r[0]), date:norm(r[1]), type:String(r[2]), texte:String(r[3])};
  }).reverse();
}

/* ══════════════════════════════════════════════════════════
   TABLEAU DE BORD INTÉGRÉ (servi à l'ouverture de l'URL /exec)
   ══════════════════════════════════════════════════════════ */
/*ADMIN_HTML_START*/
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
:root{--ink:#070b12;--ink2:#0d1420;--ink3:#131e2f;--ink4:#1a2942;--line:#1c2c42;--line2:#28405e;
--green:#4ade80;--red:#ff5f5f;--amber:#ffb830;--blue:#4d9eff;--txt:#e2ecf7;--txt2:#8aa2bd;--txt3:#4a6284}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--ink);color:var(--txt);font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;min-height:100vh}
#app{max-width:680px;margin:0 auto;padding:16px 14px 40px}
.hdr{display:flex;align-items:center;gap:10px;padding:4px 0 14px}
.hic{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#7db9ff);display:flex;align-items:center;justify-content:center;font-size:20px}
.hdr h1{font-size:17px;font-weight:800}
.hdr h1 em{color:var(--blue);font-style:normal}
.hdr .sub{font-size:10.5px;color:var(--txt3)}
.hdr .sp{margin-left:auto;display:flex;gap:8px}
.icb{width:36px;height:36px;border-radius:10px;background:var(--ink3);border:1px solid var(--line);color:var(--txt2);font-size:14px;cursor:pointer}
.card{background:var(--ink2);border:1px solid var(--line);border-radius:15px;padding:16px;margin-bottom:12px}
.card h2{font-size:13.5px;font-weight:800;margin-bottom:10px}
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:12px}
.kpi{background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:12px 13px}
.kl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--txt3);font-weight:600}
.kv{font-size:19px;font-weight:800;margin-top:4px}
.ks{font-size:10px;color:var(--txt3);margin-top:2px}
.hero{grid-column:1/-1;text-align:center;padding:18px 14px;border-radius:15px}
.hero .kv{font-size:34px}
.hero.bad{background:linear-gradient(165deg,rgba(255,95,95,.13),var(--ink2));border-color:rgba(255,95,95,.4)}
.hero.bad .kv{color:var(--red)}
.hero.ok{background:linear-gradient(165deg,rgba(74,222,128,.1),var(--ink2));border-color:rgba(74,222,128,.35)}
.hero.ok .kv{color:var(--green)}
.pos{color:var(--green)}.neg{color:var(--red)}.mut{color:var(--txt2)}
input{width:100%;background:var(--ink3);border:1.5px solid var(--line2);border-radius:11px;color:var(--txt);font-size:15px;padding:12px;outline:none;margin-top:8px}
input:focus{border-color:var(--blue)}
.btn{display:block;width:100%;padding:13px;border:none;border-radius:12px;font-size:14px;font-weight:800;cursor:pointer;margin-top:12px;background:linear-gradient(135deg,#3b82f6,#7db9ff);color:#041020}
.cr{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--line);font-size:12.5px}
.cr:last-child{border-bottom:none}
.cr b{font-weight:800}
.dy{background:var(--ink2);border:1px solid var(--line);border-radius:13px;margin-bottom:9px;overflow:hidden}
.dy-h{display:flex;align-items:center;gap:10px;padding:12px 13px;cursor:pointer}
.dy-h .d{font-weight:700;font-size:13px;text-transform:capitalize}
.dy-h .s{font-size:9.5px;color:var(--txt3)}
.dy-h .m{margin-left:auto;font-weight:800;font-size:13.5px}
.dy-b{padding:2px 13px 12px;border-top:1px solid var(--line)}
.ev{display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--line);font-size:11.5px;line-height:1.5}
.ev:last-child{border-bottom:none}
.ev .i{flex-shrink:0}
.ev .t{color:var(--txt3);font-size:9px;margin-top:2px}
.ev.al{color:#ffb3b3}
.err{background:rgba(255,95,95,.08);border:1px solid rgba(255,95,95,.3);border-radius:10px;padding:10px 12px;font-size:12px;color:#ffb3b3;margin-top:10px;line-height:1.5}
.legend{display:flex;gap:14px;margin-top:6px;font-size:10.5px;color:var(--txt2)}
.ld{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.empty{text-align:center;color:var(--txt3);font-size:12px;padding:18px 0;line-height:1.6}
.foot{text-align:center;font-size:9.5px;color:var(--txt3);padding:14px 0}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line2);border-top-color:var(--blue);border-radius:50%;animation:r .8s linear infinite;vertical-align:-2px}
@keyframes r{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="app"><div class="card" style="margin-top:20vh;text-align:center"><span class="spin"></span> Chargement…</div></div>
<script>
var SECRET_KEY = 'agAdminSecret';
var DATA = null, hOpen = null, loading = false, lastT = null;
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(n){
  if(n===''||n==null||isNaN(+n)) return '—';
  var v = Math.round(+n), s = String(Math.abs(v)), o = '';
  while(s.length > 3){ o = ' ' + s.slice(-3) + o; s = s.slice(0,-3); }
  return (v<0?'-':'') + s + o + ' F';
}
function fmtK(n){ n = Math.round(+n||0);
  if(Math.abs(n)>=1000000) return (Math.round(n/100000)/10)+'M';
  if(Math.abs(n)>=10000) return Math.round(n/1000)+'k';
  return String(n); }
function frDate(k){
  var p = String(k).split('-');
  var d = new Date(+p[0], p[1]-1, +p[2]);
  var jours = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
  var mois = ['janv','févr','mars','avril','mai','juin','juil','août','sept','oct','nov','déc'];
  return jours[d.getDay()]+' '+(+p[2])+' '+mois[d.getMonth()];
}
function todayKey(){
  var d = new Date();
  return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
}
function getSecret(){ try{ return localStorage.getItem(SECRET_KEY)||''; }catch(e){ return ''; } }
function setSecret(v){ try{ v? localStorage.setItem(SECRET_KEY,v) : localStorage.removeItem(SECRET_KEY); }catch(e){} }

function vLogin(msg){
  $('app').innerHTML =
    '<div style="text-align:center;padding:9vh 0 16px"><div style="font-size:46px">🖥️</div>'+
    '<div style="font-size:20px;font-weight:800;margin-top:8px">Agence Pro — <span style="color:var(--blue)">Admin</span></div>'+
    '<div style="font-size:12px;color:var(--txt2);margin-top:6px">Tableau de bord intégré · aucun blocage possible</div></div>'+
    '<div class="card"><h2>🔑 Code secret</h2>'+
    '<input type="password" id="sec" placeholder="ton code secret de synchronisation">'+
    (msg? '<div class="err">'+esc(msg)+'</div>' : '')+
    '<button class="btn" id="go">Ouvrir le tableau de bord</button></div>'+
    '<div class="foot">Agence Pro · tableau de bord intégré v4</div>';
  $('go').onclick = function(){ var v = $('sec').value.trim(); if(!v) return; setSecret(v); loadData(); };
  $('sec').addEventListener('keydown', function(ev){ if(ev.key==='Enter') $('go').onclick(); });
}

function loadData(){
  var sec = getSecret();
  if(!sec){ vLogin(); return; }
  loading = true; renderBar();
  google.script.run
    .withSuccessHandler(function(str){
      loading = false;
      var j; try{ j = JSON.parse(str); }catch(e){ vLogin('Réponse illisible'); return; }
      if(!j.ok){ setSecret(''); vLogin(j.error||'erreur'); return; }
      DATA = j; lastT = new Date(); render();
    })
    .withFailureHandler(function(err){ loading = false; vLogin('Erreur : '+(err && err.message || err)); })
    .api(JSON.stringify({secret:sec}));
}
function renderBar(){ var b = $('rf'); if(b) b.innerHTML = loading? '<span class="spin"></span>' : '↻'; }

function chart(items){
  if(items.length < 2) return '';
  var W=340,H=120,pT=16,pB=16,pL=4,pR=4, maxA=1, i;
  for(i=0;i<items.length;i++) if(Math.abs(items[i].v)>maxA) maxA=Math.abs(items[i].v);
  var zero = pT + (H-pT-pB)/2;
  var bw = Math.min(20,(W-pL-pR)/items.length-3);
  var iMax = 0;
  for(i=0;i<items.length;i++) if(Math.abs(items[i].v)>Math.abs(items[iMax].v)) iMax=i;
  var bars='', labels='';
  for(i=0;i<items.length;i++){
    var d=items[i], cx=pL+(W-pL-pR)*(i+.5)/items.length;
    var h=Math.max(3,Math.abs(d.v)/maxA*(H-pT-pB)/2);
    var y=d.v>=0? zero-h : zero;
    var col=d.v>0? '#ff5f5f':'#4ade80';
    bars += '<rect x="'+(cx-bw/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="3" fill="'+col+'" fill-opacity=".9"><title>'+frDate(d.k)+' : '+fmt(Math.abs(d.v))+'</title></rect>';
    if(i===iMax && d.v!==0) labels += '<text x="'+cx.toFixed(1)+'" y="'+((d.v>=0? y-4 : y+h+10)).toFixed(1)+'" font-size="9" fill="'+col+'" text-anchor="middle" font-weight="600">'+(d.v>0?'-':'+')+fmtK(Math.abs(d.v))+'</text>';
    if(items.length<=16 || i%2===0) labels += '<text x="'+cx.toFixed(1)+'" y="'+(H-3)+'" font-size="8" fill="#4a6284" text-anchor="middle">'+d.k.slice(8)+'</text>';
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" style="display:block">'+
    '<line x1="'+pL+'" y1="'+zero.toFixed(1)+'" x2="'+(W-pR)+'" y2="'+zero.toFixed(1)+'" stroke="#28405e" stroke-width="1"/>'+bars+labels+'</svg>'+
    '<div class="legend"><span><span class="ld" style="background:#ff5f5f"></span>Manquant</span><span><span class="ld" style="background:#4ade80"></span>Surplus</span></div>';
}

var EVI = {alerte:'🚨', pointage:'✅', ouverture:'🌅', cloture:'🔒'};
function render(){
  var days = DATA.days||[], events = DATA.events||[], i;
  var latest = null;
  for(i=0;i<days.length;i++){ if(days[i].reel!=='' && days[i].reel!=null){ latest=days[i]; break; } }
  if(!latest && days.length) latest = days[0];
  var today = null;
  for(i=0;i<days.length;i++) if(days[i].date===todayKey()){ today=days[i]; break; }

  var h = '<div class="hdr"><div class="hic">🖥️</div>'+
    '<div><h1><em>Admin</em> — '+esc(latest? latest.agence:'Agence Pro')+'</h1>'+
    '<div class="sub">'+(latest&&latest.agent? 'Agent : '+esc(latest.agent)+' · ':'')+'actualisé '+(lastT? ('0'+lastT.getHours()).slice(-2)+':'+('0'+lastT.getMinutes()).slice(-2):'—')+'</div></div>'+
    '<div class="sp"><button class="icb" id="rf">↻</button><button class="icb" id="lo">⏻</button></div></div>';

  if(!days.length){
    h += '<div class="card"><div class="empty">📭 Aucune journée reçue pour l\\'instant.<br>Fais faire une ouverture ou un pointage à l\\'agent<br>puis appuie sur ↻. Les tests et alertes déjà reçus<br>s\\'affichent dans le fil d\\'activité ci-dessous.</div></div>';
  }else{
    var mt = (latest.manquant_total===''||latest.manquant_total==null)? null : +latest.manquant_total;
    h += '<div class="kpis">'+
      '<div class="kpi hero '+(mt>0?'bad':'ok')+'"><div class="kl">Manquant total'+(mt<0?' (surplus)':'')+'</div>'+
      '<div class="kv">'+(mt==null?'—':fmt(Math.abs(mt)))+'</div>'+
      '<div class="ks">dernier pointage : '+frDate(latest.date)+' à '+esc(latest.maj)+'</div></div>'+
      '<div class="kpi"><div class="kl">Aujourd\\'hui</div><div class="kv">'+(today? (today.pointages||0)+' / 3':'—')+'</div>'+
      '<div class="ks">'+(today? (today.cloturee==='oui'?'journée clôturée 🔒':'pointages faits'):'pas encore ouverte')+'</div></div>'+
      '<div class="kpi"><div class="kl">Écart du jour</div><div class="kv '+(latest.manquant_jour>0?'neg':'pos')+'">'+
      (latest.manquant_jour===''||latest.manquant_jour==null?'—':((+latest.manquant_jour>0?'−':'+')+fmt(Math.abs(+latest.manquant_jour))))+'</div>'+
      '<div class="ks">théorique − réel</div></div></div>';

    var serie = [];
    for(i=days.length-1;i>=0;i--){
      var d0 = days[i];
      if(d0.manquant_jour!=='' && d0.manquant_jour!=null) serie.push({k:d0.date, v:+d0.manquant_jour});
    }
    serie = serie.slice(-30);
    if(serie.length>=2) h += '<div class="card"><h2>📊 Manquant du jour — 30 jours</h2>'+chart(serie)+'</div>';

    var alerts = [];
    for(i=0;i<events.length && alerts.length<5;i++) if(events[i].type==='alerte') alerts.push(events[i]);
    if(alerts.length){
      h += '<div class="card"><h2>🚨 Alertes récentes</h2>';
      for(i=0;i<alerts.length;i++) h += '<div class="ev al"><span class="i">🚨</span><div>'+esc(alerts[i].texte)+'<div class="t">'+esc(alerts[i].date)+' · '+esc(alerts[i].ts)+'</div></div></div>';
      h += '</div>';
    }

    h += '<h2 style="font-size:11.5px;font-weight:800;color:var(--txt2);text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px">📅 Journées</h2>';
    var shown = days.slice(0,30);
    for(i=0;i<shown.length;i++){
      var d = shown[i];
      var open = hOpen===d.date;
      var mt2 = (d.manquant_total===''||d.manquant_total==null)? null : +d.manquant_total;
      h += '<div class="dy"><div class="dy-h" data-k="'+d.date+'">'+
        '<div><div class="d">'+frDate(d.date)+'</div><div class="s">'+(d.cloturee==='oui'?'🔒 clôturée':'ouverte')+' · '+(d.pointages||0)+'/3 pointages · maj '+esc(d.maj)+'</div></div>'+
        '<div class="m '+(mt2>0?'neg':'pos')+'">'+(mt2==null?'—':((mt2>0?'−':'')+fmt(Math.abs(mt2))))+'</div></div>';
      if(open){
        var det = d.detail||{}, cps = det.checkpoints||[], sor = det.sorties||[], j;
        h += '<div class="dy-b">'+
          '<div class="cr"><span class="mut">Ouverture</span><b>'+fmt(d.ouverture)+'</b></div>'+
          '<div class="cr"><span class="mut">+ Entrées</span><b class="pos">+'+fmt(d.entrees)+'</b></div>'+
          '<div class="cr"><span class="mut">− Sorties</span><b class="neg">−'+fmt(d.sorties)+'</b></div>'+
          '<div class="cr"><span class="mut">= Théorique</span><b>'+fmt(d.theorique)+'</b></div>';
        for(j=0;j<cps.length;j++){
          var c = cps[j], mj = c.theorique - c.reelTotal;
          h += '<div class="cr"><span class="mut">'+esc(c.label)+' ('+esc(c.time)+')'+(c.corrections?' ✏️'+c.corrections+'×':'')+'</span><b class="'+(mj>0?'neg':'pos')+'">réel '+fmt(c.reelTotal)+' · '+(mj>0?'−':'+')+fmt(Math.abs(mj))+'</b></div>';
        }
        h += '<div class="cr"><span class="mut">Ancien manquant</span><b>'+fmt(d.ancien_manquant)+'</b></div>'+
          '<div class="cr" style="font-size:13.5px"><span>Manquant total</span><b class="'+(mt2>0?'neg':'pos')+'">'+(mt2==null?'—':fmt(Math.abs(mt2)))+(mt2<0?' (surplus)':'')+'</b></div>';
        for(j=0;j<sor.length;j++){
          h += '<div class="ev"><span class="i">📤</span><div>'+esc(sor[j].motif)+'<div class="t">'+esc(sor[j].time)+'</div></div><div style="margin-left:auto;font-weight:800" class="neg">−'+fmt(sor[j].montant)+'</div></div>';
        }
        h += '</div>';
      }
      h += '</div>';
    }

  }

  /* le fil d'activité s'affiche toujours, même sans journée : c'est là
     qu'apparaissent les tests de liaison et les alertes */
  h += '<div class="card"><h2>📜 Fil d\\'activité</h2>';
  if(events.length){
    var evs = events.slice(0,40);
    for(i=0;i<evs.length;i++){
      h += '<div class="ev'+(evs[i].type==='alerte'?' al':'')+'"><span class="i">'+(EVI[evs[i].type]||'ℹ️')+'</span><div>'+esc(evs[i].texte)+'<div class="t">'+esc(evs[i].date)+' · '+esc(evs[i].ts)+'</div></div></div>';
    }
  }else h += '<div class="empty">Aucun événement</div>';
  h += '</div>';

  h += '<div class="foot">Agence Pro · tableau de bord intégré v4 · actualisation auto chaque minute</div>';
  $('app').innerHTML = h;
  renderBar();
  $('rf').onclick = function(){ loadData(); };
  $('lo').onclick = function(){ setSecret(''); DATA=null; vLogin(); };
  var heads = document.querySelectorAll('.dy-h');
  for(var k=0;k<heads.length;k++){
    heads[k].onclick = (function(key){ return function(){ hOpen = (hOpen===key)? null : key; render(); }; })(heads[k].getAttribute('data-k'));
  }
}

setInterval(function(){ if(DATA && !loading) loadData(); }, 60000);
if(getSecret()) loadData(); else vLogin();
</script>
</body>
</html>`;
/*ADMIN_HTML_END*/
