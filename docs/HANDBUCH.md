# Cockpit — Handbuch

Stand: 2026-07-09. Für Anwender, nicht für Entwickler — kein Vorwissen nötig.

## 1. Was Cockpit ist

Cockpit ist der Projektstand, der sich selbst schreibt. Während du mit Claude
Code arbeitest, zeichnet Cockpit im Hintergrund auf, was besprochen und
entschieden wird — über alle Projekte hinweg. Du bekommst dafür:

- eine **Inbox** mit allem, was auf deine Entscheidung wartet,
- ein **Entscheidungs-Log** mit allem, was je entschieden wurde (samt „ersetzt
  durch"-Kette),
- einen durchsuchbaren **Verlauf** jeder Session,
- ein **Briefing** je Projekt: Wo steht es, was sind die nächsten Schritte?

Der Kreislauf: Ein Agent stellt in einer Session eine Frage → sie landet als
Karte in deiner Inbox → du antwortest im Web (wann du willst) → die Antwort
wird **der nächsten Session dieses Projekts automatisch zugestellt** und dort
weiterverarbeitet. Nichts geht verloren, nichts musst du pflegen.

Alles läuft lokal: eine SQLite-Datei unter `~/.cockpit/`, kein Server im
Internet, kein Phone-Home.

## 2. Installation

**Voraussetzungen:** Node.js ≥ 22.5 und Claude Code (das `claude`-Kommando).
Ohne `claude`-Binary funktioniert alles außer den KI-Funktionen (Einordnung,
Briefing-Zusammenfassung, Standup) — die zeigen dann eine Fehlerbox bzw.
Rohdaten statt eines KI-Textes.

```
npm install -g getcockpit   # bzw. Tarball/Repo, solange unveröffentlicht
cockpit init                         # zeigt den settings.json-Diff und fragt nach
cockpit backfill --dry-run           # Redaction-Report ansehen
cockpit backfill                     # gesamte bisherige Historie importieren
cockpit web                          # Oberfläche starten
```

`init` richtet zwei Dinge ein: die **Capture-Hooks** in deiner
`~/.claude/settings.json` (mit Diff-Vorschau, Rückfrage und Backup — fremde
Einträge bleiben unangetastet) und den **MCP-Server** „cockpit", über den
Agenten Fragen in deine Inbox legen. `cockpit doctor` prüft die Installation
und nennt zu jedem Problem den Fix-Befehl.

Die Web-Oberfläche druckt beim Start ihre Adresse mit Token, z. B.
`http://cockpit.localhost:7878/?token=…` — Lesezeichen setzen; das Token bleibt
stabil. Die `*.localhost`-Adresse zeigt in jedem Browser automatisch auf deinen
Rechner (kein Eintrag nötig); alternativ tut es `http://127.0.0.1:7878/?token=…`.

**Wichtig:** Steht in deiner `~/.claude/settings.json` irgendwo
`"disableAllHooks": true`, sind Aufzeichnung UND Antwort-Zustellung
ausgesetzt, obwohl alles installiert ist.

## 3. Die Oberfläche

Oben im Kopf: die **Projektauswahl** — `[Projekt…] [Aktiv · N] [7 Tage ▾] [Alle · N]`.

- **Aktiv** (Standard) zeigt, woran gerade gearbeitet wird: Projekte mit
  laufender Session oder Aktivität in der gewählten Periode (7/14/30/90 Tage).
  Die Periode begrenzt auch das Alter der Karten — Älteres wird mit sichtbarem
  Hinweis ausgeblendet, nie stillschweigend.
- **Alle** hebt die Zeitgrenze auf. **Projekt…** wählt ein einzelnes Projekt
  (der ×-Chip daneben hebt die Wahl wieder auf).
- Der Punkt „● System OK" zeigt die Gesundheit der Installation (Details per
  Maus darüber).

Links die Navigation: Übersicht, Briefing, Inbox, Entscheidungen, Suche,
Report, Verlauf, Gedächtnis & Regeln. Das Inbox-Badge zählt nur, was wirklich
auf dich wartet.

## 4. Übersicht

Sechs Kacheln (jede klickbar und immer deckungsgleich mit ihrer Zielansicht):
Jetzt dran, Inbox offen, Blocker, Wartet auf dich, Entscheidungen, Projekte.
Darunter „Jetzt dran" (die 5 dringendsten offenen Punkte) und die
Projektkarten. **Klick auf eine Projektkarte öffnet das Briefing des Projekts.**

## 5. Briefing

Die Status-Zusammenfassung eines Projekts:

- **Sofort da (ohne KI):** letzte Aktivität, Git-Stand (Branch, ungesicherte
  Dateien, letzte Commits), „Wartet auf dich" (jeder Punkt klickbar zur
  Karte), letzte Entscheidungen.
- **„Zusammenfassen lassen":** die KI schreibt in ~20–60 s den Stand der
  letzten 7 Tage plus **bewertete nächste Schritte** (Was — warum jetzt ·
  Aufwand S/M/L · Risiko, wenn es liegen bleibt). Strenge Quellenpflicht:
  erfundene Referenzen werden automatisch entfernt. Ist die KI nicht
  erreichbar, erscheinen ehrlich die Rohdaten.
