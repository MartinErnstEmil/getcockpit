# ADR — Architekturentscheidungen cola2

Stand: 2026-06-11. Status aller Einträge: akzeptiert (sofern nicht anders markiert). Kontext-Quellen: cola-analyse.md §11, Koryphäen-Reviews 2026-06-11. Jede Abweichung hiervon während des Builds braucht einen DECISIONS.md-Eintrag mit Ein-Satz-Begründung (Second-System-Bremse).

## ADR-001: Rewrite als rückrollbares Experiment, nicht als Ersatz
Der Ground-up-Rebuild findet statt (Maintainer-Entscheidung gegen Red-Team-Empfehlung "Alt-Repo härten"), aber unter den fünf Red-Team-Bedingungen: (1) Alt-System bleibt vollständig intakt — `dev/cola` unangetastet, `~/.cola/cola.db` wird nie geöffnet außer read-only-Kopie für Migration, Hash vor/nach der Nacht identisch; (2) Item-Migration ist Pflicht-Scope; (3) Nacht-Ergebnis heißt Release-Kandidat, "production" entscheidet der Morgen-Gauntlet durch den Menschen; (4) Budget-Deckel Nacht + 4 h Fixes, sonst Rückkehr zum Konsens-Plan; (5) Re-Evaluations-Uhr (vision/17 §10.6) läuft weiter.

## ADR-002: Ein npm-Paket, kein Monorepo
TypeScript, ESM, vitest. Ein Paket mit `bin: cola2` und Subcommands; MCP-Server und Hook-Skripte sind Build-Artefakte desselben Pakets. Begründung: Das 7-Pakete-Monorepo des Vorgängers war Organisations-Overhead ohne Nutzer; Workspaces sind eine bekannte npm-publish-Fehlerquelle. Arbeitsname `cola2` (npm-Name `cola` ist vergeben; finaler Name = Human-Gate, Rename ist trivial).

## ADR-003: Storage better-sqlite3, Fallback node:sqlite — entschieden in M0
Primär better-sqlite3 (Version mit win32-Prebuild für die laufende Node-ABI pinnen). Dünnes Treiber-Interface, sodass `node:sqlite` (Node ≥ 22, FTS5+bm25 auf der Referenzmaschine verifiziert) als Notausgang existiert — der Wechsel wird in M0 entschieden, nicht um 3 Uhr nachts. Pragmas bei jedem Open: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.

## ADR-004: Schema-Grundsätze
- Basistabellen mit explizitem `id INTEGER PRIMARY KEY` (VACUUM-sicher für FTS-`content_rowid`) plus `uuid TEXT UNIQUE NOT NULL`.
- Turns: uuid = Transcript-uuid; `session_id`, `project_path` (normalisiert), `role`, `content`, `timestamp` (Transcript-Zeit, nicht Wall-Clock), `is_sidechain`, `git_branch`.
- FTS5 external content auf Turns UND Items mit allen DREI Triggern (AFTER INSERT/DELETE/UPDATE) — der fehlende UPDATE-Trigger ist der dokumentierte Korruptionsbug des Vorgängers. Nach Backfill `INSERT INTO fts(fts) VALUES('optimize')`.
- Tokenizer `unicode61 remove_diacritics 2` (deutsch-robuste Suche schlägt englisches Porter-Stemming), `tokenchars '_'`.
- Migrationen über `PRAGMA user_version` mit nummerierten, transaktionalen Skripten — kein `CREATE IF NOT EXISTS`-Probing.
- Events-Tabelle bewusst dumm (free-string event_type, payload JSON) — vom Vorgänger übernehmen.
- Items-Datenmodell konzeptionell aus `schema.ts` des Alt-Repos (Typen, Anchor, Git-SHA, parentId, Tags); NICHT übernehmen: escalated_*, order_index, Composer-/Statement-/Augment-Tabellen.

## ADR-005: Ein Dedupe-Schlüssel für Live-Capture und Backfill
Dedupe ausschließlich über die Transcript-`uuid` (`INSERT OR IGNORE`). Der Stop-Hook liest die uuid aus dem Transcript statt Turns selbst zu zählen. Live-Capture, Backfill und Re-Backfill sind damit derselbe idempotente Codepfad. (Vorgänger-Fehler: selbstgezählte turn_number + Zufalls-IDs → garantierte Duplikate.)

## ADR-006: Hooks schreiben direkt in SQLite; In-Process-Dispatch
Kein HTTP-Pfad, kein Server als Voraussetzung (Vorgänger-Fehler: "Determinismus nur bei laufendem Web-Server"). Ein einziger Node-Prozess pro Hook-Event lädt die cola2-Module in-process (try/catch-Isolation pro Modul, Rückgaben als Objekte gemergt, `additionalContext` konkateniert) — kein spawnSync pro Subskript (gemessen ~110 ms Node-Cold-Start pro Spawn auf der Referenzmaschine). Exit immer 0. Dead-Letter-JSONL nur bei DB-Fehler. Hook-Einstiegsskript wird als dependency-gebündeltes CJS nach `~/.cola2/bin/` kopiert; settings.json zeigt nie in `node_modules`.

