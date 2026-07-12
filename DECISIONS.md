# DECISIONS — Abweichungen und Konkretisierungen während des Laufs

## D1: Hash-Identitäts-Prüfung der Alt-DB ist nicht wörtlich erfüllbar
Die Alt-cola-Hooks sind auf dieser Maschine AKTIV und schreiben während des Laufs in `~/.cola/cola.db` (sie erfassen sogar diese Session). Red-Team-Bedingung 1 wird daher so erfüllt: cola2 öffnet die Datei nie (nur Kopie in %TEMP%), und das Backup `cola.db.pre-rewrite-backup` mit Hash dokumentiert den Vorher-Stand. Morgens wird geprüft, dass cola2 keinen Schreibzugriff hatte (Backup vorhanden, kein cola2-Code referenziert den Pfad schreibend), nicht Byte-Identität.

## D3: `backfill --project` schreibt kein Resume-Bookkeeping
Eine mit Projektfilter teilimportierte Datei dürfte sonst beim nächsten Volllauf als "unverändert importiert" gelten und würde übersprungen; uuid-Dedupe macht den späteren Voll-Import trotzdem idempotent. PRD F1 lässt das Detail offen — einfachste korrekte Variante gewählt.

## D4: UserPromptSubmit schreibt Events, keine Turns; Turn-Capture macht der Stop-Hook
Der UserPromptSubmit-Payload trägt keine Transcript-uuid (die Zeile existiert beim Feuern noch nicht); jede synthetische uuid bräche ADR-005 und erzeugte beim Backfill garantierte Duplikate. Daher: UserPromptSubmit loggt den (redacted) Prompt ins Events-Log (Crash-Sicherung + Capture-Quote), der Stop-Hook liest den 256-KB-Transcript-Tail und schreibt ALLE dort gefundenen User-/Assistant-Turns mit echten uuids — INSERT OR IGNORE macht Live-Capture, Re-Capture und Backfill zum selben idempotenten Codepfad.

## D5: `cola2 init` führt `claude mcp add-json` nur auf der echten settings.json aus
Wird `--settings <pfad>` übergeben (Test-/Fixture-Betrieb), unterbleibt jeder claude-Spawn automatisch; zusätzlich existiert `--no-mcp`. Damit kann kein Test versehentlich live registrieren (Selbstschutz-Verbot), das Produkt erfüllt F8 aber vollständig.

## D6: Alt-DB enthält 64 Items (PRD F9 nannte 58)
Die Alt-Hooks laufen weiter und es kamen Items hinzu; das Akzeptanzkriterium "58/58" wird als "alle/alle" umgesetzt: Import asserted Quellzählung == Zielzählung und >= 58. reactions/escalated_*/order_index/depends_on werden bewusst nicht übernommen (ADR-004); answer ist in allen 64 Fällen ein Klartext-String.

## D2: Treiber-Split — better-sqlite3 für CLI/MCP, node:sqlite für das Hook-Bundle
Konkretisiert ADR-003/006: Ein per esbuild gebündeltes Hook-CJS kann kein natives Modul enthalten. Das Hook-Bundle nutzt daher node:sqlite (Node >= 22.5, auf der Maschine v22.17 mit FTS5 verifiziert) und bleibt zero-dependency und nach `~/.cola2/bin/` kopierbar; CLI/MCP nutzen better-sqlite3. Beide teilen Dateiformat und Schema (WAL ist Build-übergreifend kompatibel). Konsequenz: engines `>=22.5`; `cola2 doctor` prüft die Node-Version. Hook-Aufruf in settings-Snippets mit `--no-warnings` (node:sqlite ist experimental und würde sonst stderr verschmutzen).

## D7: Redaction-Pflicht gilt nicht fuer Event-Payloads (Such-Query)
Code-Review 2026-06-12 fand, dass `cola2 search` die rohe Query in events.payload_json persistiert (recordEvent redigiert nicht). Entscheid des Menschen: Die Invariante "Redaction vor JEDEM Persistieren" ist fuer diesen Pfad void — Such-Queries sind kein Capture-Inhalt, der Befund wird nicht gefixt. Turns und Item-Texte (Titel/Body/Antwort) bleiben uneingeschraenkt redaction-pflichtig.

## D8: Kein get_item-MCP-Tool — postponed bis zum ersten echten Bedarf
Nutzungsanalyse der Alt-DB (events, 22.05.–11.06., 89 mcp_tool_call): list_items 49, add_item 30, update_item 7, recent_turns 3, **get_item 0** — trotz drei Wochen Verfügbarkeit. Struktureller Grund: list_items liefert vollständige Items (Body/Antwort/Tags/Anchor), es gibt keine Informationslücke. Entscheid: nicht bauen (YAGNI); Wiedervorlage erst, wenn eine Session real daran scheitert, eine Item-Id aufzulösen (dann ~10 Zeilen, store.getItem existiert).


