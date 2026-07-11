# cockpit — Repo-Regeln

Lokales, durchsuchbares Archiv aller Claude-Code-Sessions plus persistente Agenten-Inbox mit Antwort-Zustellung. Ein npm-Paket (`getcockpit`), TypeScript/ESM, better-sqlite3 (CLI/MCP/Web) + node:sqlite (Hook-Bundle), FTS5/BM25, React-SPA als Web-UI, kein Cloud-Anteil.

Verbindliche Dokumente: ADR.md > PRD.md. Abweichungen nur mit DECISIONS.md-Eintrag. Interne Arbeitsstände (PROGRESS, BLOCKERS, PROJEKTPLAN, Goal-Prompts, Strategie) liegen ungetrackt in `internal/` — nach Compaction zuerst `internal/PROGRESS.md` und `internal/BLOCKERS.md` lesen, nach jedem Milestone `internal/PROGRESS.md` fortschreiben.

## Befehle

- Build: `npm run build` (tsc + esbuild-Hook-Bundle + SPA); nur Server: `npm run build:server`
- Tests: `npm test` (baut Server zuerst; vitest gegen echte Temp-DBs)
- Typecheck: `npm run typecheck` und `npm run typecheck:spa`
- VOR `npm pack`/Release: IMMER `rm -rf dist && npm run build` — tsc räumt dist/ nie auf, sonst fahren Build-Leichen im Paket mit.

## Architektur-Karte

`src/db.ts` (Treiber, Pragmas, user_version-Migrationen; Schema-Freeze-Test) → `src/store.ts` (Turns/Items/Events, bm25-Suche) ← `src/cli.ts` (commander), `src/mcp.ts` (7 Tools, stdio) und `src/web.ts` (node:http, serviert die SPA aus `dist/web`). `src/transcript.ts` parst Claude-JSONL streaming (defensiv, wirft nie); `src/backfill.ts` importiert `~/.claude/projects` idempotent (uuid-Dedupe); `src/redact.ts` läuft vor JEDEM Persistieren. `src/hooks/` wird per esbuild zu einem zero-dependency CJS-Bundle (`dist/hooks/cockpit-hook.cjs`, nutzt node:sqlite), das `cockpit init` nach `~/.cockpit/bin/` kopiert. `src/settings.ts` macht idempotente settings.json-Chirurgie (fremde Hooks nie anfassen). SPA in `spa/` (React/Vite/Tailwind, Carbon-Skin), baut nach `dist/web`. Statische Landingpage in `site/` (GitHub Pages, kein Build).

## Selbstschutz-Verbote (absolut)

- Nie schreiben außerhalb dieses Repos und %TEMP%.
- Nie anfassen: `~/.claude/settings.json`, `~/.claude/settings.local.json`. `~/.claude/projects/` nur READ-ONLY; für Tests nach %TEMP% kopieren.
- Hooks/MCP aus diesem Repo heraus NIE live registrieren (`claude mcp add` verboten). Verifikation: stdin-Fixtures bzw. MCP-SDK-Client-Harness; `init`/`doctor` nur gegen `--settings`-Fixtures.
- Produkt-Pfade: DB `~/.cockpit/cockpit.db` (Override `COCKPIT_DB`, Home-Override `COCKPIT_HOME`), Log `~/.cockpit/hooks.log`, Web-Port 7878. Tests: ausschließlich Temp-Verzeichnisse, ephemere Ports, keine überlebenden Hintergrundprozesse.

## Qualitätsregeln

- Tests = echte Integration: kein Mocking von SQLite/Dateisystem/Kindprozessen; verboten sind `.skip`, `|| true`, aufgeweichte Gates.
- Hook-Code: Exit-Code immer 0, jede Fehlerpfad-Abzweigung endet im Dead-Letter-Log, nie in einer Exception nach außen.
- Redaction vor Persistierung ist nicht optional; Roh-Secrets dürfen die DB nie erreichen.
- Migrationen sind eingefroren (append-only, SHA-Test in test/schema-freeze.test.ts) — bestehende Einträge nie ändern.
- Kommentare erklären WHY; keine Zeilen-Paraphrasen. Kein Emoji. Max. ~30 Zeilen pro Funktion.
- Version lebt doppelt: package.json UND src/index.ts (COCKPIT_VERSION) — beim Bump beide synchron halten.