## ADR-007: Projektpfad aus Transcript-`cwd`, nie aus Verzeichnisnamen
Jede Transcript-Zeile trägt `cwd` im Klartext. Die Verzeichnisnamen-Dekodierung (`C--Users-...`) ist prinzipiell lossy und war im Vorgänger auf Laufwerk C: hartkodiert. `normalizeProjectPath`-Semantik aus `resolve-store.ts` portieren.

## ADR-008: Redaction am Ingest, Permissions, Voll-Backfill nur mit Mensch
Secret-Redaction (Pattern-Liste siehe PRD F4) läuft in Capture UND Backfill, vor dem Persistieren; Rohdaten landen nie in der DB. `~/.cola2/` 700 / DB 600 bzw. Windows-ACL auf den aktuellen User beim Anlegen. Der Voll-Backfill der echten 440 MB ist Opt-in nach Redaction-Report — nachts laufen nur Fixtures und kopierte Stichproben in %TEMP%. Verschlüsselung-at-rest, ML-Secret-Detection, Rate-Limiting: bewusst NICHT V1.

## ADR-009: SessionStart-Briefing ist der einzige Injektionspfad
Kein Recall in den Prompt-Pfad (UserPromptSubmit injiziert nichts) — Begründung: 14-Decision-Korpus liefert deterministischen Müll, Autoritätsproblem, Echo-Schleife; vision/17 hatte eingreifende Pfade vor Messdaten einstimmig abgelehnt. Briefing-Regeln: nur menschlich beantwortete Items, Caps (10 Items / 2.000 Zeichen), einmal pro session_id (Events-Dedupe), Untrusted-Wrapper, Echo-Marker im Capture gestrippt, Off-Switch, nicht bei clear/compact.

## ADR-010: Keine Web-UI im Kern; Stretch nur ohne Build-Kette
V1 ist Terminal-first (der Aha-Moment braucht keinen Browser; die Alt-UI bediente das nachweislich verweigerte Triage-Verhalten). Stretch M6, nur bei Zeitüberschuss: ein Node-`http`-Server + EINE statische HTML-Seite (Vanilla JS, kein React/Vite), Port 7878 (7777 ist vom Alt-System belegt), Hard-Bind 127.0.0.1, Origin- und Host-Header-Allowlist auf allen state-changing Routes, Loopback-Token beim Start generiert und im URL übergeben, `Content-Type: application/json` erzwungen, kein CORS-Wildcard.

## ADR-011: MCP-Server mit 6 Tools, ohne Datei-Schreibfläche
`add_item`, `list_items`, `update_item`, `answer_question`, `search_decisions`, `recent_turns`. Keine Config-Schreib-Tools in V1 → keine Allowlist-Angriffsfläche. Tool-Schemas konzeptionell vom Alt-`mcp-server` übernehmen.

## ADR-012: Lizenz AGPL-3.0 + Commercial-Dual
Maintainer-Entscheidung (gegen Produkt-Empfehlung MIT; Konsequenzen im PRD benannt). Umsetzung: AGPL-3.0-Volltext als `LICENSE`; `LICENSE-COMMERCIAL.md` mit Dual-Erklärung + Kontakt-Platzhalter; `package.json` `"license": "AGPL-3.0-only"`; SPDX-Header `// SPDX-License-Identifier: AGPL-3.0-only` in jeder Quelldatei. Portierte Konzepte/Module aus dev/cola tragen Herkunftsvermerk ("ursprünglich MIT, (c) 2026, relizenziert durch denselben Rechteinhaber"). `NOTICE` nennt das MIT-Vorgängerrepo. Human-Gates: license@-Adresse, Copyright-Inhaber-Klarname, CLA-vs-DCO (ohne CLA stirbt die Commercial-Hälfte beim ersten Fremd-Merge). README-FAQ: 3 Sätze, was AGPL für den Nutzer NICHT bedeutet.

## ADR-013: Eigene Wohnung — vollständige Trennung vom Alt-System
DB `~/.cola2/cola2.db` (Override `COLA2_DB`), Hooks-Log `~/.cola2/hooks.log`, Port 7878. Niemals öffnen/schreiben: `~/.cola/`, `~/.claude/settings.json`, Port 7777. `cola2 import-legacy` arbeitet ausschließlich gegen eine Kopie der Alt-DB.

## ADR-014: Gestrichen mit Begründung
- **Routing-Guard (auch observe):** Maintainer-Forschung im Nutzer-Produkt; kostet jeden Nutzer einen Stop-Hook und Vertrauen. Nicht im Paket.
- **Composer:** eingefroren seit vision/16; verwässert die Story.
- **Memory-Items/MEMORY.md-Pipeline:** Rennen gegen Anthropic-Bordmittel, bereits verloren.
- **Embeddings:** BM25 reicht für "Was war der Beschluss zu X?"; erklärbar und wartungsfrei.
- **Telemetrie/Phone-Home:** Local-First-Versprechen; Metriken nur lokal via `cola2 stats`.
