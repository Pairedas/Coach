/**
 * ═══════════════════════════════════════════════════════════
 *  AGENCE PRO — BACKEND DE SYNCHRONISATION (Google Apps Script)
 * ═══════════════════════════════════════════════════════════
 *
 *  INSTALLATION (5 minutes) :
 *  1. Va sur sheets.new pour créer un Google Sheet vide
 *     (nomme-le par ex. « Agence Pro — Données »)
 *  2. Menu Extensions → Apps Script
 *  3. Supprime le contenu, colle TOUT ce fichier
 *  4. ⚠️ Change CODE_SECRET ci-dessous (ton propre code, long)
 *  5. Bouton « Déployer » → « Nouveau déploiement »
 *       Type : Application Web
 *       Exécuter en tant que : MOI
 *       Qui a accès : TOUT LE MONDE
 *  6. Autorise l'accès quand Google le demande
 *  7. Copie l'URL qui se termine par /exec :
 *       → dans l'app de l'agent : ⚙️ Réglages → Synchronisation
 *       → dans la page admin : à la connexion
 *
 *  Le « Tout le monde » ne rend PAS tes données publiques :
 *  chaque requête doit contenir le CODE_SECRET, sinon elle est rejetée.
 */

const CODE_SECRET = 'CHANGE-MOI-ABSOLUMENT';

/* ────────────────────────────────────────────────────────── */

const DAY_HEADERS = ['date','maj','agence','agent','ouverture','entrees','sorties',
  'theorique','reel','manquant_jour','ancien_manquant','manquant_total',
  'pointages','cloturee','json'];

function doPost(e){
  try{
    const data = JSON.parse(e.postData.contents);
    if(data.secret !== CODE_SECRET) return json({ok:false, error:'code secret invalide'});
    if(data.action === 'day'){ upsertDay(data.day); return json({ok:true}); }
    if(data.action === 'event'){ addEvent(data.event); return json({ok:true}); }
    return json({ok:false, error:'action inconnue'});
  }catch(err){
    return json({ok:false, error:String(err)});
  }
}

function doGet(e){
  const p = e.parameter || {};
  if(p.secret !== CODE_SECRET) return json({ok:false, error:'code secret invalide'});
  if(p.action === 'ping') return json({ok:true, version:1});
  return json({ok:true, days:getDays(90), events:getEvents(150)});
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

/* les dates restent des textes « 2026-08-26 » même si Sheets les convertit */
function norm(v){
  if(v instanceof Date){
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}

/* une ligne par jour, mise à jour à chaque synchronisation */
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
    DAY_HEADERS.forEach(function(h,i){ o[h] = h==='date' ? norm(r[i]) : r[i]; });
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
    return {ts:String(r[0]), date:norm(r[1]), type:String(r[2]), texte:String(r[3])};
  }).reverse();
}

function json(o){
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
