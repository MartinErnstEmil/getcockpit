# Cockpit — Testprotokoll (Volltest)

Stand: 2026-07-09. Jeder Fall: Schritte ausführen, Ergebnis gegen „Erwartet"
prüfen, PASS/FAIL + Beleg notieren. Grundlage für die Tester-Abnahme und für
jede Regressionsrunde vor einem Release.

**Regeln für den Tester:**
- Basis-URL: `http://127.0.0.1:7878` (Token beim ersten Aufruf in der URL).
- Datenändernde Fälle NUR mit eigens angelegten Test-Items (Titel-Präfix
  `[TEST]`), danach auf erledigt setzen.
- Fälle mit ⚠ NIE auf einer Produktivmaschine ausführen (init/uninstall/purge
  verändern settings.json bzw. löschen Daten) — sie sind durch die
  automatisierte Suite abgedeckt (`npm test`, test/lifecycle.test.ts).
- KI-Fälle setzen ein erreichbares `claude`-Binary voraus; ohne das ist das
  SOLL die saubere Degradation (Fehlerbox bzw. Rohbericht), nie ein Absturz.

## A. Installation & Lifecycle (CLI)

| Nr | Fall | Schritte | Erwartet |
|----|------|----------|----------|
| A1 ⚠ | init | `cockpit init` (frische Maschine/VM) | Hook-Bundle installiert, settings.json-Diff angezeigt + Rückfrage, Backup angelegt, MCP registriert (oder manueller Befehl genannt), „Nächste Schritte" gedruckt |
| A2 | doctor | `node dist/cli.js doctor` | 5 Checks, alle OK auf eingerichteter Maschine; bei Fehlern konkreter Fix-Befehl |
| A3 | backfill dry-run | `node dist/cli.js backfill --dry-run --limit 20` | Report mit Dateien/Turns/Skips/Redactions; zählt Redactions wie der Echtlauf; DB unverändert |
| A4 | backfill idempotent | `backfill --limit 20` zweimal | Zweiter Lauf erzeugt 0 neue Turns |
| A5 | stats | `node dist/cli.js stats` | Turns/Projekte/Sessions, Items nach Status, Events nach Typ |
| A6 ⚠ | uninstall | `cockpit uninstall` (VM) | Nur cockpit-Einträge entfernt, byte-Vergleich mit Backup, DB bleibt |
| A7 ⚠ | purge | `cockpit purge --project X --yes` (VM) | Nur X gelöscht; ohne `--yes` verweigert |

## B. Capture & Zustellung (Hooks)

| Nr | Fall | Schritte | Erwartet |
|----|------|----------|----------|
| B1 | Live-Capture | Kurze echte Claude-Session im Testprojekt; danach `search` bzw. Verlauf | User+Assistant-Turns mit echten uuids in der DB; Session erscheint im Verlauf-Tab |
| B2 | Capture-Opt-out | Datei `.cockpit/no-capture` ins Projekt, Mini-Session | Keine neuen Turns für dieses Projekt |
| B3 | Briefing-Zustellung | Frage im Web beantworten → neue Session im selben Projekt starten | Antwort erscheint als SessionStart-Kontext; Item danach „zugestellt" (deliveredAt) |
| B4 | Zustellung einmalig | Zweite Session im selben Projekt | Dieselbe Antwort kommt NICHT erneut |
| B5 | Hooks global aus | `disableAllHooks: true` in settings.json | B1/B3 passieren NICHT — bekanntes Verhalten; doctor sollte davor warnen (siehe Lücken) |

## C. MCP (6 Tools, aus einer Claude-Session)

| Nr | Fall | Erwartet |
|----|------|----------|
| C1 | add_item | Item angelegt, Antwort enthält humanUrl (klickbarer Inbox-Link) |
| C2 | list_items | Projekt-scoped Default; `projectPath:""` global |
| C3 | update_item / answer_question | Statuswechsel/Antwort persistiert; answeredBy=claude wird NIE zugestellt |
| C4 | search_decisions | Entscheidungen mit Supersede-Kette |
| C5 | recent_turns | Jüngste Turns des Projekts |
| C6 | Options-Syntax | add_item-Body mit `( ) A` / `[ ] B` → Web zeigt klickbare Optionen |

## D. Web/SPA — Grundgerüst

| Nr | Fall | Erwartet |
|----|------|----------|
| D1 | Token-Einstieg | `/?token=` → 302 auf `/spa/?token=`; Token wandert in sessionStorage, URL ohne Token nutzbar; /api ohne Token → 403 |
| D2 | Projektauswahl | Header [Projekt…][Aktiv·N][Periode][Alle·N]; Einzelwahl spiegelt Chip mit ×; Auswahl bleibt beim Seitenwechsel |
| D3 | Zeitperiode | 7/14/30/90: Zähler ändern sich; Inbox blendet ältere Karten aus mit Hinweis „N ältere ausgeblendet — Alle anzeigen" |
| D4 | Themes | Hell/Dunkel/System über Einstellungen; beide sauber, 0 Konsolenfehler |
| D5 | Doctor-Punkt | „● System OK" im Header, Details per Hover |

## E. Übersicht & Briefing

