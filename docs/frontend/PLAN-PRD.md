# Plan + PRD: Frontend-Umbau — Onepager → strukturierte SPA

Stand: 2026-07-07. Erarbeitet von einem Planungs-Team (System/Struktur/Design),
geprüft von einem unabhängigen Review-Team (Technik + Produkt); alle 16
Review-Findings sind unten als bindende Auflagen eingearbeitet (§9).
Detail-Specs und Reviews liegen im Session-Scratchpad; dieses Dokument ist
selbsttragend.

Scope-Erweiterung 07.07. (PO-Entscheid nach Review): drei Punkte kamen aus
den Nicht-Zielen zurück in v1 — (a) Verlaufs-/Turn-Ansicht, (b) manueller
Theme-Umschalter, (c) NEU: Konfig- und Gedächtnis-Dateien (CLAUDE.md,
memory) auf ihren Strukturebenen in der UI, mit Versions-Navigation,
Diff-Anzeige, Session-Verlinkung und manueller Bearbeitung. Eingearbeitet
in §1.5, §3a, §4, §6.7–6.9, §7, §9a, §10.

---

## 1. PRD

### 1.1 Problem

Die Web-UI ist heute EINE statische Seite (`src/webpage.ts`, 657 Zeilen
Vanilla JS). Die Interaktion darin ist ausgereift (Antwortfeld,
Konsequenz-Chips, Assist, Undo, Tastatur, Scope-Filter), aber die Form ist
entschieden abgelehnt ("kein Onepager"): keine Routen, kein Deep-Link je
Ansicht, kein wartbares Komponentenmodell, alles in einem String.

### 1.2 Zielbild

Eine strukturierte React-SPA nach dem Vorbild der cola-v2-SPA
(`C:/Users/vorsp/dev/cola/packages/spa`): deren Shell, Paketstruktur und
State-Komponenten werden reaktiviert — die bewährte Interaktion und das
Farb-/Wording-System kommen aus dem heutigen Onepager. Maßstab für
Funktions-Parität ist der Onepager, nicht cola.

### 1.3 Persona

"Mittelschlauer Vibecoder": versteht die UI ohne Handbuch, kennt keinen
internen Jargon. Jede Zahl trägt ein handlungsnahes Label, jeder Fehler
steht im Klartext da.

### 1.4 Bindende Entscheidungen (vom Menschen, nicht verhandelbar)

1. Kein Onepager; cola-v2-Struktur reaktivieren; tote Kacheln beleben
   (jede Kachel führt klickbar zu echten Daten); Antwortmöglichkeiten
   direkt in der UI; Tests.
2. Projektauswahl: einzeln / aktive (Default) / alle — inklusive globaler
   Items. einzeln = Server-Filter (`?project=`), aktive = Client-Filter
   über die EINE Staleness-Quelle (`portfolioView.projects[].stale`).
3. Übersichtliches Cockpit "über allem" — klarer Überblick, einfach,
   logisch.
4. LLM-Assist reaktiviert. Härtung unantastbar: toolless Spawns
   (`--disallowedTools`), `<cockpit-item-untrusted>`-Fencing, Token-Auth,
   Host-/Origin-Allowlist, kein CORS, Hard-Bind 127.0.0.1.
5. Onboarding-Hinweis genau EINMAL mit Dismiss-forever; Zustand in
   DB-Events, NICHT localStorage.
6. Antwort-Lebenszyklus unantastbar: trim+redact → FTS-Trigger →
   genau-einmal-Zustellung menschlicher Antworten → Decision-Log.
   `answered` wird nie über `/api/update` gesetzt (Server-Allowlist
   `web.ts:204-211` bleibt samt Wächter-Test).
7. Qualität: vier Zustände (loading/error/empty/success) je View;
   Serverfehler wörtlich anzeigen, nie schlucken; Buttons während async
   disabled mit Indikator; keine Emojis; KISS/YAGNI.
8. Verifikations-Reihenfolge: erst Logik, dann Funktionalität (§10).

### 1.5 Ziele / Nicht-Ziele

Ziele: sechs navigierbare Views (Übersicht, Inbox, Entscheidungen, Suche,
Verlauf, Gedächtnis & Regeln) mit Deep-Links; volle Onepager-Parität;
lebendige Kacheln; konsistente Zahlen (Kachel = Badge = Liste, §9);
deutsch, jargonfrei; Datei-Versionierung mit Diff, Session-Verlinkung
und Bearbeitung für CLAUDE.md/memory (§6.8).

Nicht-Ziele (v2-Kandidaten, bewusst gestrichen — kein cockpit-Backend
und/oder YAGNI): Composer, Settings-Seite (Theme-Umschalter sitzt im
Header, keine eigene Seite), Tasks, Memory-ITEMTYP samt Eskalation
(die Gedächtnis-DATEIEN sind in v1, §6.8), SSE/WebSocket, optimistische
Updates, `GET /api/items/:id`, serverseitige Diff-Berechnung
(Diff läuft im Client).

---

## 2. Architektur

