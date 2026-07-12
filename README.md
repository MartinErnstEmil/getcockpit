# Cockpit

**Der Projektstand, der sich selbst schreibt.** Cockpit zeigt dir auf einen Blick, was in all deinen Claude-Code-Projekten läuft, was entschieden wurde und wer auf dich wartet — automatisch, ohne dass du etwas pflegen musst. Beim ersten Start liest es deine gesamte vorhandene Claude-Historie ein: jede Session, die du je gefahren hast, in Sekunden volltextdurchsuchbar. Lokal, rückwirkend ab Minute 1, ohne Cloud.

npm-Paket & Repo: `getcockpit` (Produkt und CLI-Befehl heißen `cockpit`; der Basisname „cockpit" ist als Projektname belegt, daher der Distributionsname „getcockpit"). Repository: https://github.com/MartinErnstEmil/getcockpit

## Quickstart

```powershell
npm install && npm run build   # im Repo (npm-Publish folgt)
node dist/cli.js init          # Hooks + MCP einrichten (zeigt Diff, fragt nach)
node dist/cli.js backfill --dry-run   # Redaction-Report sichten
node dist/cli.js backfill      # gesamte Historie importieren
node dist/cli.js search "warum haben wir X entschieden"
```

Deinstallation in einem Befehl: `node dist/cli.js uninstall` (entfernt nur Cockpit-Einträge aus settings.json; die Datenbank bleibt, bis du `purge` aufrufst).

## Was heute funktioniert

- **Backfill:** `cockpit backfill` importiert die vorhandene Historie aus `~/.claude/projects/**/*.jsonl` — streaming, idempotent (Wiederholungslauf erzeugt null Duplikate), mit Abschlussreport (Dateien, Turns, Skips, Redactions, Dauer). Der Dry-Run zählt Redactions identisch zum Echtlauf. Optionen: `--dry-run`, `--limit <n>`, `--project <pfad>`, `--projects-dir <pfad>`.
- **Suche:** `cockpit search <begriffe…>` — BM25-gerankt, implizites AND über mehrere Terme, diakritika-tolerant (findet „Begründung" auch bei „Begrundung"). Filter: `--project`, `--since`, `--role`; `--items` durchsucht stattdessen die Inbox. Gemessene P95-Latenz: unter 1 ms bei 10 importierten Echt-Transcripts.
- **MCP-Server:** `cockpit-mcp` (stdio) stellt 7 Tools bereit: `add_item`, `list_items`, `update_item`, `answer_question`, `pickup_answers`, `search_decisions`, `recent_turns`. Keine Datei-Schreib-Tools. Projekt-Scoping: ohne `projectPath` gilt das aktuelle Projekt, `projectPath: ""` sucht global. „Aktuelles Projekt" heißt dabei: das Arbeitsverzeichnis des MCP-Server-Prozesses. Claude Code startet den Server im Projektordner, dann stimmt das automatisch — läuft der Server aber mit anderem Arbeitsverzeichnis (z. B. global registriert oder aus einem Unterordner gestartet), landen Items im falschen Projekt. In dem Fall `projectPath` explizit mitgeben.
- **Inbox:** `cockpit add <titel>` (`--type`, `--body`, `--priority`, `--tags`), `cockpit inbox` (`--status`, `--type`, `--project`, `--all`), `cockpit answer <id> <antwort…>`, `cockpit done <id>`. Item-Ids dürfen als eindeutiger Präfix angegeben werden.
- **Capture-Hooks:** Nach `cockpit init` erfassen zwei Hooks laufende Sessions direkt in SQLite (kein Server): der Stop-Hook liest die letzten 256 KB des Transcripts und übernimmt alle Turns mit ihren echten Transcript-uuids — Live-Capture und Backfill sind derselbe idempotente Pfad. Exit-Code immer 0; Opt-out pro Projekt via Datei `.cockpit/no-capture` (`.cola/no-capture` wird weiter respektiert).
- **SessionStart-Briefing:** Beim Start einer Session (startup/resume, nicht clear/compact) werden offene und frisch von Menschen beantwortete Inbox-Items des Projekts als Kontext injiziert — max. 10 Items / 2.000 Zeichen, genau einmal pro Session, in einem Untrusted-Daten-Wrapper. Abschaltbar mit `COCKPIT_NO_BRIEFING=1`. Von Claude selbst beantwortete Items werden nie zugestellt.
- **Lifecycle:** `cockpit init` (Diff-Anzeige + Backup vor jeder settings.json-Änderung, fremde Hooks bleiben unangetastet), `cockpit doctor` (5 Checks mit Fix-Befehl), `cockpit uninstall` (entfernt nur Cockpit-Einträge, DB bleibt), `cockpit purge [--project] --yes`, `cockpit stats` (lokale Metriken, kein Phone-Home).
- **Web-UI:** `cockpit web` startet die lokale Oberfläche auf `http://cockpit.localhost:7878` (bzw. `http://127.0.0.1:7878`; `*.localhost` zeigt ohne Einrichtung auf Loopback — Loopback-Token-URL, hart auf 127.0.0.1 gebunden, Host-/Origin-Allowlist, kein CORS). Enthalten:
  - **Übersicht** — sechs klickbare Kacheln + „Jetzt dran" + Projektkarten (Kachelzahl == Zielansicht, immer).
  - **Briefing je Projekt** — deterministischer Stand sofort (Aktivität, Git, offene Fragen, Entscheidungen), KI-Zusammenfassung mit bewerteten nächsten Schritten auf Knopfdruck, „Für Session kopieren" für die Übergabe an ein CLI-Fenster.
  - **Inbox mit Anzeigen** — Default zeigt nur Handlungspflichtiges (Frage/Blocker/Vorschlag/Task von Agenten), Log-Tab für den Rest; Suche, Sortierung, klickbare Antwort-Optionen (`( )`/`[ ]` im Item-Text), 5-s-Undo, komplette Tastatur-Bedienung, Deep-Links `?item=` öffnen die Karte direkt.
  - **Entscheidungen** mit Supersede-Kette, **Volltext-Suche**, **Report** (Tagebuch mit Tagesspalten), **Verlauf** (Sessions nachlesen, Dateipfade öffnen in VS Code), **Gedächtnis & Regeln** (CLAUDE.md mit Budget + Git-Diff), **Einstellungen** (Sprache Englisch/Deutsch/Französisch, Theme, Expertenlevel für die KI-Tonlage).
  - **Git-Tab + Git-Modi je Projekt** — Stand aller Repos (Branch, ungesicherte Dateien, Commits, Vorsprung/Rückstand live). Der Modus (in Einstellungen → Projekte) steuert die Lautstärke: **manuell** (nur anzeigen), **beratend** (Empfehlungen in Übersicht + Session-Prompt, Standard), **auto** (zusätzlich ein Sicherungs-Snapshot nach jeder Session unter `refs/cockpit/` — nie dein Branch, nie ein Push).
  - **Sprache:** Die Oberfläche lässt sich in den Einstellungen auf Englisch (Default), Deutsch oder Französisch stellen; die KI-Assists antworten in der gewählten Sprache. Weitere Sprachen, die Claude beherrscht, sind als Wörterbücher nachrüstbar.
