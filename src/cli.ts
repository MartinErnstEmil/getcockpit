#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CLI-Einstieg (PRD F2/F5): Suche ist erstklassig — der Tag-1-Wert braucht
// keine Verhaltensänderung von Modell oder Mensch.
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { COCKPIT_VERSION } from "./index.js";
import { backfill, defaultProjectsDir } from "./backfill.js";
import { cmdDoctor, cmdInit, cmdPurge, cmdUninstall } from "./lifecycle.js";
import { applyLegacyRemoval, runSetup, type SetupReport } from "./setup.js";
import { defaultSettingsPath, legacyHookKey } from "./settings.js";
import { resolveDbPath } from "./paths.js";
import { parseSince, runStandup } from "./standup.js";
import { Store, type ItemFilter } from "./store.js";
import { decisionsView, portfolioView } from "./views.js";
import { createWebServer, loadOrCreateWebToken, WEB_DEFAULT_PORT } from "./web.js";

function withStore<T>(fn: (store: Store) => T): T {
  const store = Store.open(resolveDbPath());
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function fail(message: string): void {
  console.error(`Fehler: ${message}`);
  process.exitCode = 1;
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

function printSetupReport(report: SetupReport): void {
  for (const s of report.stages) {
    const mark = s.status === "ok" ? "OK  " : s.status === "warn" ? "WARN" : "FAIL";
    console.log(`${mark} [${s.code}] ${s.title}`);
    if (s.status !== "ok" && s.fix) console.log(`       Fix: ${s.fix}`);
  }
  if (report.legacy.length > 0) {
    console.log("\nLegacy-Hooks (mit --remove-legacy entfernen):");
    for (const l of report.legacy) console.log(`  - ${l.event}: ${l.command}  [${l.marker}]`);
  }
  console.log(`\nLog: ${report.logPath}`);
}

const program = new Command();
program.name("cockpit").description("Durchsuchbares Archiv aller Claude-Code-Sessions").version(COCKPIT_VERSION);

program
  .command("search")
  .description("Volltextsuche über alle erfassten Sessions (BM25-gerankt)")
  .argument("<query...>", "Suchbegriffe (implizites AND)")
  .option("--project <pfad>", "nur Treffer aus diesem Projekt")
  .option("--since <iso>", "nur Treffer ab diesem Zeitpunkt (z. B. 2026-01-01)")
  .option("--role <rolle>", "user oder assistant")
  .option("--items", "stattdessen Inbox-Items durchsuchen")
  .option("--limit <n>", "max. Treffer", "20")
  .action((words: string[], opts) => {
    const query = words.join(" ");
    withStore((store) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (opts.items) {
        for (const h of store.searchItems(query, { limit })) {
          console.log(`${h.id}  [${h.type}/${h.status}]  ${h.title}\n    ${h.snippet}`);
        }
      } else {
        const hits = store.searchTurns(query, {
          project: opts.project,
          since: opts.since,
          role: opts.role,
          limit,
        });
        for (const h of hits) {
          console.log(`${shortDate(h.timestamp)}  ${h.role.padEnd(9)}  ${h.projectPath}\n    ${h.snippet}`);
        }
        if (hits.length === 0) console.log("Keine Treffer.");
        store.recordEvent({ eventType: "search", payload: { query, hits: hits.length } });
      }
    });
  });

program
  .command("backfill")
  .description("Importiert die vorhandene Claude-Code-Historie (idempotent)")
  .option("--dry-run", "nur zählen (parsebare Turns, ohne Duplikat-Prüfung), nichts schreiben")
  .option("--limit <n>", "max. Anzahl Dateien")
  .option("--project <pfad>", "nur Turns dieses Projekts (ohne Resume-Bookkeeping)")
  .option("--projects-dir <pfad>", "Transcript-Verzeichnis", defaultProjectsDir())
  .action(async (opts) => {
    const store = Store.open(resolveDbPath());
    try {
      const report = await backfill(store, {
        projectsDir: opts.projectsDir,
        dryRun: opts.dryRun === true,
        limit: opts.limit != null ? Number.parseInt(opts.limit, 10) : undefined,
        project: opts.project,
        onProgress: (m) => console.error(m),
      });
      const mode = report.dryRun ? " (dry-run)" : "";
      console.log(
        `Backfill${mode}: ${report.files} Dateien importiert, ${report.filesUnchanged} unverändert übersprungen, ` +
          `${report.turnsInserted} Turns, ${report.duplicates} Duplikate ignoriert, ` +
          `${report.brokenLines} kaputte Zeilen geskippt, ${report.redactions} Redactions, ` +
          `${(report.durationMs / 1000).toFixed(1)} s`,
      );
      if (!report.dryRun) store.recordEvent({ eventType: "backfill", payload: report });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      store.close();
    }
  });

program
  .command("add")
  .description("Item in die Inbox legen")
  .argument("<titel>", "Ein-Zeilen-Titel")
  .option("--type <typ>", "question|proposal|decision|result|blocker|fyi", "question")
  .option("--body <text>", "Details (Markdown)")
  .option("--priority <prio>", "urgent|high|medium|low", "medium")
  .option("--project <pfad>", "Projektpfad (Default: aktuelles Verzeichnis)")
  .option("--tags <liste>", "kommagetrennt")
  .action((titel: string, opts) => {
    withStore((store) => {
      const item = store.addItem({
        type: opts.type,
        title: titel,
        body: opts.body,
        priority: opts.priority,
        source: "human",
        projectPath: opts.project ?? process.cwd(),
        tags: opts.tags ? String(opts.tags).split(",").map((t: string) => t.trim()) : [],
      });
      console.log(`Angelegt: ${item.id}  [${item.type}] ${item.title}`);
    });
  });

program
  .command("inbox")
  .description("Items auflisten")
  .option("--status <status>", "new|in_progress|answered|postponed|rejected|done")
  .option("--type <typ>", "Item-Typ")
  .option("--project <pfad>", "Projektfilter (inkl. globale Items)")
  .option("--all", "auch erledigte/abgelehnte zeigen")
  .action((opts) => {
    withStore((store) => {
      const filter: ItemFilter = { status: opts.status, type: opts.type, project: opts.project };
      let items = store.listItems(filter);
      if (!opts.all && !opts.status) {
        items = items.filter((i) => i.status !== "done" && i.status !== "rejected");
      }
      if (items.length === 0) {
        console.log("Inbox leer.");
        return;
      }
      for (const i of items) {
        const answer = i.answer ? `\n    ↳ ${i.answer}` : "";
        console.log(`${i.id}  ${shortDate(i.createdAt)}  [${i.type}/${i.status}/${i.priority}]  ${i.title}${answer}`);
      }
    });
  });

program
  .command("answer")
  .description("Item beantworten (Status → answered)")
  .argument("<id>", "Item-Id (Präfix reicht)")
  .argument("<antwort...>", "Antworttext")
  .action((id: string, antwort: string[]) => {
    withStore((store) => {
      const item = store.answerItem(id, antwort.join(" "), "human");
      if (!item) return fail(`Item ${id} nicht gefunden oder mehrdeutig.`);
      console.log(`Beantwortet: ${item.id}  ${item.title}`);
    });
  });

program
  .command("done")
  .description("Item abschließen (Status → done)")
  .argument("<id>", "Item-Id (Präfix reicht)")
  .action((id: string) => {
    withStore((store) => {
      const item = store.updateItem(id, { status: "done" });
      if (!item) return fail(`Item ${id} nicht gefunden oder mehrdeutig.`);
      console.log(`Erledigt: ${item.id}  ${item.title}`);
    });
  });

program
  .command("init")
  .description("Hooks installieren (settings.json-Chirurgie mit Diff + Backup) und MCP registrieren")
  .option("--settings <pfad>", "abweichende settings.json (deaktiviert MCP-Registrierung)")
  .option("--no-mcp", "MCP-Registrierung überspringen")
  .option("--yes", "Diff ohne Rückfrage anwenden")
  .action(async (opts) => {
    const confirm = opts.yes
      ? undefined
      : async (): Promise<boolean> => {
          if (!process.stdin.isTTY) {
            console.error("Kein TTY: bitte --yes verwenden, um den Diff zu bestätigen.");
            return false;
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question("Änderung anwenden? [j/N] ");
          rl.close();
          return /^j(a)?$/i.test(answer.trim());
        };
    try {
      const report = await cmdInit({ settingsPath: opts.settings, noMcp: !opts.mcp, confirm });
      if (report.aborted) process.exitCode = 1;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("uninstall")
  .description("cockpit-Hooks aus settings.json entfernen (fremde Hooks bleiben unangetastet)")
  .option("--settings <pfad>", "abweichende settings.json")
  .action((opts) => {
    try {
      cmdUninstall({ settingsPath: opts.settings });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("doctor")
  .description("Installation prüfen: Standard-Fehlerbilder mit Fix-Befehl (inkl. claude-Binary, disableAllHooks, MCP)")
  .option("--settings <pfad>", "abweichende settings.json")
  .action((opts) => {
    const checks = cmdDoctor({ settingsPath: opts.settings });
    for (const c of checks) {
      console.log(`${c.ok ? "OK " : "FEHLT"}  ${c.label}${c.ok ? "" : `\n       Fix: ${c.fix}`}`);
    }
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
    else console.log("\nAlles bereit. Oberfläche öffnen: cockpit web");
  });

program
  .command("setup")
  .description("Geordnete Einrichtung prüfen und selbst heilen (Legacy, Backend, Hooks, Frontend, Test)")
  .option("--settings <pfad>", "abweichende settings.json (deaktiviert MCP-Spawns)")
  .option("--web-root <dir>", "abweichende SPA-Wurzel (Default: dist/web neben der CLI)")
  .option("--remove-legacy", "erkannte Legacy-Hooks (smriti/cola) entfernen — sonst nur anzeigen")
  .action((opts) => {
    const report = runSetup({
      settingsPath: opts.settings,
      webRoot: opts.webRoot,
      fileBlocker: opts.settings === undefined,
    });
    printSetupReport(report);
    if (report.legacy.length > 0 && opts.removeLegacy) {
      const keys = report.legacy.map((l) => legacyHookKey(l.event, l.command));
      const { removed } = applyLegacyRemoval(opts.settings ?? defaultSettingsPath(), keys);
      console.log(`\nLegacy-Hooks entfernt: ${removed}`);
    }
    if (report.hardFailed) process.exitCode = 1;
  });

program
  .command("purge")
  .description("Erfasste Daten löschen (alles oder ein Projekt); DB-Datei bleibt")
  .option("--project <pfad>", "nur dieses Projekt")
  .option("--yes", "ohne Rückfrage löschen")
  .action((opts) => {
    if (!opts.yes) {
      return fail("purge ist destruktiv — mit --yes bestätigen.");
    }
    const report = cmdPurge({ project: opts.project });
    console.log(`Gelöscht: ${report.turns} Turns, ${report.items} Items, ${report.events} Events.`);
  });

program
  .command("web")
  .description("Lokale Web-UI starten (nur 127.0.0.1, Token-gesichert; Stoppen mit Strg+C)")
  .option("--port <n>", "Port", String(WEB_DEFAULT_PORT))
  .action((opts) => {
    const store = Store.open(resolveDbPath());
    // Persistentes Token (PRD F7a): dieselbe URL überlebt Neustarts —
    // ein Lesezeichen "Cockpit" reicht dauerhaft.
    const token = loadOrCreateWebToken();
    const port = Number.parseInt(opts.port, 10);
    const server = createWebServer(store, token);
    server.listen(port, "127.0.0.1", () => {
      // Schöner Merk-Link zuerst (U5): *.localhost löst im Browser ohne jede
      // Einrichtung auf 127.0.0.1 auf — kein hosts-Eintrag, keine Adminrechte.
      console.log(`cockpit web läuft: http://cockpit.localhost:${port}/?token=${token}`);
      console.log(`Alternativ direkt: http://127.0.0.1:${port}/?token=${token}`);
      console.log("URL ist stabil (Token persistent) — als Lesezeichen taugt sie dauerhaft.");
      console.log(`Optional per hosts-Eintrag "127.0.0.1 cockpit" auch: http://cockpit:${port}/?token=${token}`);
      console.log("Nur lokal erreichbar; Beenden mit Strg+C.");
    });
    server.on("error", (err) => {
      fail(`Web-Server: ${err.message}${"code" in err && err.code === "EADDRINUSE" ? ` — Port ${port} belegt (Alt-System auf 7777? --port nutzen)` : ""}`);
      store.close();
    });
    process.on("SIGINT", () => {
      server.close();
      store.close();
      process.exit(0);
    });
  });

program
  .command("status")
  .description("Portfolio-Überblick: Setup-Health, Jetzt dran, alle Projekte (PRD F10)")
  .option("--project <pfad>", "nur dieses Projekt")
  .action((opts) => {
    withStore((store) => {
      const checks = cmdDoctor();
      const fails = checks.filter((c) => !c.ok);
      console.log(
        fails.length === 0
          ? `Setup: ${checks.length}/${checks.length} OK`
          : `Setup: ${checks.length - fails.length}/${checks.length} — ${fails.map((f) => f.label).join(" · ")}`,
      );
      const view = portfolioView(store, { project: opts.project });

      console.log("\nJetzt dran:");
      if (view.nextActions.length === 0 && view.firstRun) {
        console.log(
          `  Alles importiert — ${view.firstRun.turns} Turns aus ${view.firstRun.projects} Projekten durchsuchbar.`,
        );
        console.log(`  Probier: cockpit search "<begriff>"  oder  cockpit standup --since 7d`);
      } else if (view.nextActions.length === 0) {
        console.log("  Nichts wartet auf dich.");
      }
      for (const a of view.nextActions) {
        const proj = a.projectPath ? `  [${a.projectPath.split("/").pop()}]` : "";
        console.log(`  ${a.kind === "blocker" ? "!!" : a.kind === "urgent" ? "! " : "· "} ${a.title}${proj}`);
        console.log(`     ${a.why}${a.itemId ? `  → cockpit answer ${a.itemId} "..."` : ""}`);
      }

      const fresh = view.projects.filter((p) => !p.stale);
      const staleCount = view.projects.length - fresh.length;
      console.log("\nProjekte (zuletzt aktiv zuerst):");
      for (const p of fresh) {
        const name = p.projectPath.split("/").pop() ?? p.projectPath;
        const live = p.activeSession ? "  ● Session läuft" : "";
        const flags = [
          p.blockers > 0 ? `${p.blockers} Blocker` : null,
          p.waitingOnHuman > 0 ? `${p.waitingOnHuman} warten auf dich` : null,
        ].filter(Boolean).join(" · ");
        console.log(`  ${name}${live}  —  zuletzt ${shortDate(p.lastActivity)}, ${p.sessions} Sessions, ${p.turns} Turns${flags ? `  [${flags}]` : ""}`);
        if (p.git) {
          const dirty = p.git.dirtyFiles > 0 ? `, ${p.git.dirtyFiles} geänderte Dateien` : "";
          const lastCommit = p.git.recentCommits[0];
          console.log(`     git: ${p.git.branch ?? "?"}${dirty}${lastCommit ? ` — ${lastCommit.sha.slice(0, 7)} ${lastCommit.subject}` : ""}`);
        }
        for (const d of p.latestDecisions) {
          console.log(`     ✓ ${shortDate(d.at)} ${d.title}`);
        }
      }
      if (staleCount > 0) console.log(`  (+ ${staleCount} inaktive Projekte > 30 Tage — mit --project <pfad> einsehbar)`);
      store.recordEvent({ eventType: "status", payload: { projects: view.projects.length, nextActions: view.nextActions.length } });
    });
  });

program
  .command("standup")
  .description("Standup-Bericht über alle Projekte: Getan/Entschieden/Offen/Nächste Schritte (PRD F11)")
  .option("--since <zeitraum>", "z. B. 1d, 7d, yesterday oder ISO-Datum", "1d")
  .option("--project <pfad>", "nur dieses Projekt")
  .option("--out <datei>", "Markdown in Datei schreiben statt stdout")
  .option("--no-llm", "nur deterministischer Rohbericht (kein claude-Aufruf)")
  .action(async (opts) => {
    const store = Store.open(resolveDbPath());
    try {
      const since = parseSince(opts.since);
      const result = await runStandup(store, { since, project: opts.project, noLlm: !opts.llm });
      if (result.degradedBecause) {
        console.error(`Hinweis: LLM-Pfad degradiert (${result.degradedBecause}) — Rohbericht.`);
      }
      if (opts.out) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(opts.out, result.report + "\n", "utf8");
        console.log(`Standup geschrieben: ${opts.out} (${result.mode})`);
      } else {
        console.log(result.report);
      }
      store.recordEvent({
        eventType: "standup_run",
        payload: { mode: result.mode, stripped: result.strippedReferences, since },
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      store.close();
    }
  });

program
  .command("decisions")
  .description("Entscheidungs-Log mit Provenienz: Anker, Git-SHA, Supersede-Kette (PRD F12)")
  .option("--project <pfad>", "nur dieses Projekt (inkl. globale)")
  .option("--all", "auch ersetzte/abgelehnte Entscheidungen (volle Kette)")
  .action((opts) => {
    withStore((store) => {
      const entries = decisionsView(store, { project: opts.project, all: opts.all === true });
      if (entries.length === 0) {
        console.log(
          "Noch keine Entscheidungen — sie entstehen automatisch, wenn du Fragen in der Inbox beantwortest.",
        );
        return;
      }
      for (const e of entries) {
        const anchor = e.anchorFile ? `  @ ${e.anchorFile}${e.anchorLine != null ? `:${e.anchorLine}` : ""}` : "";
        const sha = e.gitSha ? `  [${e.gitSha.slice(0, 7)}${e.gitBranch ? ` ${e.gitBranch}` : ""}]` : "";
        const chain = [
          e.replacesId ? `ersetzt ${e.replacesId}` : null,
          e.supersededById ? `ERSETZT DURCH ${e.supersededById}` : null,
        ].filter(Boolean).join(" · ");
        console.log(`${e.id}  ${shortDate(e.createdAt)}  ${e.title}${anchor}${sha}`);
        if (e.answer) console.log(`    ↳ ${e.answer}`);
        if (chain) console.log(`    ⛓ ${chain}`);
      }
      store.recordEvent({ eventType: "decisions", payload: { count: entries.length, all: opts.all === true } });
    });
  });

program
  .command("stats")
  .description("Lokale Nutzungs-Metriken aus der Events-Tabelle (kein Phone-Home)")
  .action(() => {
    withStore((store) => {
      const db = store.rawDb();
      const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
      const events = db
        .prepare("SELECT event_type, COUNT(*) c FROM events GROUP BY event_type ORDER BY c DESC")
        .all() as Array<{ event_type: string; c: number }>;
      const items = db
        .prepare("SELECT status, COUNT(*) c FROM items GROUP BY status")
        .all() as Array<{ status: string; c: number }>;
      const totalItems = items.reduce((a, r) => a + r.c, 0);
      const resolved = items
        .filter((r) => r.status === "answered" || r.status === "done")
        .reduce((a, r) => a + r.c, 0);
      console.log(`Turns:     ${one("SELECT COUNT(*) c FROM turns")}`);
      console.log(`Projekte:  ${one("SELECT COUNT(DISTINCT project_path) c FROM turns")}`);
      console.log(`Sessions:  ${one("SELECT COUNT(DISTINCT session_id) c FROM turns")}`);
      console.log(`Items:     ${totalItems} (${items.map((r) => `${r.status}: ${r.c}`).join(", ") || "keine"})`);
      console.log(
        `Antwortquote: ${totalItems > 0 ? Math.round((100 * resolved) / totalItems) : 0} % (answered+done / alle)`,
      );
      console.log("Events:");
      if (events.length === 0) console.log("  (keine)");
      for (const e of events) console.log(`  ${e.event_type}: ${e.c}`);
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