- Neues Workspace-Paket `spa/` (`@flightdeck/cockpit-spa`, `private:true`)
  im cockpit-Repo; Root-`package.json` bekommt `"workspaces": ["spa"]`.
  Stack wie cola v2: React 19, Vite 6, Tailwind 3, react-router 6,
  TanStack Query 5.
- Vite: `base:"/spa/"`, `outDir:"../dist/web"`, `emptyOutDir:true`
  (leert nur `dist/web`, kollidiert nicht mit tsc-Output; Packaging über
  bestehendes `files:["dist"]`). Build-Script:
  `tsc && node scripts/build-hooks.mjs && npm -w @flightdeck/cockpit-spa run build`.
- `web.ts`: Reihenfolge Host-Allowlist → Static → Token. `GET /spa/**`
  tokenfrei (Shell trägt keine Daten; localhost-Bind + Host-Allowlist
  bleiben): ext→MIME-Map, resolve-within-root als Traversal-Guard,
  SPA-Fallback auf `index.html`, `Referrer-Policy: no-referrer` auf HTML.
  ALLE `/api/**` bleiben token- und origin-geschützt.
- `GET /` → 302 auf `/spa/` MIT Query-Forwarding:
  `Location: "/spa/" + url.search` (Auflage T1 — sonst stirbt der
  Bookmark-Einstieg `/?token=`).
- Token-Fluss SPA: `?token=` beim Boot lesen → `sessionStorage` →
  `history.replaceState` (Token raus aus Adresszeile) → danach jeder
  API-Call mit Header `x-cockpit-token`. Kein localStorage, kein Token in
  Query nach Boot. 403 → globaler Error-State mit Klartext-Anleitung.
- `originAllowed` wird um `http://cockpit:<port>` ergänzt (Auflage T4 —
  der beworbene hosts-Alias blockierte sonst alle POST).
- Kein SSE: TanStack-Polling, `staleTime` 5 s, kein `refetchOnWindowFocus`;
  EIN `/api/status`-Call speist Kacheln, Projektkarten und "Jetzt dran".

## 3. API-Delta (minimal, sonst nichts)

1. `POST /api/events` — Body `{eventType, payload?}`, eventType-Allowlist
   `["hint_dismiss"]`, gleiche POST-Härtung (Token+Origin+Content-Type).
   Vor Insert `hasEvent`-Dedup-Prüfung (Auflage T8). → `{ok:true}`.
2. `/api/status` liefert zusätzlich `dismissedHints: string[]` — Query:
   `SELECT DISTINCT json_extract(payload_json,'$.hint') FROM events WHERE
   event_type='hint_dismiss'`. Spalte heißt `payload_json`, nicht
   `payload` (Auflage T2). Roundtrip-Test zwingend (POST → status
   enthält den Hint).
3. `portfolioView` bekommt eine synthetische Global-Zeile (Aggregate aus
   `itemsByProject.get("")`), damit globale Items (`project_path IS
   NULL`) in Kachelzahlen aller Scopes mitzählen (Auflage P1). Die
   Global-Zeile ist in jedem Scope "in Auswahl".
4. `/api/items` akzeptiert `status` als Komma-Liste (z. B.
   `status=new,in_progress`), damit Liste und Kachel-/Badge-Zahl dieselbe
   Definition laden können; Cap bleibt 200 neueste, in der UI als
   "zeigt die 200 neuesten" dokumentiert (Auflage T3).
- Assist-Kinds (4 Werte) werden in der SPA hardcodet; kein `/api/meta`.

## 3a. API-Delta Scope-Erweiterung (Verlauf + Dateien)

**Verlauf (Sessions/Turns):**

5. `GET /api/sessions?project=&limit=` → `{sessions:[{sessionId,
   projectPath, firstTs, lastTs, turnCount}]}` — `GROUP BY session_id`
   über die turns-Tabelle, neueste zuerst, Limit-Cap 100.
6. `GET /api/turns?session=&project=&role=&limit=` → `{turns: TurnRow[]}`
   — Wrapper um `store.listTurns` (die System-Spec-Definition lebt
   wieder auf; Auflage T7 ist durch den PO-Entscheid überholt).
   `listTurns` bekommt zusätzlich einen `sessionId`-Filter (heute nur
   project/role/since, store.ts:563-585); innerhalb einer Session
   chronologisch aufsteigend.

**Dateien (Gedächtnis & Regeln):**

7. Neue Tabelle `file_snapshots`: `id, file_key, project_path (NULL =
   global), content, content_hash, captured_at, session_id (NULL bei
   manueller Änderung außerhalb), source ('hook'|'human'|'restore')`.
   Dedup: kein Insert, wenn `content_hash` dem jüngsten Snapshot
   desselben Keys entspricht. Anlage als NEUE nummerierte Migration in
   `schema.ts` (ADR-004-Mechanik; db.ts UND hookdb.ts migrieren beide)
   (Auflage D1).
