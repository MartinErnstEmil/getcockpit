# PRD — cola2 (Arbeitsname)

Stand: 2026-06-11. Grundlage: cola-analyse.md (inkl. Expertenreview §11) und fünf Koryphäen-Reviews (Systems, Produkt, Security, Agentic, Red-Team) vom selben Tag. Dieses Dokument ist für den autonomen Overnight-Build verbindlich.

## 1. Produkt in einer Zeile

> Grep für dein gesamtes Claude-Code-Gedächtnis — jede Session, die du je gefahren hast, in Sekunden volltextdurchsuchbar. Lokal, rückwirkend ab Minute 1, ohne Cloud.

Verkauft wird der **Backfill-Moment** (rückwirkende Durchsuchbarkeit der vorhandenen `~/.claude/projects`-Historie), nicht "Memory" und nicht die Inbox. Die Inbox ist Beifang, nicht Versprechen.

## 2. Problem

1. Claude-Code-Sessions enthalten Entscheidungen und Kontext, die nach Session-Ende praktisch unauffindbar sind. Die Rohdaten liegen bereits lokal (auf der Referenzmaschine: ~1.240 JSONL-Dateien, ~440 MB unter `~/.claude/projects`), aber ohne Index sind sie tot.
2. Fragen/Entscheidungen eines Agenten haben keinen persistenten, sessionübergreifenden Ort mit Antwort-Rückkanal.

Belegte Anti-Ziele (Telemetrie des Vorgängers): MCP-Suche wurde 0× freiwillig aufgerufen, Inbox-Triage zu 78 % verweigert. Konsequenz: Der Wert muss ohne Verhaltensänderung von Modell oder Mensch entstehen (CLI-Suche, automatisches Briefing) — nicht durch Protokoll-Hoffnung.

## 3. Zielnutzer

Beachhead: Entwickler, die Claude Code intensiv nutzen und ihre Historie durchsuchen wollen (Tag-1-Wert). Sekundär: Power-User mit unbeaufsichtigten/parallelen Agenten (Inbox-Rückkanal). Nicht-Zielgruppe V1: Teams, Orgs, Governance.

## 4. Ziele / Nicht-Ziele

**Ziele V1:**
- G1: Gesamte vorhandene Claude-Historie in < 10 Minuten importiert und durchsuchbar (Backfill).
- G2: `cola2 search "<query>"` liefert gerankte Treffer (BM25) in < 1 s P95 bei ~500 MB Korpus.
- G3: Laufende Sessions werden deterministisch erfasst — ohne laufenden Server, ohne Modell-Kooperation (Hooks schreiben direkt in SQLite).
- G4: Items (Frage/Entscheidung) überleben Sessions; beantwortete Items erreichen die nächste Session automatisch (SessionStart-Briefing).
- G5: Installation, Diagnose und rückstandsfreie Deinstallation in je einem Befehl.

**Nicht-Ziele V1 (Streichliste, verbindlich):** Composer/Snippets, Memory-Items + MEMORY.md-Pipeline, BM25-Injektion in den Prompt-Pfad, Routing-Guard (auch observe), Web-UI im Kern (nur Stretch), Mobile/Tailscale, Push, Embeddings, Multi-Agent-Views, npm-publish (nur dry-run; Namensfrage ist Human-Gate), Supersede-*Oberfläche* (Datenmodell-Spalte ja, Feature nein).

## 5. Features und Akzeptanzkriterien

**F1 — Backfill-Importer (das Produkt):**
- Importiert `~/.claude/projects/**/*.jsonl` streaming, idempotent (Dedupe über Transcript-`uuid`), eine Transaktion pro Datei, Bookkeeping-Tabelle (Pfad, mtime, size) → Resume und Inkremental-Import sind derselbe Codepfad.
- Projektpfad stammt aus dem `cwd`-Feld der Transcript-Zeile, niemals aus dem Verzeichnisnamen (lossy, laufwerks-hartkodiert).
- Defekte/partielle Zeilen werden geskippt und gezählt; Abschlussreport (Dateien, Turns, Skips, Redactions, Dauer).
- `--dry-run`, `--limit N`, `--project <pfad>`. Doppellauf = identische Zählung, null Duplikate.
- Akzeptanz: Fixture-Import asserted; Doppellauf-Idempotenz asserted; Smoke gegen Kopie von ≥10 echten Dateien in %TEMP%.

