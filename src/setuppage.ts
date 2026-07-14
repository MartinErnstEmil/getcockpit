// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Server-gerendertes Einrichtungs-Panel (Ausnahme-Oberfläche): main.cjs lädt es
// beim Start NUR, wenn runSetup Aufmerksamkeit meldet (harter Fehler ODER
// Legacy-Hooks). Bewusst SELBSTTRAGEND (kein SPA-Build nötig, damit es auch bei
// fehlendem Frontend/E501 anzeigt) und tokenfrei ausgeliefert wie die SPA-Shell
// — das Token trägt die URL, das Skript nutzt es für die /api-Aufrufe.
// Das <script> vermeidet bewusst Template-Literale/`${}` (nur der Token wird per
// JSON.stringify eingespritzt), damit dieser TS-Template-String nichts anderes
// interpoliert.
export function setupPageHtml(token: string): string {
  return `<!doctype html>
<html lang="de" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cockpit — Einrichtung</title>
<style>
  :root { --bg:#161616; --layer:#262626; --layer2:#393939; --text:#f4f4f4; --muted:#a8a8a8;
          --blue:#0f62fe; --green:#42be65; --yellow:#f1c21b; --red:#fa4d56; --border:#393939; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:"IBM Plex Sans",system-ui,Segoe UI,sans-serif; background:var(--bg);
         color:var(--text); line-height:1.45; }
  header { background:#000; padding:14px 20px; border-bottom:1px solid var(--border);
           font-weight:600; letter-spacing:.02em; }
  main { max-width:760px; margin:0 auto; padding:24px 20px 60px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 20px; }
  .summary { padding:12px 16px; border-left:4px solid var(--muted); background:var(--layer);
             margin-bottom:20px; font-weight:600; }
  .summary.ok { border-color:var(--green); } .summary.warn { border-color:var(--yellow); }
  .summary.fail { border-color:var(--red); }
  ul { list-style:none; padding:0; margin:0; }
  li.stage { display:flex; gap:12px; padding:12px 14px; background:var(--layer); border:1px solid var(--border);
             border-top:0; align-items:flex-start; }
  li.stage:first-child { border-top:1px solid var(--border); }
  .dot { width:10px; height:10px; border-radius:50%; margin-top:6px; flex:0 0 auto; background:var(--muted); }
  .dot.ok{background:var(--green);} .dot.warn{background:var(--yellow);} .dot.fail{background:var(--red);}
  .stage .title { font-weight:600; } .stage .code { color:var(--muted); font-family:"IBM Plex Mono",monospace; font-size:12px; }
  .stage .detail,.stage .fix { color:var(--muted); font-size:13px; margin-top:2px; }
  .stage .fix { color:#78a9ff; }
  section.legacy { margin-top:24px; background:var(--layer); border:1px solid var(--border); padding:16px; }
  section.legacy h2 { font-size:15px; margin:0 0 6px; }
  .hint { color:var(--muted); font-size:13px; margin:0 0 12px; }
  label.hook { display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-top:1px solid var(--border); }
  label.hook code { font-family:"IBM Plex Mono",monospace; font-size:12px; color:var(--text); word-break:break-all; }
  .tag { display:inline-block; background:var(--layer2); color:var(--muted); font-size:11px; padding:1px 6px; margin-left:6px; }
  .actions { margin-top:24px; display:flex; gap:12px; flex-wrap:wrap; }
  button { font:inherit; border:0; padding:11px 16px; cursor:pointer; }
  button.primary { background:var(--blue); color:#fff; }
  button.secondary { background:var(--layer2); color:var(--text); }
  button:disabled { opacity:.5; cursor:default; }
  .update { margin-top:16px; padding:10px 14px; border-left:4px solid var(--blue); background:var(--layer);
            font-size:14px; display:none; }
  .err { color:var(--red); margin-top:12px; }
</style>
</head>
<body>
<header>Cockpit</header>
<main>
  <h1>Einrichtung</h1>
  <p class="sub">Geordnete Selbstprüfung: Legacy, Backend, Hooks, Frontend, Test.</p>
  <div id="summary" class="summary">Prüfe …</div>
  <ul id="stages"></ul>
  <div id="update" class="update"></div>
  <div id="legacy"></div>
  <p id="error" class="err"></p>
  <div class="actions">
    <button id="continue" class="primary" disabled>Weiter zu Cockpit</button>
    <button id="recheck" class="secondary">Erneut prüfen</button>
  </div>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
function q(path){ return path + (path.indexOf("?")<0 ? "?" : "&") + "token=" + encodeURIComponent(TOKEN); }
function el(tag, cls, text){ var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
function esc(s){ var d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; }

function renderStages(report){
  var list = document.getElementById("stages"); list.innerHTML = "";
  report.stages.forEach(function(s){
    var li = el("li","stage");
    li.appendChild(el("span","dot "+s.status));
    var body = el("div");
    var head = el("div");
    head.appendChild(el("span","title", s.title + " "));
    head.appendChild(el("span","code","["+s.code+"]"));
    body.appendChild(head);
    if (s.detail) body.appendChild(el("div","detail", s.detail));
    if (s.status!=="ok" && s.fix) body.appendChild(el("div","fix","Fix: "+s.fix));
    li.appendChild(body); list.appendChild(li);
  });
  var sum = document.getElementById("summary");
  if (report.hardFailed){ sum.className="summary fail"; sum.textContent="Einrichtung fehlgeschlagen — siehe Fehlercodes unten."; }
  else if (report.needsAttention){ sum.className="summary warn"; sum.textContent="Fast fertig — Legacy-Hooks prüfen, dann weiter."; }
  else { sum.className="summary ok"; sum.textContent="Alles bereit."; }
  document.getElementById("continue").disabled = false;
}

function renderLegacy(report){
  var wrap = document.getElementById("legacy"); wrap.innerHTML = "";
  if (!report.legacy || report.legacy.length===0) return;
  var sec = el("section","legacy");
  sec.appendChild(el("h2","","Legacy-Hooks gefunden"));
  sec.appendChild(el("p","hint","Bundles von Vorgänger-Produkten. Auswählen, was entfernt werden soll — nichts wird ohne Klick gelöscht."));
  report.legacy.forEach(function(h){
    var lab = el("label","hook");
    var cb = el("input"); cb.type="checkbox"; cb.value = h.event + "::" + h.command; cb.checked = true;
    lab.appendChild(cb);
    var code = el("code"); code.innerHTML = esc(h.event) + ": " + esc(h.command) + '<span class="tag">'+esc(h.marker)+'</span>';
    lab.appendChild(code); sec.appendChild(lab);
  });
  var btn = el("button","secondary","Ausgewählte entfernen");
  btn.onclick = function(){ removeSelected(sec); };
  var act = el("div","actions"); act.appendChild(btn); sec.appendChild(act);
  wrap.appendChild(sec);
}

function removeSelected(sec){
  var keys = Array.prototype.slice.call(sec.querySelectorAll('input:checked')).map(function(c){ return c.value; });
  if (keys.length===0) return;
  fetch(q("/api/setup-remove-hooks"), { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({keys:keys}) })
    .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(){ load(); })
    .catch(function(e){ showError(e); });
}

function renderUpdate(info){
  var u = document.getElementById("update");
  if (info && info.updateAvailable){ u.style.display="block";
    u.textContent = "Update verfügbar: "+info.latest+" (installiert "+info.current+"). Neuen Installer laden — Hooks heilen beim nächsten Start."; }
  else { u.style.display="none"; }
}

function showError(e){ document.getElementById("error").textContent = "Fehler: " + (e && e.message ? e.message : e); }

function load(){
  document.getElementById("error").textContent = "";
  fetch(q("/api/setup")).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(report){ renderStages(report); renderLegacy(report); })
    .catch(function(e){ showError(e); });
  fetch(q("/api/update")).then(function(r){ return r.ok ? r.json() : null; })
    .then(renderUpdate).catch(function(){ /* Update-Check ist optional */ });
}

document.getElementById("continue").onclick = function(){ location.href = q("/"); };
document.getElementById("recheck").onclick = load;
load();
</script>
</body>
</html>`;
}