8. Snapshot-Erfassung im bestehenden Stop-Hook (`hooks/entry.ts:176`,
   gleicher opportunistischer Pfad wie das Git-Cache-Update): liest die
   allowgelisteten Dateien, hash-vergleicht, schreibt bei Änderung einen
   Snapshot mit der Session-ID aus dem Hook-Payload. Muss das
   Stop-Budget respektieren (Tail-Read-Prinzip: kleine md-Dateien,
   Hash-Check zuerst; bei Fehlern still überspringen wie der Git-Pfad —
   ein fehlender Snapshot ist kein Session-Fehler). Hook-Code nur mit
   Node-Builtins (Hash via `node:crypto`): das Hook-Bundle ist
   zero-dependency (`hookdb.ts:2-3`, node:sqlite statt better-sqlite3)
   (Auflage D1). Concurrency Hook↔Webserver ist durch das bestehende
   Muster gedeckt: WAL + `busy_timeout 5000` (`schema.ts:12-13`),
   Hook schreibt heute schon parallel Turns/Events.
9. Datei-Allowlist ("Strukturebenen") — der Client sendet NUR Keys,
   NIE Pfade; die Key→Pfad-Auflösung ist ausschließlich serverseitig:
   - Ebene Global: `~/.claude/CLAUDE.md`
   - Ebene Projekt: `<project>/CLAUDE.md`
   - Ebene Gedächtnis: `<auto-memory-dir>/MEMORY.md` und
     `<auto-memory-dir>/*.md` (Verzeichnis-Listing, resolve-within-root)
   Zwei Absicherungen (Delta-Review):
   - Der `project`-Parameter ist selbst ein Pfad vom Client → er wird
     gegen die in der DB BEKANNTEN Projektpfade validiert
     (`normalizeProjectPath` + Abgleich mit den distinct project_paths
     aus turns/items); unbekanntes Projekt → 404. Ohne das wäre die
     Schreibfläche auf CLAUDE.md in beliebigen Verzeichnissen
     ausgedehnt (Auflage D3).
   - Der Auto-Memory-Pfad (`~/.claude/projects/<slug>/memory/`) ist
     eine Claude-Code-interne Konvention, die cockpit heute NICHT kennt
     (paths.ts hat keinerlei ~/.claude-Bezug; nur settings.ts:24 und
     backfill.ts:33). Die Slug-Ableitung (nicht-alphanumerische Zeichen
     des normalisierten Projektpfads → `-`) wird als eigene Funktion in
     paths.ts implementiert, mit Existenz-Check: fehlt das Verzeichnis,
     wird die Ebene "Gedächtnis" für dieses Projekt ausgeblendet (kein
     Fehler). Als Konventions-Risiko im Code kommentieren (Auflage D2).
10. `GET /api/files?project=` → Liste `{key, ebene, label, exists,
    latest:{capturedAt, sessionId}}`.
    `GET /api/files/content?key=&project=&version=` → aktueller
    Disk-Inhalt (ohne `version`) oder Snapshot-Inhalt; Antwort enthält
    `baseHash` des Disk-Stands.
    `GET /api/files/versions?key=&project=` → Versionsliste
    `{id, capturedAt, sessionId, source}`.
11. `POST /api/files/save` — Body `{key, project?, content, baseHash}`.
    Gleiche POST-Härtung wie alle anderen (Token+Origin+Content-Type,
    1-MB-Body-Cap deckt md-Dateien). Konflikt-Schutz nach dem
    cola-Muster (`VersionConflictError`, api/config.ts:71): stimmt
    `baseHash` nicht mehr mit dem Disk-Stand überein → 409 mit
    Klartext-Fehler, Client bietet "neu laden" an. Erfolg: Datei
    schreiben, Snapshot mit `source='human'` anlegen.
    Restore = Save mit dem Inhalt einer alten Version
    (`source='restore'`), kein eigener Endpunkt.

Diff-Berechnung: im Client (jsdiff als SPA-Dependency, Zeilen-Diff
zwischen zwei Versionen bzw. Version↔aktuell); der Server liefert nur
Inhalte. Markdown-Rendering von Dateiinhalten läuft durch dompurify
(Muster aus cola vorhanden).

Sicherheits-Rahmen der Schreibfläche (bewusst, weil CLAUDE.md künftige
Sessions steuert): kein neuer Angriffsweg gegenüber dem Editor auf der
Platte — Schreiben nur hinter Token+Origin auf allowgelisteten Keys,
jede Änderung erzeugt einen Snapshot (Audit-Spur + Ein-Klick-Restore).
Web-Token landet weiterhin NIE in CLAUDE.md (bestehende Regel).

## 4. Informationsarchitektur

Client-Routen (react-router, `basename:"/spa"`):

```
/                     → redirect /overview
/overview             Cockpit-Übersicht "über allem" (Default)
/inbox                Inbox nach Dringlichkeit; ?item=<id> Deep-Link
/decisions            Entscheidungs-Log; Umschalter "nur aktueller Stand / volle Kette" (?all=1) (Auflage P8)
/search               Volltextsuche
/sessions             Verlauf: Session-Liste (Auswahl-gefiltert)
/sessions/:sessionId  Turns einer Session, chronologisch
/files                Gedächtnis & Regeln: Datei-Liste nach Ebenen
/files/:key           Datei-Detail: Inhalt, Versionen, Diff, Bearbeiten
*                     → redirect /overview
```

