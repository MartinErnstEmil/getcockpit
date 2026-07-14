# Cockpit — Installation für Tester (Tarball)

Cockpit zeichnet deine Claude-Code-Sessions lokal auf und macht sie durchsuchbar:
Portfolio-Überblick, Standups, Entscheidungs-Log und eine Inbox, über die
Claude dir Fragen stellt und deine Antworten zurück in die nächste Session
geliefert werden. Alles bleibt auf deinem Rechner — kein Cloud-Upload.
Die Anwender-Doku ist `docs/HANDBUCH.md` (liegt im Paket).

## Voraussetzungen

- Node.js ≥ 22.5 (`node --version`)
- Claude Code installiert und eingeloggt (einmal `claude` gestartet) — ohne
  Claude Code ist Cockpit sinnlos, es zeichnet dessen Sessions auf
- Windows, macOS oder Linux

## Schritt 1 — Paket installieren

Du hast eine Datei `getcockpit-<version>.tgz` bekommen. Installiere sie global:

```
npm install -g ./getcockpit-0.4.0.tgz
cockpit --version
```

## Schritt 2 — `cockpit init` (Hooks + MCP einrichten)

```
cockpit init
```

Was passiert:

1. Das Hook-Bundle wird nach `~/.cockpit/bin/cockpit-hook.cjs` kopiert
   (ein zero-dependency-Skript, das Sessions aufzeichnet und Antworten zustellt).
2. Die geplante Änderung an `~/.claude/settings.json` wird als Diff angezeigt —
   mit `j` bestätigen. Vorher entsteht ein byte-genaues Backup
   (`settings.json.cockpit-backup`); fremde Einträge bleiben unangetastet.
3. Der MCP-Server `cockpit` wird bei Claude Code registriert (damit Claude dir
   Fragen in die Inbox legen kann). Schlägt das fehl, druckt init den manuellen
   Befehl zum Nachholen.

## Schritt 3 — Historie importieren (Backfill)

```
cockpit backfill --dry-run    # zeigt, was importiert würde (inkl. Redaction-Report)
cockpit backfill              # echter Import; idempotent, jederzeit wiederholbar
```

Danach ist deine bisherige Claude-Code-Historie sofort durchsuchbar:

```
cockpit search "ein begriff aus einer alten session"
```

## Schritt 4 — Installation prüfen

```
cockpit doctor
```

Alle Checks müssen OK sein. Jeder Fehlschlag nennt den Fix-Befehl direkt mit.
Wichtigster Stolperstein: steht `"disableAllHooks": true` in deiner
settings.json, sind die Hooks registriert, aber wirkungslos — doctor warnt davor.

## Schritt 5 — Web-UI starten

```
cockpit web
```

Der Befehl druckt die URL (mit Zugriffs-Token), z. B.
`http://cockpit.localhost:7878/?token=…` — die URL ist stabil und taugt als
Lesezeichen. Nur lokal erreichbar (127.0.0.1); Beenden mit Strg+C.

## So erlebst du den Kern-Kreislauf einmal komplett

Der Kreislauf ist: **Frage aus einer Session → Web-Inbox → deine Antwort →
Zustellung zurück in die Session.** So löst du ihn aus:

1. Starte in einem beliebigen Projekt eine Claude-Code-Session und sage z. B.:
   *„Leg mir eine Frage ins Cockpit: Soll Feature X oder Y zuerst?“*
   Claude ruft das MCP-Tool `add_item` auf und zeigt dir einen Cockpit-Link.
2. Öffne die Inbox in der Web-UI, beantworte die Karte und klicke **Zustellen**.
3. Die Antwort erreicht Claude automatisch: eine **laufende** Session desselben
   Projekts bekommt sie bei deinem nächsten Prompt injiziert, eine **neue**
   Session im Start-Briefing. (Claude kann sie auch aktiv per `pickup_answers`
   abholen.)

Jede beantwortete Frage landet automatisch im Entscheidungs-Log („Entscheidungen“
in der Web-UI bzw. `cockpit decisions`).

## Sensibles Projekt nicht aufzeichnen

Zwei Wege, gleiche Wirkung:

- In der Web-UI: **Einstellungen → Projekte → Aufzeichnen aus**
- Oder eine leere Datei `.cockpit/no-capture` ins Projektverzeichnis legen

Bereits erfasste Daten eines Projekts löscht `cockpit purge --project <pfad> --yes`.

## Deinstallation (rückstandsfrei)

```
cockpit uninstall                        # entfernt NUR die cockpit-Hooks aus settings.json
claude mcp remove --scope user cockpit   # MCP-Deregistrierung
npm uninstall -g getcockpit              # Paket entfernen
```

`uninstall` prüft gegen das Backup und meldet, ob die settings.json wieder
byte-genau dem Zustand vor init entspricht. Die Datenbank `~/.cockpit/cockpit.db`
bleibt erhalten; löschen mit `cockpit purge --yes`, das Verzeichnis `~/.cockpit`
danach manuell entfernen.

## Betriebsdaten

| Was | Wo |
|---|---|
| Datenbank | `~/.cockpit/cockpit.db` (Override: Env `COCKPIT_DB`) |
| Web-Token | `~/.cockpit/web-token` (persistent, nur lokal) |
| Hook-Diagnose-Log | `~/.cockpit/hooks.log` |
| Dead-Letter (nur bei DB-Fehlern) | `~/.cockpit/dead-letter.jsonl` |
| Per-Projekt-Capture-Opt-out | Datei `.cockpit/no-capture` im Projektverzeichnis |

Hook-Verhalten: Exit-Code immer 0 — ein Cockpit-Fehler blockiert Claude Code nie.

## Feedback

Am wertvollsten: dein erster Eindruck und alles, was hakt.

- E-Mail: martin@extracode.de (in der Web-UI: Einstellungen → „Feedback geben“)
- Oder direkt im Produkt: `cockpit add "dein Befund" --type fyi` — und beim
  nächsten Austausch Screenshot/Export mitschicken
- Als Abnahme-Checkliste liegt `docs/TESTPROTOKOLL.md` bei (optional)
