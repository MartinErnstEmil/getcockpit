// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Lifecycle-Befehle (PRD F8): init, uninstall, doctor, purge.
// init/uninstall machen settings.json-Chirurgie mit Diff-Anzeige und Backup;
// MCP-Registrierung läuft NUR gegen die echte settings.json (D5).
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cockpitHome, hookBundleInstallPath, resolveDbPath } from "./paths.js";
import {
  addCockpitHooks,
  defaultSettingsPath,
  hasCockpitHooks,
  loadSettings,
  removeCockpitHooks,
  saveSettings,
  serializeSettings,
} from "./settings.js";
import { Store, type PurgeReport } from "./store.js";
import { runDeliverySelftest } from "./selftest.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function bundledHookSource(): string {
  return join(HERE, "hooks", "cockpit-hook.cjs");
}

export function mcpServerPath(): string {
  return join(HERE, "mcp.js");
}

export function mcpRegisterArgs(): string[] {
  // KEIN add-json: das JSON-Argument wird von der Windows-Shell zerlegt
  // ("Invalid input", live beobachtet 2026-07-07). Die Args-Form ist quoting-frei.
  return ["mcp", "add", "--scope", "user", "cockpit", "--", "node", mcpServerPath().replace(/\\/g, "/")];
}

export function mcpRegisterCommand(): string {
  return `claude ${mcpRegisterArgs().join(" ")}`;
}

export interface InitOptions {
  settingsPath?: string;
  noMcp?: boolean;
  out?: (line: string) => void;
  // Diff-Bestätigung vor dem Schreiben (PRD F8); ohne Callback wird geschrieben.
  confirm?: () => Promise<boolean>;
}

export interface InitReport {
  aborted: boolean;
  bundleInstalled: string;
  settingsPath: string;
  backupPath: string | null;
  added: string[];
  replaced: string[];
  mcp: "registered" | "skipped" | "failed";
}