Projektauswahl ("Auswahl", nie "Scope" in der UI — Auflage P3): globaler
Query-Param auf jeder Route, `?scope=active|all|single&project=<path>`,
Default `active` (weglassbar); `single` ohne `project` fällt auf `active`
zurück. Umschalter als Segment-Control im Header
`[Projekt… ▼][Aktiv][Alle]` + Chip `‹projekt› ×` bei Einzelwahl. Der
Header SPIEGELT jede Projektauswahl: Projektkarten-Klick auf /overview ist
ein Shortcut, der dieselbe globale Auswahl setzt und den Header-Chip
sichtbar mitzieht; der Inbox-Typ-Filter (aus Kachel-Klicks) ist eine
getrennte, sichtbar aufhebbare Achse (Auflage P7).

Bewusste Abweichung vom cola-Vorbild: KEINE `/p/:projectId/…`-Routen —
aktive/alle sind projektübergreifend, der Query-Param deckt die bindende
Filter-Entscheidung 1:1, die Sidebar bleibt stabil.

Sidebar: Übersicht · Inbox (Badge) · Entscheidungen (Badge) · Suche ·
Verlauf · Gedächtnis & Regeln. Keine Settings-, Projekte- oder
Composer-Seite. UI-Wörter: "Verlauf" (nie "raw"/"turns"), "Gedächtnis &
Regeln" (nie "config"/"memory files").

Datenfluss: alle Listen-Views teilen EINE `useStatus()`-Query und einen
`inScope`-Selektor (Client-Filter "aktive" erst nach geladenem Status;
Globale sind in jeder Auswahl sichtbar). Konsistenz-Regel (Auflagen
T3+P1+P2): Kachel, Sidebar-Badge und Listen-Filter einer Menge speisen
sich aus DERSELBEN Prädikat-Funktion — konkret:

- "Inbox offen" = `status IN (new,in_progress)`; Liste lädt via
  Komma-Status; postponed ist ausgeblendet und hat einen eigenen
  "Später"-Filter (behebt den Alt-Widerspruch webpage.ts:387 vs.
  views.ts:76).
- "Wartet auf dich" = `source='claude' AND status IN (new,in_progress)` —
  Kachel UND Filterliste nutzen exakt dieses Prädikat (Auflage P2).

## 5. Item-Lebenszyklus in der UI

- Antworten → `/api/answer`; terminal, kein Undo (backend-korrekt:
  `answered` ist aus `/api/update` ausgesperrt). Endgültigkeit wird vor
  dem Speichern dezent signalisiert. Nach Erfolg bleibt die Karte lokal
  stehen mit `↳`-Antwortzeile und Hinweis "zugestellt an die nächste
  Session · in Entscheidungen ansehen"; sie verschwindet bei
  Navigation/Reload. Erfolg-Toast trägt denselben Link (Auflage P6).
- erledigt / später / rückgängig → `/api/update`
  (done/postponed/vorheriger Status); `/api/done` wird nicht benutzt (ein
  kanonischer Pfad). Undo-Toast: 5 s, ein Puffer, kein Stack.
- Kein optimistisches Update: nach Erfolg Query-Invalidierung
  (status+items+decisions); SQLite-Refetch ist billig.
- Assist → `/api/assist {id,kind}`; Kinds: erklären / pro-contra /
  alternativen / swot, der typ-passende als "empfohlen" markiert. Während
  EIN Assist läuft sind ALLE Assist-Knöpfe disabled (Server ist
  Single-Flight); 429/Fehler → Fehlerkarte mit wörtlicher Servermeldung
  plus "KI gerade ausgelastet — in einer Minute nochmal". Ergebnis-Block
  "KI · unverbindlich" mit "In Antwort übernehmen" / "Schließen".
- Deep-Link `/inbox?item=<id>` (Briefing-Antwortlink): client-seitige
  Auflösung gegen die geladene Liste; nicht gefunden → Hinweis MIT
  Weiterklick "In Entscheidungen ansehen" (answered/decision) bzw.
  "In der Suche öffnen" — keine Sackgasse (Auflage P5).

## 6. UX-Spezifikation

### 6.1 Shell und Layout

cola-Shell übernehmen: Grid `220px | 1fr` × `44px | 1fr`, Header über
beide Spalten, Sidebar mit NavLink-Aktiv-Muster. Responsiv minimal:
unter 780px kollabiert die Sidebar auf eine 56px-Icon-Leiste (reine
CSS-Variante), Kachel-Grid `auto-fit minmax(150px,1fr)`, zweispaltige
Bereiche fallen auf eine Spalte.

### 6.2 /overview — der wichtigste Screen

Aufbau (oben nach unten): optionale Onboarding-Leiste → Kachelzeile →
"Jetzt dran" (max. 5) → Projektkarten.