| Nr | Fall | Erwartet |
|----|------|----------|
| E1 | Kacheln | Jetzt dran / Inbox offen / Blocker / Wartet auf dich / Entscheidungen / Projekte; Zahlen == Zielansichten (Kachel==Badge==Liste) |
| E2 | Kachel-Klicks | „Inbox offen" → ?filter=open; „Wartet auf dich" → Default-Anzeige; „Blocker" → Blocker-Anzeige |
| E3 | Projektkarte → Briefing | Klick landet auf /briefing des Projekts; „← Alle Projekte" führt zurück |
| E4 | Briefing deterministisch | Aktivität, Git (Branch/ungesichert/Commits), Wartet-auf-dich (klickbar → Karte), letzte Entscheidungen — sofort ohne KI |
| E5 | Briefing KI | „Zusammenfassen lassen" → Markdown mit Stand/Zuletzt/Nächste Schritte (S/M/L + Risiko)/Wartet; ohne LLM: Warnbox + Rohdaten (kein Crash) |
| E6 | Briefing Copy | „Für Session kopieren" → Markdown in Zwischenablage, „Kopiert!"-Feedback |

## F. Inbox (Anzeigen, Karten, Aktionen)

| Nr | Fall | Erwartet |
|----|------|----------|
| F1 | Chips | [Wartet auf dich·N][Blocker·N][Vorschläge·N][Log·N]; Default = Wartet auf dich = Frage/Blocker/Vorschlag/Task von Agenten, offen |
| F2 | Log-Tab | Ergebnis/Info/Memory/Entscheidungen + Human-Notizen; Typ-Chips NUR hier |
| F3 | Karten-Anatomie | `projekt #Nr` (immer), Titel, hh:mm + relatives Alter; Status-Chip nur wenn ≠ neu; BLOCKER immer als Text + roter Streifen |
| F4 | dringend-Suppression | >50 % dringend (min. 4 Karten) → Chips weg + Hinweiszeile |
| F5 | Suche | Sofort-Filter über Titel/Text/Projekt/#Nr; 0 Treffer → Empty + „Suche leeren" |
| F6 | Sortierung | Default Neueste zuerst; Dringlichkeit/Älteste/Nummer; ?sort= in URL |
| F7 | Später/Erledigt | Sekundär-Buttons; Erledigt lädt eigenen Satz, „nur zur Nachschau" |
| F8 | Antworten | [TEST]-Item beantworten: Karte verschwindet, Zähler sinkt, Echo-Karte „↳ … zugestellt an die nächste Session", Toast |
| F9 | erledigt/später + Undo | e/p-Buttons bzw. Tasten; Undo-Toast innerhalb 5 s stellt zurück |
| F10 | Tastatur | j/k/o/r/Strg+Enter/e/p/u/Esc |
| F11 | Klickbare Optionen | `( )` ersetzt nur andere `( )`-Zeilen im Antwortfeld; `[ ]` toggelt; Senden bleibt manuell |
| F12 | Deep-Link | ?item=<id> → angepinnte offene Karte mit Banner (Status, ggf. „aus einer anderen Auswahl"); unbekannte id → Miss-Banner mit Weiterklicks |
| F13 | KI-Einordnung | Karte öffnen → Triage-Vorschlag mit Antwort-Buttons; ohne LLM Fehlerbox, kein Crash |

## G. Entscheidungen / Suche / Report / Verlauf / Gedächtnis

| Nr | Fall | Erwartet |
|----|------|----------|
| G1 | Entscheidungen | Beantwortete Fragen + decision-Items; „volle Kette" zeigt ersetzte/verworfene; Anker klickbar |
| G2 | Suche | Turns-Volltext, Filter Projekt/Rolle; Treffer mit Snippet |
| G3 | Report | Tagesspalten, horizontal scrollbar, startet rechts (neuester Tag); Session-Block klickt in den Verlauf |
| G4 | Verlauf Liste | Sessions mit Projekt/Zeitspanne/Wortmeldungen/erstem Prompt; Sortierung Zeit/Projekt; Auswahl+Periode wirken |
| G5 | Verlauf Raw | Chronologisch, Du/Claude, hh:mm, Subagent-Marker; lange Turns „[gekürzt]"; „← Verlauf" zurück |
| G6 | VS-Code-Links | Dateipfade in Raw = vscode://file/-Links; Relativpfade gegen Projektwurzel aufgelöst |
| G7 | Gedächtnis & Regeln | CLAUDE.md je Projekt mit Budget-Balken + Git-Diff; Datei-Viewer mit Zeilennummern; Relativ-Links mit &project=; Secrets/fremde Pfade 403 |
| G8 | Einstellungen | Theme 3-Way + Expertenlevel (fließt in KI-Anfragen) |

## H. Härtung (API)

| Nr | Fall | Erwartet |
|----|------|----------|
| H1 | Token-Pflicht | Alle /api/** ohne Token → 403 |
| H2 | Fremder Host/Origin | Host-Header fremd → 403; POST mit fremdem Origin → 403; falscher Content-Type → 415 |
| H3 | Traversal | /api/file mit ../ bzw. encodierten Punkten → 403/404, nie Inhalt außerhalb der Wurzeln |
| H4 | Fehlerbilder | Unbekannte id → 404, kaputtes JSON → 400 (nie 500); /api/brief parallel → 429 |

## Bekannte Lücken (Stand 09.07., vor Tester-Übergabe schließen)

1. doctor prüft NICHT, ob ein `claude`-Binary erreichbar ist (KI-Features
   degradieren dann kommentarlos) — Check ergänzen.
2. doctor warnt NICHT bei `disableAllHooks: true` (Hooks registriert, aber
   wirkungslos — Capture und Zustellung stehen).
3. doctor prüft die MCP-Registrierung nicht (init meldet Fehlschlag nur einmalig).