export async function cmdInit(opts: InitOptions = {}): Promise<InitReport> {
  const out = opts.out ?? console.log;
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const bundle = installHookBundle();
  out(`Hook-Bundle installiert: ${bundle}`);

  const { settings, raw } = loadSettings(settingsPath);
  const result = addCockpitHooks(settings, bundle);
  out(`\nGeplante Änderung an ${settingsPath}:`);
  out(diffPreview(raw, serializeSettings(result.settings)));
  if (opts.confirm && !(await opts.confirm())) {
    out("Abgebrochen — settings.json unverändert.");
    return {
      aborted: true,
      bundleInstalled: bundle,
      settingsPath,
      backupPath: null,
      added: [],
      replaced: [],
      mcp: "skipped",
    };
  }

  let backupPath: string | null = null;
  if (raw !== null) {
    backupPath = `${settingsPath}.cockpit-backup`;
    // Erste Sicherung gewinnt: byte-genauer Vorher-Stand für uninstall.
    if (!existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
    out(`Backup: ${backupPath}`);
  }
  saveSettings(settingsPath, result.settings);
  out(`Hooks eingetragen: ${[...result.added, ...result.replaced].join(", ")}`);

  // D5: claude wird nur gespawnt, wenn gegen die ECHTE settings.json
  // installiert wird — Fixture-Läufe können nie live registrieren.
  const allowMcp = !opts.noMcp && opts.settingsPath === undefined;
  const mcp = allowMcp ? registerMcp(out) : "skipped";
  if (mcp === "skipped") out(`MCP-Registrierung übersprungen. Manuell: ${mcpRegisterCommand()}`);

  out("\nNächste Schritte:");
  out("  1. cockpit backfill --dry-run   (Redaction-Report sichten)");
  out("  2. cockpit backfill             (Historie importieren)");
  out("  3. cockpit doctor               (Installation prüfen)");
  out("  4. cockpit web                  (Oberfläche im Browser öffnen)");
  return {
    aborted: false,
    bundleInstalled: bundle,
    settingsPath,
    backupPath,
    added: result.added,
    replaced: result.replaced,
    mcp,
  };
}

export function installHookBundle(): string {
  const src = bundledHookSource();
  if (!existsSync(src)) {
    throw new Error(`Hook-Bundle fehlt (${src}) — Paket unvollständig gebaut?`);
  }
  const dest = hookBundleInstallPath();
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  copyFileSync(src, dest);
  return dest;
}

// Version aus dem Banner „// cockpit-hook-version: X" (build-hooks.mjs). Liest
// nur den Dateikopf — das Bundle ist einige KB groß, ein Prefix genügt.
function bundleVersion(file: string): string | null {
  if (!existsSync(file)) return null;
  const head = readFileSync(file, "utf8").slice(0, 200);
  return head.match(/cockpit-hook-version:\s*(\S+)/)?.[1] ?? null;
}

export function installedHookVersion(): string | null {
  return bundleVersion(hookBundleInstallPath());
}

export function bundledHookVersion(): string | null {
  return bundleVersion(bundledHookSource());
}

export interface HookRefresh {
  refreshed: boolean;
  installed: string | null;
  bundled: string | null;
  dest: string;
}

// Selbstheilung (App-Start): kopiert das mitgelieferte Bundle nur, wenn das
// installierte fehlt oder eine ANDERE Version trägt — idempotent, kein Schreiben
// im Normalfall. Schließt den stale-Bundle-Fund (i-bb48f7ba7b): ein Upgrade der
// App aktualisierte den Hook bisher nie ohne `cockpit init`.
export function refreshHookBundleIfStale(): HookRefresh {
  const dest = hookBundleInstallPath();
  const installed = installedHookVersion();
  const bundled = bundledHookVersion();
  const stale = !existsSync(dest) || installed !== bundled;
  if (stale) installHookBundle();
  return { refreshed: stale, installed, bundled, dest };
}

export function registerMcp(out: (line: string) => void): "registered" | "failed" {
  const res = spawnSync("claude", mcpRegisterArgs(), {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.status === 0 || /already exists/i.test(res.stderr ?? "")) {
    out("MCP-Server registriert (scope user, Name cockpit).");
    return "registered";
  }
  out(`MCP-Registrierung fehlgeschlagen: ${(res.stderr || res.stdout || "").trim()}`);
  out(`Manuell nachholen: ${mcpRegisterCommand()}`);
  return "failed";
}

// Kompakte Diff-Anzeige: nur geänderte/neue Zeilen, genug für ein
// informiertes Ja/Nein vor dem Schreiben.
function diffPreview(beforeRaw: string | null, after: string): string {
  const before = new Set((beforeRaw ?? "").split("\n"));
  const lines = after.split("\n").filter((l) => !before.has(l));
  return lines.map((l) => `  + ${l.trim()}`).join("\n") || "  (keine Änderung)";
}

export interface UninstallReport {
  settingsPath: string;
  removed: string[];
  byteIdentical: boolean | null;
}

export function cmdUninstall(opts: { settingsPath?: string; out?: (l: string) => void } = {}): UninstallReport {
  const out = opts.out ?? console.log;
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const { settings, raw } = loadSettings(settingsPath);
  const result = removeCockpitHooks(settings);
  saveSettings(settingsPath, result.settings);
  out(`cockpit-Hooks entfernt aus: ${result.removed.join(", ") || "(keine gefunden)"}`);

  const backupPath = `${settingsPath}.cockpit-backup`;
  let byteIdentical: boolean | null = null;
  if (existsSync(backupPath)) {
    byteIdentical = readFileSync(backupPath, "utf8") === readFileSync(settingsPath, "utf8");
    out(
      byteIdentical
        ? `settings.json entspricht byte-genau dem Backup (${backupPath}).`
        : `Hinweis: settings.json weicht vom Backup ab (eigene Änderungen seit init?). Backup bleibt: ${backupPath}`,
    );
  }
  out(`Die Datenbank bleibt erhalten: ${resolveDbPath()} — Löschen mit: cockpit purge`);
  out(`MCP-Deregistrierung (manuell): claude mcp remove --scope user cockpit`);
  if (raw === null) out("Hinweis: settings.json existierte vor init nicht.");
  return { settingsPath, removed: result.removed, byteIdentical };
}

export interface DoctorCheck {
  ok: boolean;
  label: string;
  fix: string;
}

// Standard-Fehlerbilder mit Fix-Befehl (PRD F8). Die spawn-basierten Checks
// (claude-Binary, MCP-Registrierung) laufen nur gegen die ECHTE Installation
// (kein settingsPath-Override) — Fixture-Läufe und der Web-Hot-Path bleiben
// schnell und deterministisch (gleiche D5-Disziplin wie init).
// deliveryChain (Setup-Verify): der Zustell-Selbsttest spawnt das Hook-Bundle
// und dauert kalt ~17 s — auf dem App-Start-Pfad zu teuer. Default folgt
// spawnChecks (Rückwärtskompatibilität für CLI-doctor); Setup schaltet ihn ab.
export function cmdDoctor(
  opts: { settingsPath?: string; spawnChecks?: boolean; deliveryChain?: boolean } = {},
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({
    ok: (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5),
    label: `Node ${process.version} (benötigt >= 22.5 für node:sqlite im Hook)`,
    fix: "Node aktualisieren: https://nodejs.org",
  });
  checks.push(checkFts5());
  checks.push(checkDbWritable());
  const bundle = hookBundleInstallPath();
  checks.push({
    ok: existsSync(bundle),
    label: `Hook-Bundle unter ${bundle}`,
    fix: "cockpit init ausführen",
  });
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  checks.push(checkHooksRegistered(settingsPath));
  checks.push(checkHooksNotDisabled(settingsPath));
  if (opts.spawnChecks ?? opts.settingsPath === undefined) {
    checks.push(checkClaudeBinary());
    checks.push(checkMcpRegistered());
    if (opts.deliveryChain ?? true) checks.push(checkDeliveryChain());
  }
  return checks;
}

// Zustell-Kette end-to-end (Zustell-Transparenz): spawnt das Hook-Bundle gegen
// eine Temp-DB und prüft Claim + Injektion. Gehört in den spawnChecks-Zweig
// (kein Web-Hot-Path); läuft ISOLIERT gegen %TEMP% (nie gegen die echte DB).
function checkDeliveryChain(): DoctorCheck {
  const r = runDeliverySelftest();
  return {
    ok: r.ok,
    label: r.ok
      ? `Zustell-Kette end-to-end (${r.ms} ms)${r.reason ? ` — ${r.reason}` : ""}`
      : `Zustell-Kette gestört: ${r.reason ?? "unbekannt"}`,
    fix: r.ok ? "" : "cockpit init ausführen und `claude` einmal starten; dann erneut prüfen",
  };
}

// disableAllHooks macht registrierte Hooks wirkungslos: keine Aufzeichnung,
// keine Antwort-Zustellung — für den Nutzer unsichtbar (Lücke 09.07.).
// Exportiert, damit die Web-UI ein Warnbanner zeigen kann.
export function hooksGloballyDisabled(settingsPath?: string): boolean {
  try {
    const { settings } = loadSettings(settingsPath ?? defaultSettingsPath());
    return (settings as { disableAllHooks?: boolean }).disableAllHooks === true;
  } catch {
    return false;
  }
}

function checkHooksNotDisabled(settingsPath: string): DoctorCheck {
  try {
    const disabled = hooksGloballyDisabled(settingsPath);
    return {
      ok: !disabled,
      label: disabled
        ? `disableAllHooks ist in ${settingsPath} gesetzt — Hooks sind registriert, aber WIRKUNGSLOS (keine Aufzeichnung, keine Antwort-Zustellung)`
        : "Hooks nicht global deaktiviert (disableAllHooks)",
      fix: `"disableAllHooks": true aus ${settingsPath} entfernen (oder in den Cockpit-Einstellungen aktivieren)`,
    };
  } catch {
    return { ok: true, label: "disableAllHooks-Prüfung übersprungen (settings.json nicht lesbar)", fix: "" };
  }
}

// Die KI-Funktionen (Karten-Einordnung, Briefing, Standup) spawnen das lokale
// `claude`-Binary — ohne dieses sieht der Nutzer nur Timeouts ohne Diagnose.
function checkClaudeBinary(): DoctorCheck {
  const res = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const version = (res.stdout ?? "").trim().split("\n")[0] ?? "";
  return {
    ok: res.status === 0,
    label:
      res.status === 0
        ? `KI erreichbar: claude ${version}`
        : "claude-Binary nicht erreichbar — KI-Funktionen (Einordnung, Briefing, Standup) zeigen nur Fehlerboxen; alles andere läuft weiter",
    fix: "Claude Code installieren (https://claude.com/claude-code), einmal `claude` starten und einloggen",
  };
}

function checkMcpRegistered(): DoctorCheck {
  const res = spawnSync("claude", ["mcp", "get", "cockpit"], {
    encoding: "utf8",
    timeout: 15_000,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return {
    ok: res.status === 0,
    label:
      res.status === 0
        ? "MCP-Server cockpit registriert (Agenten können Fragen in die Inbox legen)"
        : "MCP-Server cockpit NICHT registriert — Agenten können keine Fragen in die Inbox legen",
    fix: `Registrieren: ${mcpRegisterCommand()}`,
  };
}

function checkFts5(): DoctorCheck {
  try {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE f USING fts5(t)");
    db.close();
    return { ok: true, label: "SQLite mit FTS5 (better-sqlite3)", fix: "" };
  } catch (err) {
    return {
      ok: false,
      label: `FTS5 nicht verfügbar: ${String(err)}`,
      fix: "npm rebuild better-sqlite3 (oder Neuinstallation des Pakets)",
    };
  }
}

function checkDbWritable(): DoctorCheck {
  const dbPath = resolveDbPath();
  try {
    const store = Store.open(dbPath);
    store.rawDb().exec("BEGIN IMMEDIATE; ROLLBACK;");
    store.close();
    return { ok: true, label: `Datenbank beschreibbar: ${dbPath}`, fix: "" };
  } catch (err) {
    return {
      ok: false,
      label: `Datenbank nicht beschreibbar (${dbPath}): ${String(err)}`,
      fix: `Rechte auf ${cockpitHome()} prüfen; ggf. COCKPIT_DB setzen`,
    };
  }
}

function checkHooksRegistered(settingsPath: string): DoctorCheck {
  try {
    const { settings } = loadSettings(settingsPath);
    const status = hasCockpitHooks(settings);
    const missing = Object.entries(status)
      .filter(([, ok]) => !ok)
      .map(([event]) => event);
    return {
      ok: missing.length === 0,
      label:
        missing.length === 0
          ? `Hooks registriert in ${settingsPath}`
          : `Hooks fehlen in ${settingsPath}: ${missing.join(", ")}`,
      fix: "cockpit init ausführen",
    };
  } catch (err) {
    return {
      ok: false,
      label: `settings.json nicht lesbar (${settingsPath}): ${String(err)}`,
      fix: "Datei auf JSON-Syntaxfehler prüfen",
    };
  }
}

// Web-Einstellungen: disableAllHooks entfernen (der Banner-Klickpfad).
// Nutzt dieselbe settings.json-Chirurgie wie init/uninstall.
export function enableAllHooks(settingsPath?: string): { changed: boolean } {
  const path = settingsPath ?? defaultSettingsPath();
  const { settings } = loadSettings(path);
  const s = settings as { disableAllHooks?: boolean };
  if (s.disableAllHooks !== true) return { changed: false };
  delete s.disableAllHooks;
  saveSettings(path, settings);
  return { changed: true };
}

export function cmdPurge(opts: { project?: string } = {}): PurgeReport {
  const store = Store.open(resolveDbPath());
  try {
    return store.purge(opts.project);
  } finally {
    store.close();
  }
}