**F2 — Suche:**
- `cola2 search "<query>"` (CLI, erstklassig): gerankte Treffer mit Projekt, Datum, Rolle, Snippet. BM25 mit Spaltengewichten; Terme einzeln gequotet, implizites AND; FTS5-Syntaxfehler → Fallback Phrasensuche. Filter `--project`, `--since`, `--role`.
- Gleiche Suche via MCP (`search_decisions`, `recent_turns`).
- Akzeptanz: Multi-Term-Query findet Dokument ohne exakte Phrase; Ranking-Test (Titel-Treffer schlägt Body-Treffer); P95-Messung dokumentiert.

**F3 — Capture-Hooks (UserPromptSubmit, Stop):**
- Schreiben direkt per SQLite in `~/.cola2/cola2.db` (WAL, busy_timeout) — kein Server nötig. Dead-Letter-JSONL nur bei DB-Fehler.
- Ein Node-Prozess pro Event (In-Process-Dispatch, kein spawn pro Subskript). Exit-Code immer 0. Latenz-Budget: ≤ 150 ms UserPromptSubmit, ≤ 2 s Stop (Tail-Read 256 KB statt Vollfile).
- Stop-Hook liest Turn-`uuid` aus dem Transcript (gleicher Dedupe-Schlüssel wie Backfill).
- Per-Projekt-Opt-out: `.cola/no-capture`.
- Akzeptanz: stdin-Fixture-E2E (kaputtes JSON, fehlender transcript_path, CRLF, leere Message) → DB-Row bzw. sauberer Exit 0.

**F4 — Redaction am Ingest (Capture UND Backfill):**
- Regex-Patterns (`sk-`, `ghp_`, `AKIA`, JWT `eyJ`, `-----BEGIN…KEY-----`, `Bearer `, Hochentropie-Tokens ≥ 32 Zeichen) → `[REDACTED:<typ>]`; Roh-Treffer werden nie persistiert.
- DB-Datei und `~/.cola2/` mit restriktiven Permissions (POSIX 600/700, Windows ACL nur aktueller User).
- Akzeptanz: Fixture mit allen Pattern-Typen → DB enthält keinen Roh-Treffer; Report zählt Redactions.

**F5 — Mini-Inbox:**
- Items: question/proposal/decision/blocker/result/fyi; Felder: Titel, Body, Status, Priorität, Tags, Anchor (Datei:Zeile), Git-SHA/Branch, parentId (Spalte vorhanden, keine Oberfläche).
- CLI: `cola2 inbox`, `cola2 add`, `cola2 answer <id>`, `cola2 done <id>`. Keine Web-UI im Kern.
- Akzeptanz: CRUD-Tests; answer setzt Status und persistiert Antwort.

**F6 — MCP-Server (6 Tools):** `add_item`, `list_items`, `update_item`, `answer_question`, `search_decisions`, `recent_turns`. Keine Datei-Schreib-Tools in V1 (keine Allowlist-Fläche nötig).
- Akzeptanz: Integrationstest via MCP-SDK-Client + StdioClientTransport gegen Temp-DB, jedes Tool aufgerufen.

**F7 — SessionStart-Briefing (einziger Injektionspfad):**
- Injiziert offene + frisch beantwortete Items des Projekts als `additionalContext`. Nur menschlich beantwortete/triagierte Items; harte Caps (max. 10 Items, max. 2.000 Zeichen gesamt); pro session_id genau einmal (Events-Tabelle als Dedupe); zugestellte Antworten werden als zugestellt markiert.
- Inhalt in Untrusted-Wrapper (`<cola2-inbox-untrusted>…`) mit Daten-nicht-Anweisungen-Präfix; Briefing-Marker wird im Capture-Pfad gestrippt (Echo-Bruch). Dokumentierter Off-Switch.
- source-sensitiv: startup/resume ja, clear/compact nein.
- Akzeptanz: SessionStart-Fixture → stdout-JSON-Shape (`hookSpecificOutput.additionalContext`) asserted; Zweitaufruf gleiche Session → leer.

**F8 — Lifecycle-Befehle:** `cola2 init` (Diff-Anzeige vor settings.json-Schreiben, Backup, idempotent, fremde Hooks unangetastet — Multiplexer-Pattern; MCP via `claude mcp add-json`; danach Backfill-Angebot mit Redaction-Report und expliziter Bestätigung), `cola2 doctor` (5 Standard-Fehlerbilder mit Fix-Befehl), `cola2 uninstall` (settings.json byte-genau zurück, DB bleibt mit Hinweis), `cola2 purge [--project]`, `cola2 stats` (Events-Tabelle: Suchen, Briefings, Capture-Quote, Inbox-Antwortquote).
- WICHTIG Overnight: `init` wird gebaut und getestet (Temp-Fixtures), aber im Lauf NIE gegen `~/.claude/settings.json` ausgeführt.