| Kachel | Zahl (Quelle, Auswahl-gefiltert inkl. Global-Zeile) | Klickziel |
|---|---|---|
| Jetzt dran | `nextActions.length` | Sektion "Jetzt dran" |
| Inbox offen | Σ open (new+in_progress) | /inbox ungefiltert |
| Blocker | Σ blockers (Zahl rot bei >0) | /inbox, Filter Blocker |
| Wartet auf dich | Σ waitingOnHuman (Prädikat §4) | /inbox, Filter "wartet" |
| Entscheidungen | `decisions.length` | /decisions |
| Projekte | `projects.length` (Label OHNE "Scope") | Projektkarten-Sektion |

Kachel-Regeln: Zahl groß (28px, `tabular-nums`), Label klein/uppercase und
handlungsnah; Zero-Kacheln bleiben klickbar und führen in einen echten
Empty-State (nie tote Links); fokusbar, Enter/Space klickt.

"Jetzt dran"-Zeile: linker Farbstreifen (Blocker=crit, urgent=warn),
Titel, Projekt-Tag (außer Einzelauswahl), "Warum"-Klartext vom Server;
Klick öffnet die Karte in /inbox mit fokussiertem Antwortfeld.

Projektkarten: Name, `● läuft` bei aktiver Session, "zuletzt TT.MM ·
N Turns", Blocker rot / "N warten", Branch(dirty), letzte Entscheidungen;
Klick setzt die Einzelauswahl (Header zieht sichtbar mit).

### 6.3 /inbox — Item-Karte