## D9: Config-Composer entfroren — als "Baukasten" nach cockpit portiert (PO 10.07.)
KONZEPT.md:90 und PRD.md:31 (enhance_claude) fuehrten den Config-Composer als Nicht-Ziel ("eingefroren"). Der PO hat das am 10.07. abends revidiert (Cockpit-Decision i-f43a437fd7). Begruendung: cockpit hat bereits Budget-Anzeige + Git-Diff je CLAUDE.md (/files), aber keine Antwort auf "Config ist voll -> und jetzt?". Der cola-V2-Composer ist fertig gebaut und Eigenbesitz (dev/cola, vision/15-composer-spec.md; Merger, In-place-Section-Merge, Konflikt-Erkennung, Snippet-Katalog, Tests) und wird wiederverwendet statt neu gebaut. Alleinstellung im cockpit: budget-bewusstes Apply (Preview zeigt Zeichen-Kosten VOR dem Schreiben). Umsetzung: Paket U6 der GOAL-PROMPT-UX3.md. Relizenzierung des portierten Codes auf PolyForm-NC (SPDX-Header), license_source-Attributionen der Snippets uebernommen. Nicht in V1: LLM-Suggest, zentraler Snippet-Server, Marketplace, Custom-Snippet-Editor.


## D10: Git-Modi je Projekt — Default advisory, auto nur Snapshot-Refs, nie Push (PO-Proposal i-c21aef276d)
Der Git-Assist war global gleich laut. Neuer Modus `git_mode` je Projekt (Migration v4, project_settings): **manual** (nur anzeigen), **advisory** (Empfehlungen in Übersicht + Session-Prompt) und **auto** (zusätzlich Sicherungs-Snapshot nach jeder Session). Default ist **advisory** — Bestandsprojekte verhalten sich nach der Migration exakt wie vorher (das heutige globale Verhalten). Leitplanken für auto (aus dem PO-Proposal, Abweichung nur mit neuem PO-Entscheid): Snapshots leben unter `refs/cockpit/wip-<YYYYMMDD-HHmm>` (kein Branch-Namespace, `git branch` bleibt sauber), Aufbewahrung 20 Refs; der Stop-Hook committet NIE auf den Arbeitsbranch, bewegt NIE HEAD/Index/Worktree, pusht NIE, benutzt NIE force. Technik: temporärer Index (GIT_INDEX_FILE) -> read-tree/add/write-tree/commit-tree/update-ref; Dedupe gegen den HEAD-Tree; fail-open (jeder Fehler -> hooks.log, nie eine Exception). Snapshots enthalten den ROHEN Arbeitsstand (keine Cockpit-Redaction — es ist git, nicht die DB). Umsetzung: Pakete G1–G5 der GOAL-PROMPT-GIT-MODES.md.


## D11: Zustell-Transparenz — Protokoll statt Semantik-Änderung; Modell-Ack außer Scope (Proposal i-dba353c076)
Die Zustellung menschlicher Antworten (delivered_at, atomarer Claim) funktionierte, war aber UNSICHTBAR: niemand protokollierte, WER wann worüber abgeholt hat (Befund F1). Entscheid: NUR Protokoll + Anzeige ergänzen, die eingefrorene Zustell-Semantik (SQL_CLAIM_ANSWERS, delivered_at genau einmal, K1-Härtung) NICHT anfassen — keine Migration (der Zustand lebt in delivered_at + Events). Neues Event `answer_delivered {itemId, via}` (via = briefing|prompt|mcp) an allen drei Claim-Stellen; ein Event je Item, bei Mehrfach (Parallel-Kante) gewinnt das älteste. Karten zeigen Wartet/Zugestellt-Quittung, Übersicht erinnert ab 2 h, Aging ab 24 h. Selbsttest (`src/selftest.ts`, doctor + Settings) beweist die Kette Hook->Claim->Injektion isoliert gegen eine Temp-DB. Schwellen (2 h/24 h) und Weg-Labels sind entschiedene Defaults. Modell-Ack (Injektion != tatsächliche Verarbeitung durch das Modell, Befund F4) BEWUSST außer Scope — nicht verlässlich ohne Modell-Kooperation feststellbar. Abweichung: Übersichts-CTA führt in den Entscheidungs-Log statt in die Inbox (die Inbox lädt nur Offenes; Cockpit-Proposal i-e8b4048e93). Umsetzung: Pakete Z1–Z4 der GOAL-PROMPT-ZUSTELLUNG.md.