**F9 — Alt-Daten-Migration (Pflicht-Scope, Red-Team-Bedingung 2):**
> **Ist-Stand 08.07.2026:** F9 wurde gebaut, hat seinen Zweck erfüllt (Rollover Phase 4: 64/64 Items final importiert) und wurde danach **komplett entfernt** — `import-legacy` existiert im Code nicht mehr (PO-Entscheidung beim UI-Overhaul: „cola" ist für Externe verstörend). Der Rest dieses Abschnitts ist historische Spezifikation.
- `cola2 import-legacy` liest `~/.cola/cola.db` (read-only) und übernimmt alle 58 Items inkl. Antworten, Ankern, Tags, parentId-Ketten. Alte Turns werden NICHT migriert (kommen vollständiger aus dem Backfill).
- Akzeptanz: 58/58 Items importiert, Stichprobe 5 Items feldweise identisch (gegen Kopie der DB getestet, nie gegen das Original).

## 6. Production-Checkliste (Morgen-Gauntlet — prüft der MENSCH, nicht der Agent)

Die Nacht liefert einen Release-Kandidaten. "Erfolgreich" heißt, der Mensch besteht morgens:
1. [ ] `npm test` + `npm run build` grün in frischer Shell.
2. [ ] `cola2 init` auf der echten Maschine (oder Zweitkonto/VM) läuft durch; settings.json-Diff plausibel.
3. [ ] Voll-Backfill der echten Historie nach Sichtung des Redaction-Reports; 0 Crashes, Skips berichtet.
4. [ ] `cola2 search` liefert relevante Treffer über die Alt-Historie; P95 < 1 s.
5. [ ] Echte Claude-Code-Session: Turn erscheint in der DB; Folgesession erhält Briefing.
6. [ ] Item-Roundtrip: via MCP anlegen → CLI beantworten → nächste Session liest Antwort.
7. [ ] `cola2 import-legacy`: 58 Items da, Stichprobe identisch.
8. [ ] `cola2 uninstall` stellt settings.json byte-genau wieder her.
9. [ ] README: Quickstart, "What runs on your machine", Uninstall-Einzeiler, Lizenz-FAQ (3 Sätze).
10. [ ] `npm publish --dry-run` grün unter dem (noch zu entscheidenden) finalen Namen.
Scheitert der Gauntlet nach Nacht + max. 4 Stunden begleiteter Fixes: Status = fehlgeschlagenes Experiment, Rückkehr zum Konsens-Plan auf dem Alt-Repo (Red-Team-Bedingung 4). Kein Nachbesser-Marathon.

## 7. Erfolgs-Metriken (30 Tage nach Launch, entscheidungsbindend)

1. **Fremd-Adoption:** ≥ 5 unabhängige Menschen mit nachweisbarer Interaktion (Issue/Discussion/Backfill-Report). Darunter: Stopp-Gate (passive Capture als Privatwerkzeug behalten, aktive Entwicklung einstellen).
2. **Such-Nutzung (0×-These widerlegen):** Maintainer + ≥ 3 Externe führen in Woche 4 je ≥ 3 Suchen aus (lokal via `cola2 stats`, kein Phone-Home).
3. **Inbox-Lebenszeichen:** Triage-Quote > 50 % binnen 72 h bei allen, die Items anlegen — inkl. Maintainer. Bei ~0: Inbox wird in V1.1 entfernt.
Der Re-Evaluations-Trigger (vision/17 §10.6 des Alt-Repos) läuft durch den Rewrite NICHT neu an (Red-Team-Bedingung 5).

## 8. Human-Gates (kann der Overnight-Lauf nicht setzen)

- Finaler Paketname (npm `cola` ist vergeben — cujojs; Entscheidung: Rename oder Scoped Package) — vor Launch.
- `license@`-E-Mail real einrichten; rechtlicher Copyright-Inhaber-String; CLA-vs-DCO-Entscheidung (ohne CLA ist die kommerzielle Dual-Lizenz nach dem ersten Fremd-Merge tot).
- Bestätigung des Voll-Backfills nach Redaction-Report.
- Finale Freigabe nach Gauntlet.