- **„Für Session kopieren":** legt das ganze Briefing als Markdown in die
  Zwischenablage — zum Einfügen in ein Claude-CLI-Fenster, wenn du eine neue
  Session mit vollem Kontext starten willst.

„← Alle Projekte" führt zurück zur Übersicht.

## 6. Inbox

Vier Anzeigen als Chips mit Zählwerten:

- **Wartet auf dich** (Standard): Fragen, Blocker, Vorschläge und Tasks von
  Agenten — offen. Nur das ist handlungspflichtig.
- **Blocker / Vorschläge**: Schnellzugriff auf die Teilmengen.
- **Log**: alles Informative (Ergebnisse, Infos, Memory, protokollierte
  Entscheidungen, eigene Notizen) — lesen, nicht abarbeiten.

Rechts daneben: **Später** (zurückgestellt) und **Erledigt** (Nachschau).

**Jede Karte trägt:** ihr Referenz-Token `projekt #Nr` (stabil zitierbar,
z. B. „schau dir cockpit #14 an"), Titel, Uhrzeit und relatives Alter. Ein
Status-Chip erscheint nur, wenn er etwas sagt („in Arbeit", „später", …);
BLOCKER stehen immer als Text mit rotem Streifen. Wenn fast alles „dringend"
wäre, blendet Cockpit die dringend-Chips aus und sagt das dazu.

**Antworten:** Karte aufklappen → die KI-Einordnung erklärt das Item und
schlägt Antwort-Buttons vor → Antwortfeld füllen → „Speichern & zustellen".
Die Karte verlässt die Inbox, eine Echo-Zeile bestätigt den Verbleib, und die
Antwort geht an die nächste Session des Projekts. Enthält der Kartentext
Zeilen wie `( ) Option A` oder `[ ] Baustein B`, sind sie klickbar:
`( )` wählt genau eine, `[ ]` beliebig viele — der Klick füllt nur das
Antwortfeld, gesendet wird erst durch dich.

Dazu: Sofort-**Suche** (auch nach `#Nr`), **Sortierung** (Neueste zuerst als
Standard, Dringlichkeit, Älteste, Nummer), **erledigt/später** mit
5-Sekunden-Undo, und komplette **Tastatur**-Bedienung (j/k blättern, o öffnen,
r antworten, Strg+Enter speichern, e erledigt, p später, u rückgängig).

**Direktlinks:** Agenten schreiben dir klickbare Links wie
`…/spa/inbox?item=i-…` in den Chat. Der Link öffnet genau diese Karte
aufgeklappt — egal in welcher Auswahl oder Anzeige sie wohnt.

## 7. Entscheidungen

Alle beantworteten Fragen und protokollierten Entscheidungen, neueste zuerst,
mit Datum, Projekt, Code-Anker und Commit. „Volle Kette" blendet auch ersetzte
und verworfene Entscheidungen ein („ersetzt durch …").

## 8. Suche

Volltext über die gesamte Session-Historie (BM25-gerankt, tippfehler- und
umlaut-tolerant). Filter nach Projekt und Rolle.

## 9. Report

Dein Tagebuch: pro Tag eine Spalte mit Sessions (Thema = erster Auftrag),
Entscheidungen (grün) und neuen Karten — horizontal über die Zeit scrollbar.
**Klick auf einen Session-Block öffnet das Gespräch im Verlauf.**

## 10. Verlauf

Alle erfassten Sessions (Projekt, Zeitspanne, Anzahl Wortmeldungen, erster
Auftrag als Thema), sortierbar nach Zeit oder Projekt. Klick öffnet das
Gespräch chronologisch zum Nachlesen — links markiert, wer spricht (Du /
Claude / Subagent). **Dateipfade im Text sind klickbar und öffnen die Datei
direkt in VS Code.** Sehr lange Wortmeldungen sind fürs Lesen gekürzt; den
Volltext findet die Suche.

## 11. Gedächtnis & Regeln

Je Projekt die CLAUDE.md (die Dauer-Anweisungen für Claude) mit
Zeichen-Budget-Balken und den ungesicherten Änderungen seit dem letzten
Commit. Anthropic nennt keine harte Grenze — Richtwert hier: 10.000 Zeichen,
weil die Datei bei jedem Prompt komplett in den Kontext wandert. Klickbare
Dateipfade aus Karten landen im eingebauten Viewer (mit Zeilennummern);
Secrets und fremde Pfade sind gesperrt.

## 12. Einstellungen (Zahnrad)

Theme (System/Hell/Dunkel) und **Expertenlevel** (Vibecoder / Fortgeschritten /
Experte) — das Level bestimmt die Tonlage aller KI-Antworten.

## 13. Kommandozeile (Kurzreferenz)

| Befehl | Zweck |
|---|---|
| `cockpit init` / `uninstall` | Ein-/Ausrichten (Diff, Backup, byte-genaue Wiederherstellung) |
| `cockpit doctor` | Installations-Checks mit Fix-Befehlen |
| `cockpit backfill [--dry-run]` | Historie importieren (idempotent) |
| `cockpit search <begriffe>` | Volltextsuche (`--items` für die Inbox) |
| `cockpit inbox` / `add` / `answer` / `done` | Inbox ohne Browser |
| `cockpit status` | Portfolio-Überblick im Terminal |
| `cockpit standup [--since 1d]` | KI-Standup über alle Projekte |
| `cockpit decisions` | Entscheidungs-Log im Terminal |
| `cockpit stats` | Lokale Nutzungsmetriken |
| `cockpit purge [--project X] --yes` | Daten löschen |
| `cockpit web [--port]` | Oberfläche starten |

## 14. Git-Modi (je Projekt)

Der Git-Tab zeigt den Stand aller erfassten Repos. Wie laut Cockpit dabei
mahnt, stellst du je Projekt in **Einstellungen → Projekte** über den
Git-Schalter ein (Standard: **beratend** — wie bisher):

- **manuell** — nur anzeigen: Branch, ungesicherte Dateien und Commits bleiben
  sichtbar, aber keine Empfehlungen in Übersicht, Git-Tab oder Session-Prompt.
- **beratend** — zusätzlich Empfehlungen (Commit fällig, n nicht gepusht) in der
  Übersicht, im Git-Tab und als Regel im Session-Prompt.
- **auto** — zusätzlich ein **Sicherungs-Snapshot nach jeder Session**.

**auto-Leitplanken:** Der Snapshot legt einen Commit unter einem eigenen Ref
(`refs/cockpit/wip-<Datum-Zeit>`) ab — er berührt **nie** deinen Branch, HEAD,
Index oder Worktree, pusht nie und benutzt nie `--force`. Aufbewahrt werden die
letzten 20 Snapshots je Repo. `git branch` bleibt sauber (kein Branch-Namespace).

**Roh-Stand-Hinweis:** Ein Snapshot enthält den **ungeschwärzten** Arbeitsstand
(es ist git, nicht die Cockpit-Datenbank — die Redaction greift nur beim
Erfassen in die DB). Wer Secrets im Worktree hat, sichert sie damit mit.

**Wiederherstellen:** Snapshots findest du über den Git-Tab oder
`git for-each-ref refs/cockpit/`. Einen Stand ansehen bzw. zurückholen:

```
git log refs/cockpit/wip-<Datum-Zeit>     # was steckt drin
git cherry-pick <sha>                      # den Snapshot-Commit übernehmen
```

## 15. Woher weiß ich, dass meine Antwort ankommt?

Wenn du eine Karte beantwortest („Zustellen"), geht die Antwort **automatisch**
an die nächste Claude-Session dieses Projekts — auf einem von drei Wegen:

- **beim Session-Start:** die nächste startende Session bekommt sie im Briefing.
- **in eine laufende Session:** tippst du dort etwas, wird sie mit eingespielt.
- **vom Agenten abgeholt:** wartet der Agent aktiv (MCP `pickup_answers`).

**Quittung auf der Karte:** Jede beantwortete Karte (Inbox und Entscheidungs-
Log) zeigt darunter den Zustellzustand — „Wartet auf Abholung · seit …" bzw.
„Zugestellt · … · <Weg>" mit einem Link auf die Session im Verlauf. Bleibt eine
Antwort über 2 h liegen, erinnert die Übersicht daran; nach 24 h bietet die
Karte einen **Kopier-Knopf** als Fallback (Antwort ins CLI-Fenster einfügen).

**Läuft die Kette überhaupt?** In den Einstellungen beweist **„Zustellung
testen"** die Kette Hook → Abholung → Injektion auf deiner Maschine — isoliert
gegen eine Wegwerf-Datenbank, ohne echte Daten anzufassen. Rot mit Klartext-
Grund heißt meist: `cockpit init` neu ausführen (Hook-Bundle veraltet).
`cockpit doctor` führt denselben Test als Check „Zustell-Kette end-to-end".

## 16. Wenn etwas klemmt

1. `cockpit doctor` — nennt zu jedem Problem den Fix.
2. **KI-Boxen zeigen Fehler/Timeout:** das `claude`-Kommando ist nicht
   erreichbar (nicht installiert, nicht eingeloggt oder Session-Limit). Alles
   andere funktioniert weiter; die Boxen erholen sich von selbst.
3. **Keine neuen Sessions im Verlauf / Antworten kommen nicht an:** Hooks
   prüfen — steht `disableAllHooks: true` in `~/.claude/settings.json`? Läuft
   die Session in einem Projekt mit `.cockpit/no-capture`?
4. **Port 7878 belegt:** `cockpit web --port 7979` oder den Altprozess beenden.
5. Antworten werden **einmal** zugestellt — an die nächste startende Session
   des Projekts. Eine bereits laufende Session holt sie sich über das
   MCP-Tool `list_items`.