- **KI-Funktionen** (Karten-Einordnung, Briefing, Standup) rufen das lokale `claude`-Binary auf (Modell: Haiku, ohne Werkzeuge, Prompt-Injection-gehärtet, strenge Quellenpflicht). Ist es nicht erreichbar, degradiert alles sauber auf deterministische Anzeigen — nichts hängt davon ab.

Anwender-Doku: [docs/HANDBUCH.md](docs/HANDBUCH.md) · Installation: [docs/INSTALL.md](docs/INSTALL.md) · Abnahme: [docs/TESTPROTOKOLL.md](docs/TESTPROTOKOLL.md)

## Sicherheit

- **Redaction am Ingest (best-effort):** API-Keys (`sk-…`), GitHub-Tokens, AWS-Keys, JWTs, PEM-Private-Keys, Bearer-Tokens und Hochentropie-Tokens werden vor dem Persistieren durch `[REDACTED:<typ>]` ersetzt. Muster- und Entropie-Erkennung fängt die gängigen Formate; ein untypisch geformtes Secret kann durchrutschen — die Datenbank bleibt deshalb lokal und restriktiv berechtigt.
- Datenbank: `~/.cockpit/cockpit.db` (Override: Umgebungsvariable `COCKPIT_DB`). Das Verzeichnis wird mit restriktiven Rechten angelegt (POSIX 700 bzw. Windows-ACL nur für den aktuellen User).

## Was auf deiner Maschine läuft

Ausschließlich lokale Prozesse: eine SQLite-Datenbank mit FTS5-Volltextindex. Kein Server, keine Cloud, kein Phone-Home, keine Embeddings.

## Entwicklung

- Build: `npm run build` · Tests: `npm test` (Integrationstests gegen echte Temp-Datenbanken) · Typecheck: `npm run typecheck`
- Node ≥ 22.5 erforderlich.

## Lizenz

**PolyForm Noncommercial 1.0.0** ([LICENSE](LICENSE)) — Lizenzgeber: thinkinvoice. In Klartext:

| Deine Situation | Was gilt |
|---|---|
| Hobby, Lernen, Forschung, Evaluation | **Kostenlos** |
| Freiberufler mit bezahlter Kundenarbeit | **Kommerzielle Lizenz** — 1. Monat frei, dann 8,90 $/Monat bzw. 89 $/Jahr netto pro Anthropic-Seat |
| Firma (egal welcher Größe) | **Kommerzielle Lizenz** — gleiche Konditionen, Kontakt: license@thinkinvoice.com |

Details und Bestellweg: [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md). Deine archivierten Sessions gehören selbstverständlich dir — Cockpit telefoniert nie nach Hause.
