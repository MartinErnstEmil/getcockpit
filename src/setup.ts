// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Geordnete, selbstheilende Einrichtung — EINE Quelle für App-Start UND
// `cockpit setup`. Stufen laufen in fester Reihenfolge (Preflight -> Legacy ->
// Backend -> Hooks -> Frontend -> MCP -> Verify); jede ist idempotent und trägt
// einen Fehlercode. Harte Stufen (Backend/Hooks/Frontend) markieren hardFailed,
// weiche (Legacy/MCP/Verify) warnen nur. KEIN Throw nach außen: jeder Ausgang
// ist ein Report, den CLI und Setup-Panel direkt anzeigen können.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cockpitHome, resolveDbPath } from "./paths.js";
import {
  addCockpitHooks,
  defaultSettingsPath,
  listLegacyHooks,
  loadSettings,
  removeLegacyHooks,
  saveSettings,
  serializeSettings,
  type LegacyHook,
} from "./settings.js";
import { cmdDoctor, mcpRegisterCommand, refreshHookBundleIfStale, registerMcp } from "./lifecycle.js";
import { Store } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCKER_TAG = "setup-failure";

export type StageStatus = "ok" | "warn" | "fail";

export interface StageResult {
  id: string;
  code: string;
  status: StageStatus;
  title: string;
  detail?: string;
  fix?: string;
}

export interface SetupReport {
  ok: boolean;
  hardFailed: boolean;
  needsAttention: boolean;
  stages: StageResult[];
  legacy: LegacyHook[];
  logPath: string;
}

export interface RunSetupOpts {
  settingsPath?: string;
  // claude/MCP-Spawns (Default: nur bei der ECHTEN Installation, wie doctor/D5).
  spawnChecks?: boolean;
  // Bei hartem Fehler ein Blocker-Item anlegen (Default true; Fixtures: false).
  fileBlocker?: boolean;
  webRoot?: string;
}

export function setupLogPath(): string {
  return join(cockpitHome(), "setup.log");
}

export function runSetup(opts: RunSetupOpts = {}): SetupReport {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const spawnChecks = opts.spawnChecks ?? opts.settingsPath === undefined;
  const legacyRes = stageLegacy(settingsPath);
  const backend = stageBackend();
  const stages: StageResult[] = [
    stagePreflight(),
    legacyRes.stage,
    backend.stage,
    stageHooks(settingsPath),
    stageFrontend(opts.webRoot),
    stageMcp(spawnChecks),
    stageVerify(settingsPath, spawnChecks),
  ];

  const hardFailed = stages.some((s) => s.status === "fail");
  const report: SetupReport = {
    ok: !hardFailed,
    hardFailed,
    needsAttention: hardFailed || legacyRes.legacy.length > 0,
    stages,
    legacy: legacyRes.legacy,
    logPath: setupLogPath(),
  };
  writeSetupLog(report);
  if (hardFailed && opts.fileBlocker !== false && backend.store) {
    try {
      fileSetupBlocker(backend.store, report);
    } catch {
      /* Blocker ist Nice-to-have; das Log trägt den Fehler ohnehin. */
    }
  }
  backend.store?.close();
  return report;
}

// Entfernt vom Nutzer ausgewählte Legacy-Hooks (keys aus legacyHookKey) und legt
// vorher EINMAL ein Backup an. Von CLI (`--remove-legacy`) und Panel genutzt.
export function applyLegacyRemoval(settingsPath: string, keys: string[]): { removed: number } {
  const { settings } = loadSettings(settingsPath);
  const result = removeLegacyHooks(settings, keys);
  if (result.removed > 0) {
    backupOnce(settingsPath);
    saveSettings(settingsPath, result.settings);
  }
  return { removed: result.removed };
}

// --- Stufen ----------------------------------------------------------------

function stagePreflight(): StageResult {
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = (maj ?? 0) > 22 || ((maj ?? 0) === 22 && (min ?? 0) >= 5);
  if (!nodeOk) {
    return fail("preflight", "E101", `Node ${process.version} zu alt (>= 22.5 nötig)`, undefined, "Node aktualisieren: https://nodejs.org");
  }
  try {
    const home = cockpitHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const probe = join(home, ".setup-probe");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  } catch (err) {
    return fail("preflight", "E102", `${cockpitHome()} nicht beschreibbar`, String(err), "Schreibrechte prüfen oder COCKPIT_HOME setzen");
  }
  return ok("preflight", "E100", "Umgebung bereit");
}

function stageLegacy(settingsPath: string): { stage: StageResult; legacy: LegacyHook[] } {
  let legacy: LegacyHook[];
  try {
    legacy = listLegacyHooks(loadSettings(settingsPath).settings);
  } catch (err) {
    return { stage: warn("legacy", "E201", "settings.json nicht lesbar", String(err), "Datei auf JSON-Syntaxfehler prüfen"), legacy: [] };
  }
  if (legacy.length === 0) return { stage: ok("legacy", "E200", "Keine Legacy-Hooks gefunden"), legacy };
  const names = [...new Set(legacy.map((l) => l.marker))].join(", ");
  const stage = warn(
    "legacy",
    "E210",
    `${legacy.length} Legacy-Hook(s) gefunden (${names})`,
    "Nichts wird ohne deine Bestätigung gelöscht — zur Entfernung auswählen.",
    "cockpit setup --remove-legacy (CLI) oder im Setup-Panel auswählen",
  );
  return { stage, legacy };
}