Kopfzeile (immer sichtbar): Typ-Chip (Farbe+Text: BLOCKER/FRAGE/VORSCHLAG/
ENTSCHEIDUNG/ERGEBNIS/INFO), Prio-Chip nur bei urgent/high ("dringend"),
Projekt-Chip (außer Einzelauswahl), Titel, Alter ("heute/seit gestern/
seit N Tagen"). Klick klappt EINE Karte inline auf (kein Modal).

Aufgeklappt: Beschreibung (pre-wrap, max 74ch), Anchor `datei:zeile · sha`
in Mono; Label "Deine Entscheidung"; Konsequenz-Chips vor dem Tippen
(durchsuchbar · Briefing an nächste Session · Entscheidungs-Log);
Primärbutton "Speichern & zustellen" (async: disabled + "Speichert…",
Strg+Enter); Assist-Reihe; sekundär "erledigt (e)" / "später (p)".

Tastatur (fertig im Onepager, übernehmen): j/k wählen, o/Enter öffnen,
r antworten, e erledigt, p später, u rückgängig, Esc schließen; sichtbare
Hilfezeile am Seitenfuß.

### 6.4 Vier Zustände je View

`StateView` aus cola wird ERWEITERT, nicht nur übernommen (Auflage P4):
`onRetry`-Callback, Fehler-Renderer als rote Box (`errorbox`-Muster) mit
der WÖRTLICHEN Servermeldung plus Button "Erneut versuchen", deutsche
Texte. Empty-Texte (verbindlich): Inbox "Inbox leer — Fragen erscheinen
hier, sobald Agenten welche stellen."; gefiltert "Nichts in diesem Filter
— Filter oben aufheben."; Entscheidungen "Noch keine Entscheidungen — sie
entstehen automatisch, wenn du Fragen beantwortest."; Projekte "Keine
Projekte in dieser Auswahl."; Suche "Keine Treffer." Erststart-Empty
feiert den Import ("Alles importiert — N Turns aus M Projekten
durchsuchbar.").

### 6.5 Visuelle Sprache

Token aus `webpage.ts:17-31` (Light+Dark) nach Tailwind als
`rgb(var(--x))`: ground/panel/panel-2/ink/ink-2/line/accent/ok/warn/crit/hl.
Farb-Disziplin: Akzent NUR für Primäraktion und Antwort-Balken;
Semantikfarben nur für Status; Bedeutung NIE über Farbe allein (immer
Text dazu). Typo: Body 15px/1.5 System-Sans, Meta 12px, Zahlen
`tabular-nums`, Mono für Branch/SHA/IDs.

Sprache: durchgehend deutsch (Onepager-Wording). Jargon-Verbote in der UI:
augmentation→KI-Assist, stale→"seit N Tagen inaktiv", triage→Inbox,
FTS→Suche, doctor→Setup, waitingOnHuman→"Wartet auf dich",
nextActions→"Jetzt dran", scope→"Auswahl" (Auflage P3).

### 6.6 Onboarding-Hinweis

Gedämpfte `panel-2`-Leiste oben auf /overview: "So funktioniert dein
Cockpit: Agenten legen Fragen ab, du beantwortest sie hier, die Antwort
geht in die nächste Session." Knöpfe "Verstanden" / "nicht mehr zeigen" →
`POST /api/events {eventType:"hint_dismiss", payload:{hint:"onboarding"}}`;
Anzeige-Bedingung aus `status.dismissedHints` (DB, bindend). Der
datengetriebene Capture-Hinweis (Hooks fehlen / keine Sessions) bleibt
davon getrennt als echter Zustand.

### 6.7 /sessions — Verlauf

Liste: eine Zeile je Session — Projekt-Tag, Datum/Zeit ("heute 14:32"),
Dauer-Spanne, Turn-Anzahl; Auswahl-gefiltert (einzeln = Server,
aktive/alle = Client wie überall); neueste zuerst. Klick → Detail.
Detail (`/sessions/:sessionId`): Turns chronologisch als Konversation
(Rolle links als Chip "Du"/"Claude", Inhalt pre-wrap, Zeitstempel als
Meta), Inhalt durch dompurify. Kein Editieren, keine Aktionen — reine
Lese-Ansicht. Empty: "Noch keine Sessions erfasst — sobald du mit
Claude arbeitest, erscheint der Verlauf hier."

### 6.8 /files — Gedächtnis & Regeln

Liste, gruppiert nach Strukturebene mit Klartext-Überschriften:
"Global (gilt überall)" → `~/.claude/CLAUDE.md`; "Projekt" →
`<projekt>/CLAUDE.md`; "Gedächtnis" → MEMORY.md + Einzeldateien.
Je Zeile: Label, "geändert TT.MM" (jüngster Snapshot), Ebenen-Badge.
Fehlende Datei: sichtbar als "existiert noch nicht" (kein Anlegen in v1).

Detail (`/files/:key`) — drei Modi über eine Segment-Leiste:
1. **Lesen** (Default): gerenderter Inhalt (dompurify), Kopfzeile mit
   Versions-Navigation: `◀ ▶` plus Dropdown "Version vom TT.MM hh:mm"
   (Quelle: Versionsliste). Jede Version zeigt ihre Herkunft: "aus
   Session ‹Datum›" als LINK auf `/sessions/:sessionId` (Click-to-
   Session), "von dir bearbeitet" oder "wiederhergestellt".
2. **Diff**: Zeilen-Diff der gewählten Version gegen die vorherige
   (Default) oder gegen den aktuellen Stand (Umschalter); grün/rot mit
   +/-Präfix (Farbe nie allein). Leer-Diff: "Keine Änderung zwischen
   diesen Ständen."
3. **Bearbeiten**: Textarea (Mono) mit dem aktuellen Disk-Stand,
   "Speichern" (async disabled + "Speichert…"), Konflikt (409) →
   Fehlerbox "Die Datei wurde inzwischen geändert" mit Button "Neu
   laden". Bei alter Version zusätzlich "Diesen Stand wiederherstellen"
   (= Save mit Versionsinhalt, mit Bestätigung, da es den aktuellen
   Stand überschreibt — der ist aber selbst als Snapshot gesichert).

Hinweis-Zeile im Editor (dezent, immer sichtbar): "Änderungen an
CLAUDE.md steuern künftige Claude-Sessions." — der Nutzer soll wissen,
was er anfasst.

### 6.9 Theme-Umschalter

Drei-Zustands-Umschalter im Header (rechts, neben Setup-Chips):
System / Hell / Dunkel. Umsetzung: `data-theme`-Attribut auf dem
Root-Element über den CSS-Variablen aus §6.5; "System" entfernt das
Attribut (zurück zu `prefers-color-scheme`). Persistenz: localStorage —
bewusste Ausnahme von der DB-Event-Regel: die gilt für Workflow-Zustand
(Onboarding-Hinweis), Theme ist eine GERÄTE-Anzeige-Präferenz und soll
gerade nicht zwischen Geräten synchronisieren.

---

## 7. Phasenplan

1. **Gerüst**: `spa/`-Workspace (Vite/Tailwind/Router/Query), Shell,
   Token-Boot; `web.ts` lernt `/spa/**` + `/`-Redirect mit
   Query-Forwarding; beide UIs koexistieren. Logik-Tests
   Static/Härtung/Redirect.
2. **Backend-Delta**: Global-Zeile in `portfolioView`, Komma-Status in
   `/api/items`, `POST /api/events` + `dismissedHints`
   (payload_json!), Origin-Alias. Tests je Punkt.
3. **Views** in Reihenfolge /overview → /inbox → /decisions → /search;
   je View vier Zustände + deutsche Texte; gemeinsame Prädikat-Funktionen
   für Kachel/Badge/Filter. Theme-Umschalter im Header (§6.9).
4. **Atomarer Schnitt** in EINEM Commit: `GET /` → 302 `/spa/` endgültig,
   `PAGE`-Import + `webpage.ts` gelöscht, PAGE-Tests umgestellt
   (`/` ohne Token jetzt 302, Auflage T6). Kein Flag, kein Shim.
   Ab hier ist Onepager-Parität erreicht — die Erweiterungs-Views
   kommen DANACH, damit der Schnitt nicht auf ihnen wartet.
5. **Verlauf**: `/api/sessions` + `sessionId`-Filter in `listTurns` +
   `/api/turns` (§3a.5-6) mit Tests, dann /sessions-Views (§6.7).
6. **Gedächtnis & Regeln**: `file_snapshots` + Stop-Hook-Erfassung +
   Datei-Endpunkte (§3a.7-11) mit Tests (inkl. 409-Konflikt und
   Allowlist-Reject), dann /files-Views (§6.8).
7. **Funktionalität**: Playwright-Smoke (§10 B); danach Klick-Feedback
   des Menschen einholen.

## 8. Risiken

1. Härtungs-Regression durch tokenfreie Assets → nur Shell tokenfrei;
   Wächter-Tests: `/spa/**` ohne Token 200 UND `/api/**` ohne Token 403.
2. Token-Leak (URL/History/Referer) → sessionStorage + replaceState +
   no-referrer; keine externen Requests (Vite bündelt alles).
3. Zahlen-Inkonsistenz (Kachel≠Badge≠Liste) → gemeinsame Prädikate +
   Global-Zeile (Auflagen T3/P1/P2), Tests darauf.
4. Antwort-Lebenszyklus berührt → SPA setzt answered nie; bestehender
   Allowlist-Test bleibt unverändert als Wächter.
5. Windows-Static-Serving → explizite MIME-Map, resolve-within-root,
   Vitest läuft auf win32; Traversal-Test mit ENCODIERTEN Punkten
   (`%2e%2e%2f`), literale `../` normalisiert `new URL` weg (Auflage T5).

## 9. Review-Auflagen (bindend, alle 16 Findings)

| Nr | Schwere | Auflage |
|---|---|---|
| T1 | BLOCKER | `/`→`/spa/`-Redirect forwardet die Query (`+ url.search`); Wächter-Test `GET /?token=` → 302 mit Token in Location |
| T2 | BLOCKER | dismissedHints-Query auf `payload_json`; Roundtrip-Test POST→status |
| T3 | MAJOR | Kachel/Badge/Liste aus derselben Definition; `/api/items` Komma-Status; 200er-Cap dokumentiert. GEÄNDERT per PO-Entscheid 09.07. (Item i-e41e9e9c57): die gemeinsame Definition für Inbox-Default, Sidebar-Badge und Kachel "Wartet auf dich" ist `isActionable` (source=claude, Typ Frage/Blocker/Vorschlag, offen); alles übrige Offene liegt im "Log"-Tab; Kachel "Inbox offen" führt in die transiente `?filter=open`-Ansicht |
| T4 | MAJOR | `originAllowed` + `http://cockpit:<port>`; Origin-Test unter dem Alias |
| T5 | MINOR | Traversal-Test mit encodierten Punkten |
| T6 | MINOR | Test-Delta: `/` ohne Token → 302 (Härtungs-Wächter wandert auf `/api/**`) |
| T7 | MINOR | ÜBERHOLT durch PO-Entscheid 07.07.: `GET /api/turns` kommt zurück (§3a); die System-Spec-Definition samt Tests gilt wieder |
| T8 | MINOR | `hint_dismiss` mit `hasEvent`-Dedup vor Insert |
| P1 | BLOCKER | Synthetische Global-Zeile in `portfolioView`; Kachelzahlen verlieren nie globale Items. GEÄNDERT per PO-Entscheid 11.07.: globale Items (ohne Projektzuordnung) erscheinen in den Item-Ansichten NUR im "Alle"-Modus — in "Aktiv" und Einzelprojekt ausgeblendet (`inScope` gibt für Globale außerhalb "Alle" false), weil uralte globale cola-Items die Projektansicht fluteten und den Filter kaputt wirken ließen. Die synthetische Global-Zeile in portfolioView (Server) bleibt. |
| P2 | MAJOR | EIN Prädikat "Wartet auf dich" (`source='claude' AND status IN (new,in_progress)`) für Kachel UND Filter. GESCHÄRFT per PO-Entscheid 09.07.: zusätzlich `type IN (question,blocker,proposal)` — siehe T3-Änderung |
| P3 | MAJOR | Wort "Scope" nirgends in der UI; "Auswahl"; Kachel-Label "Projekte" |
| P4 | MAJOR | StateView-Erweiterung (onRetry, rote Fehlerbox mit Servertext, deutsch) als echte Arbeit eingeplant |
| P5 | MINOR | Item-Deep-Link-Sackgasse: Weiterklick zu /decisions bzw. /search anbieten |
| P6 | MINOR | Nach answer: Karte bleibt lokal mit ↳-Zeile + Link "in Entscheidungen ansehen"; Toast trägt denselben Link |
| P7 | MINOR | Header spiegelt jede Projektauswahl; Kartenklick zieht Header-Chip sichtbar mit; Inbox-Typ-Filter als getrennte, aufhebbare Achse |
| P8 | MINOR | /decisions behält Umschalter "nur aktueller Stand / volle Kette" (`?all=1`) |

### 9a. Delta-Auflagen Scope-Erweiterung

Die Erweiterung (§3a, §6.7-6.9) entstand NACH dem Team-Review und hat
ein eigenes Delta-Review durchlaufen (am Code verifiziert). Die
D-Auflagen sind gleichrangig bindend:

| Nr | Schwere | Auflage |
|---|---|---|
| D0 | — | Schreibfläche: Client sendet nur Keys, Key→Pfad-Auflösung serverseitig, resolve-within-root fürs Memory-Verzeichnis, 409-Konflikt nach cola-Muster, Snapshot vor jedem Überschreiben |
| D0b | — | Stop-Hook-Snapshot ist opportunistisch (Fehler still, Budget respektieren) — ein Snapshot-Fehler darf nie eine Session stören |
| D1 | MINOR | `file_snapshots` als neue nummerierte Migration in schema.ts (ADR-004); Hook-Snapshot-Code nur Node-Builtins (zero-dependency-Bundle, hookdb.ts:2-3), Hash via node:crypto |
| D2 | MAJOR | Auto-Memory-Slug-Ableitung als Funktion in paths.ts (Konvention: nicht-alphanumerisch → `-` auf dem normalisierten Pfad), Existenz-Check mit Ausblenden der Gedächtnis-Ebene als Fallback, Konventions-Risiko im Code kommentiert |
| D3 | MAJOR | `project`-Parameter der /api/files-Routen gegen die in der DB bekannten Projektpfade validieren (normalizeProjectPath + distinct project_paths); unbekannt → 404 |

Delta-geprüft und tragfähig (kein Handlungsbedarf): Session-Gruppierung
(`turns.session_id` NOT NULL + Index `turns_session`, schema.ts:98,107);
Hook↔Web-Concurrency (WAL + busy_timeout 5000, schema.ts:12-13,
bestehendes Muster); 1-MB-Body-Cap deckt md-Dateien (web.ts:72);
Theme via localStorage kollidiert mit keiner Repo-Regel (die
DB-Event-Bindung betrifft den Onboarding-Hinweis); Phasen-Reihenfolge
(Schnitt vor Erweiterung) bricht keinen Paritäts-Begriff und keinen
Test.

## 10. Teststrategie (Reihenfolge bindend: erst Logik, dann Funktionalität)

**A. Logik (Gate — muss grün sein, bevor B startet):**
- Vitest Web-Level (Muster `test/web.test.ts`): Static-Serving
  (200+MIME, encodierter Traversal → 404, SPA-Fallback), Redirect mit
  Query (T1), Härtungs-Wächter (`/spa/**` ohne Token 200, `/api/**` ohne
  Token 403, kein CORS), `POST /api/events`
  (Allowlist-Reject/Origin/Happy/Dedup), dismissedHints-Roundtrip (T2),
  Komma-Status, Global-Zeile in status (P1), Origin-Alias (T4);
  Assist-Mock + 429-Guard und `/api/update`-Allowlist-Test bleiben
  unverändert.
- Erweiterung: `/api/sessions` (Gruppierung, Limit-Cap),
  `/api/turns` (Session-Filter, Chronologie), `/api/files/*`
  (Allowlist-Reject für fremde Keys, Memory-Traversal mit encodierten
  Punkten → 404, Konflikt-409-Roundtrip, Snapshot-Dedup per Hash,
  Save→Snapshot mit source=human), Stop-Hook-Snapshot (Hash-Gleichheit
  → kein Insert; Datei fehlt → kein Fehler).
- SPA `tsc --noEmit` als Gate; EIN fokussierter Vitest für reine Helfer
  (Token-Capture, inScope/Prädikate). Mehr nicht.

**B. Funktionalität (nur nach grünem A):**
- Playwright-Smoke gegen echten Server (gebautes `dist/web`,
  Temp-SQLite, Seed via Store): Boot über `/?token=` → Redirect →
  Übersicht rendert Kacheln; Item beantworten → Reload → answered
  persistiert + in /decisions sichtbar; später/Undo; falsches Token →
  Error-State. Kein Assist im Smoke (auf Logik-Ebene per Mock abgedeckt).
- Nicht getestet: Rendering-Details, Router-Verkabelung,
  Komponenten-Snapshots.

## 11. Definition of Done

1. Alle Logik-Tests grün (bestehende 137 + neue), SPA-Typecheck grün.
2. Playwright-Smoke grün (inkl. je einem Smoke für /sessions und
   /files: Datei ansehen, Version wechseln, Diff sichtbar, Speichern
   mit Konflikt-Pfad).
3. `webpage.ts` gelöscht, kein toter Export, kein Flag.
4. Alle Review-Auflagen nachweislich umgesetzt (T1–T8, P1–P8, D-Reihe).
5. Onepager-Paritäts-Check: Suche, Statusboard, Decisions inkl.
   Ketten-Umschalter, Antwort/erledigt/später/Undo, Assist, Tastatur,
   Setup-Chips — alles in der SPA vorhanden.
6. Erweiterung vollständig: Verlauf navigierbar, Datei-Versionen mit
   Diff + Session-Link + Bearbeiten/Restore, Theme-Umschalter wirkt.
7. Klick-Feedback des Menschen eingeholt (Link zur laufenden UI).