function stageBackend(): { stage: StageResult; store: Store | null } {
  try {
    const store = Store.open(resolveDbPath());
    return { stage: ok("backend", "E300", `Datenbank bereit (${resolveDbPath()})`), store };
  } catch (err) {
    return {
      stage: fail("backend", "E301", "Datenbank/Migration fehlgeschlagen", String(err), `Rechte auf ${cockpitHome()} prüfen; ggf. COCKPIT_DB setzen`),
      store: null,
    };
  }
}

function stageHooks(settingsPath: string): StageResult {
  let refresh;
  try {
    refresh = refreshHookBundleIfStale();
  } catch (err) {
    return fail("hooks", "E401", "Hook-Bundle nicht installierbar", String(err), "Paket neu bauen (npm run build) und erneut versuchen");
  }
  try {
    const { settings, raw } = loadSettings(settingsPath);
    const result = addCockpitHooks(settings, refresh.dest);
    const next = serializeSettings(result.settings);
    // Nur schreiben, wenn sich wirklich etwas ändert — kein settings.json-Churn
    // bei jedem App-Start.
    if (raw !== next) {
      backupOnce(settingsPath);
      saveSettings(settingsPath, result.settings);
    }
  } catch (err) {
    return fail("hooks", "E402", "settings.json nicht schreibbar", String(err), "Datei-Rechte und JSON-Syntax prüfen");
  }
  const note = refresh.refreshed ? `Bundle aktualisiert (${refresh.installed ?? "—"} -> ${refresh.bundled ?? "—"})` : "Bundle aktuell";
  return ok("hooks", "E400", `Hooks registriert; ${note}`);
}

function stageFrontend(webRoot?: string): StageResult {
  const index = join(webRoot ?? join(HERE, "web"), "index.html");
  if (existsSync(index)) return ok("frontend", "E500", "Oberfläche (SPA) vorhanden");
  return fail("frontend", "E501", "SPA-Build fehlt (dist/web/index.html)", index, "npm run build (voller Build inkl. SPA)");
}

function stageMcp(spawnChecks: boolean): StageResult {
  if (!spawnChecks) return ok("mcp", "E600", "MCP-Registrierung übersprungen (Fixture/Schnellstart)");
  const lines: string[] = [];
  if (registerMcp((l) => lines.push(l)) === "registered") return ok("mcp", "E600", "MCP-Server registriert (cockpit)");
  return warn("mcp", "E601", "MCP-Registrierung fehlgeschlagen — Agenten können keine Items anlegen", lines.join(" "), mcpRegisterCommand());
}

function stageVerify(settingsPath: string, spawnChecks: boolean): StageResult {
  // deliveryChain:false — der ~17 s-Zustelltest gehört nicht in den Start-Pfad
  // (Nutzerentscheid: schnelle Checks je Start, Volltest nur auf Abruf).
  const checks = cmdDoctor({ settingsPath, spawnChecks, deliveryChain: false });
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return ok("verify", "E700", `Selbstprüfung bestanden (${checks.length} Checks)`);
  return warn(
    "verify",
    "E701",
    `Selbstprüfung: ${failed.length} Hinweis(e)`,
    failed.map((c) => c.label).join(" | "),
    failed.map((c) => c.fix).filter(Boolean).join(" | "),
  );
}

// --- Nebenwirkungen --------------------------------------------------------

function backupOnce(settingsPath: string): void {
  const backup = `${settingsPath}.cockpit-backup`;
  if (existsSync(settingsPath) && !existsSync(backup)) copyFileSync(settingsPath, backup);
}

function writeSetupLog(report: SetupReport): void {
  const stamp = new Date().toISOString();
  const state = report.hardFailed ? "HARD-FAIL" : report.needsAttention ? "ATTENTION" : "OK";
  const lines = report.stages.map(
    (s) => `  [${s.code}] ${s.status.toUpperCase()} ${s.title}${s.detail ? ` — ${s.detail}` : ""}`,
  );
  try {
    mkdirSync(cockpitHome(), { recursive: true, mode: 0o700 });
    appendFileSync(setupLogPath(), `\n== ${stamp} ${state} ==\n${lines.join("\n")}\n`, "utf8");
  } catch {
    /* Log ist Nice-to-have, nie fatal. */
  }
}

// Exportiert für den Test (Blocker-Anlage + Dedupe) — im Normalbetrieb nur aus
// runSetup heraus aufgerufen, wenn eine harte Stufe fehlschlägt.
export function fileSetupBlocker(store: Store, report: SetupReport): void {
  const failed = report.stages.filter((s) => s.status === "fail");
  const title = `Setup fehlgeschlagen (${failed.map((s) => s.code).join(",")})`;
  // Dedupe: kein neues Item je Fehlstart, solange ein offenes mit gleichem Titel
  // (= gleiche Fehlercodes) existiert.
  const open = store.listItems({ type: "blocker" }).filter((i) => i.status !== "done" && i.status !== "rejected");
  if (open.some((i) => i.title === title)) return;
  const body = failed.map((s) => `- [${s.code}] ${s.title}${s.fix ? ` — Fix: ${s.fix}` : ""}`).join("\n");
  store.addItem({ type: "blocker", priority: "high", title, body, tags: [BLOCKER_TAG], source: "claude" });
}

// --- Konstruktoren (halten die Stufen kurz und lesbar) ---------------------

function ok(id: string, code: string, title: string): StageResult {
  return { id, code, status: "ok", title };
}
function warn(id: string, code: string, title: string, detail?: string, fix?: string): StageResult {
  return { id, code, status: "warn", title, detail, fix };
}
function fail(id: string, code: string, title: string, detail?: string, fix?: string): StageResult {
  return { id, code, status: "fail", title, detail, fix };
}
