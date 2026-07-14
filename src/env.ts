// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Env-Tab: Umgebungsvariablen je Projekt (+ global) verwalten. SICHERHEIT ist
// die Leitlinie dieses Moduls: geheime WERTE verlassen NIE die Platte in Richtung
// Browser (readEnvKeys liefert nur Namen + gesetzt/leer) und werden NIE in der
// DB gehalten (nur das nicht-geheime WARUM/WIE/WAS + Link, siehe store.ts). Der
// generische Datei-Viewer (config.ts) sperrt .env bewusst als Secret — dieser
// eng begrenzte Kanal ist die einzige Stelle, die .env liest/schreibt.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { normalizeProjectPath } from "./paths.js";
import type { EnvSpec, Store } from "./store.js";

// Gültiger Variablenname (POSIX-nah): Buchstabe/Unterstrich, dann Wort-Zeichen.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LEN = 128;
const MAX_VALUE_LEN = 8192;

export interface EnvSpecMeta {
  why: string;
  how: string;
  what: string;
  serviceLink: string;
  source: string;
}

export interface EnvVarView {
  key: string;
  present: boolean; // Schlüssel steht in der .env auf der Platte
  hasValue: boolean; // present UND nicht-leerer Wert (Wert selbst nie mitgeliefert)
  inExample: boolean; // Schlüssel steht in .env.example
  spec: EnvSpecMeta | null; // nicht-geheime Metadaten aus der DB
}

export interface EnvProjectView {
  projectPath: string; // '' = global
  label: string;
  envFile: string; // normalisierter Absolutpfad zur .env (muss nicht existieren)
  envExists: boolean;
  exampleExists: boolean;
  gitignore: { isRepo: boolean; ignored: boolean };
  vars: EnvVarView[];
}

export type EnvWriteResult =
  | { ok: true; file: string; created: boolean; backup: string | null }
  | { ok: false; status: number; error: string };

// --- Ziel-Auflösung (SICHER) ------------------------------------------------
// Der Client schickt IMMER nur einen Projekt-Selektor, nie einen Rohpfad. '' =
// global (~/.claude/.env, analog zur globalen CLAUDE.md). Sonst muss project ein
// bekanntes, erfasstes Projekt sein (DISTINCT project_path aus turns) — sonst
// null. Der Basename ist fest ".env", es kann also nur die jeweils eigene
// Umgebungsdatei getroffen werden.
// Wurzelverzeichnis, in dem die .env eines Projekts liegt ('' = global ->
// ~/.claude). Das ist die natürliche Einheit: .env, .env.example, .env-backups/
// und der Scan hängen alle daran; die Dateipfade sind davon abgeleitet.
function envRoot(projectPath: string): string {
  return projectPath || join(homedir(), ".claude");
}

// Wie envRoot, aber VALIDIEREND für Client-Eingaben: ein nicht-globales Projekt
// muss erfasst sein (DISTINCT project_path aus turns) — sonst null. Der Client
// schickt nur einen Selektor, nie einen Rohpfad.
export function resolveEnvProjectRoot(store: Store, project: string | undefined): string | null {
  if (!project) return envRoot("");
  const norm = normalizeProjectPath(project);
  const known = store.rawDb().prepare("SELECT 1 FROM turns WHERE project_path = ? LIMIT 1").get(norm);
  return known ? envRoot(norm) : null;
}

// Die .env-Datei des Projekts (fester Basename) — abgeleitet aus der Wurzel.
export function resolveEnvTarget(store: Store, project: string | undefined): string | null {
  const root = resolveEnvProjectRoot(store, project);
  return root ? join(root, ".env") : null;
}

// --- .env lesen (nur NAMEN, nie Werte) --------------------------------------

interface ParsedLine {
  key: string;
  hasValue: boolean;
}

// Eine .env-Zeile zerlegen: KEY=..., optional mit "export ". Kommentare/Leerzeilen
// ergeben null. Der Wert wird NUR auf "leer?" reduziert — nie zurückgegeben.
function parseEnvLine(line: string): ParsedLine | null {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (!m) return null;
  const rawValue = m[2]!.trim();
  const unquoted = rawValue.replace(/^["']|["']$/g, "").trim();
  return { key: m[1]!, hasValue: unquoted.length > 0 };
}

// Namen + gesetzt/leer aller Variablen einer .env. Liest die Datei, gibt aber
// GARANTIERT keinen Wert heraus (nur key + hasValue).
export function readEnvKeys(file: string): ParsedLine[] {
  if (!existsSync(file) || !statSync(file).isFile()) return [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const seen = new Map<string, boolean>();
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) seen.set(parsed.key, parsed.hasValue); // letzte Definition gewinnt (wie dotenv)
  }
  return [...seen.entries()].map(([key, hasValue]) => ({ key, hasValue }));
}

// --- .gitignore-Status + Ein-Klick-Fix --------------------------------------

export function gitignoreStatus(root: string): { isRepo: boolean; ignored: boolean } {
  // EIN git-Spawn statt zwei: check-ignore beendet mit 0 (ignoriert), 1 (im Repo,
  // nicht ignoriert) oder 128 (kein Repo). Der Exit-Code trägt beide Signale.
  try {
    execFileSync("git", ["check-ignore", "-q", "--", ".env"], { cwd: root, timeout: 3000, stdio: ["ignore", "ignore", "ignore"] });
    return { isRepo: true, ignored: true }; // Exit 0
  } catch (err) {
    return { isRepo: (err as { status?: number }).status === 1, ignored: false };
  }
}

const GITIGNORE_LINES = [".env", ".env-backups/"];

// .env (und die lokalen Backups) in die .gitignore aufnehmen. Idempotent: nur
// fehlende Zeilen werden angehängt; .env.example bleibt bewusst committbar.
export function addEnvToGitignore(root: string): { added: string[]; file: string } {
  const file = join(root, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return { added: [], file };
  const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(file, existing + prefix + "\n# cockpit: Secrets aus Git heraushalten\n" + missing.join("\n") + "\n", "utf8");
  return { added: missing, file };
}

// --- .env schreiben (write-only, mit Backup) --------------------------------

function formatEnvValue(value: string): string {
  // Unkritische Zeichen roh; alles andere doppelt gequotet (dotenv-kompatibel).
  if (/^[A-Za-z0-9_./:@%+-]*$/.test(value)) return value;
  return JSON.stringify(value); // escaped Anführungszeichen/Backslashes
}

// Eine KEY=value-Zeile in den bestehenden .env-Text einfügen/ersetzen, ohne
// andere Zeilen, Kommentare oder Reihenfolge zu verändern. Nicht vorhanden ->
// anhängen. Ein etwaiges "export "-Präfix der Zeile bleibt erhalten.
function upsertEnvLine(content: string, key: string, value: string): string {
  const formatted = formatEnvValue(value);
  const lines = content.split("\n");
  let replaced = false;
  const out = lines.map((line) => {
    const m = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && m[3] === key) {
      replaced = true;
      return `${m[1] ?? ""}${m[2] ?? ""}${key}=${formatted}`;
    }
    return line;
  });
  if (replaced) return out.join("\n");
  const needsNl = content.length > 0 && !content.endsWith("\n");
  return content + (needsNl ? "\n" : "") + `${key}=${formatted}\n`;
}

function backupEnv(root: string, envFile: string): string {
  const dir = join(root, ".env-backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, `${stamp}.env`);
  copyFileSync(envFile, dest);
  return normalizeProjectPath(dest);
}

// Genau EINE Variable in die echte .env schreiben. Validiert Name und Wert,
// sichert die Vorversion (timestamped, neben der Datei — von der gitignore-Fix
// abgedeckt) und legt die Datei bei Bedarf an. Der Wert wird NIE persistiert
// oder geloggt (der Aufrufer protokolliert nur den Namen).
export function writeEnvVar(store: Store, project: string, key: string, value: string): EnvWriteResult {
  if (!KEY_RE.test(key) || key.length > MAX_KEY_LEN) {
    return { ok: false, status: 400, error: "Ungültiger Variablenname (nur Buchstaben, Ziffern, Unterstrich; nicht mit Ziffer beginnend)." };
  }
  if (value.length > MAX_VALUE_LEN) return { ok: false, status: 413, error: "Wert zu lang (max. 8 KB)." };
  if (/[\r\n\0]/.test(value)) return { ok: false, status: 400, error: "Wert darf keine Zeilenumbrüche enthalten." };
  const dir = resolveEnvProjectRoot(store, project);
  if (!dir) return { ok: false, status: 400, error: "Unbekanntes Projekt." };
  const target = join(dir, ".env");
  const created = !existsSync(target);
  try {
    if (created) mkdirSync(dir, { recursive: true });
    const backup = created ? null : backupEnv(dir, target);
    const current = created ? "" : readFileSync(target, "utf8");
    writeFileSync(target, upsertEnvLine(current, key, value), "utf8");
    return { ok: true, file: normalizeProjectPath(target), created, backup };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Zusammenbau der Ansicht ------------------------------------------------

function mergeVars(
  envKeys: ParsedLine[],
  exampleKeys: string[],
  specs: Map<string, EnvSpecMeta>,
): EnvVarView[] {
  const present = new Map(envKeys.map((k) => [k.key, k.hasValue]));
  const example = new Set(exampleKeys);
  const all = new Set<string>([...present.keys(), ...example, ...specs.keys()]);
  return [...all].sort().map((key) => ({
    key,
    present: present.has(key),
    hasValue: present.get(key) ?? false,
    inExample: example.has(key),
    spec: specs.get(key) ?? null,
  }));
}

function projectView(projectPath: string, label: string, specList: EnvSpec[]): EnvProjectView {
  const root = envRoot(projectPath);
  const envFile = join(root, ".env");
  const exampleFile = join(root, ".env.example");
  const specs = new Map(
    specList.map((s) => [s.keyName, { why: s.why, how: s.how, what: s.what, serviceLink: s.serviceLink, source: s.source }]),
  );
  return {
    projectPath,
    label,
    envFile: normalizeProjectPath(envFile),
    envExists: existsSync(envFile),
    exampleExists: existsSync(exampleFile),
    gitignore: gitignoreStatus(root),
    vars: mergeVars(readEnvKeys(envFile), readEnvKeys(exampleFile).map((k) => k.key), specs),
  };
}

// Alle Projekte (+ global vorneweg) mit ihrer .env-Ansicht, optional auf ein
// Projekt gefiltert (wie configView). Die Metadaten kommen aus EINER Abfrage
// (nach Projekt gebündelt), nicht je Projekt einzeln. Scannt NICHT den Code —
// das macht der [Scan]-Knopf über /api/env-assist gezielt.
export function envView(store: Store, opts: { project?: string } = {}): EnvProjectView[] {
  const specsByProject = new Map<string, EnvSpec[]>();
  for (const s of store.listEnvSpecs()) {
    const bucket = specsByProject.get(s.projectPath);
    if (bucket) bucket.push(s);
    else specsByProject.set(s.projectPath, [s]);
  }
  const views: EnvProjectView[] = [];
  if (!opts.project) views.push(projectView("", "Global (~/.claude/.env)", specsByProject.get("") ?? []));
  for (const p of store.distinctProjectPaths(opts.project)) views.push(projectView(p, p, specsByProject.get(p) ?? []));
  return views;
}

// --- Code-Scan nach referenzierten Variablen (für den Haiku-Assist) ---------
// Deterministische Grep-Vorstufe: findet Namen, die im Code aus der Umgebung
// gelesen werden. Haiku annotiert sie danach nur (warum/wie/was + Link).

const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache", "vendor", ".env-backups"]);
const SCAN_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".php", ".java", ".rs", ".sh", ".yml", ".yaml", ".env", ".example"]);
const SCAN_MAX_FILES = 1500;
const SCAN_MAX_DEPTH = 8;
const SCAN_MAX_BYTES = 256 * 1024;

// process.env.X / process.env["X"] / import.meta.env.X / Deno.env.get("X") /
// os.environ["X"] / os.getenv("X") / ${X} in .env.example.
const REFERENCE_RES: RegExp[] = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /(?:Deno\.env\.get|os\.getenv)\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g,
  /os\.environ(?:\.get)?\[?\(?\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g,
];

function collectFromText(text: string, into: Set<string>): void {
  for (const re of REFERENCE_RES) {
    for (const m of text.matchAll(re)) if (m[1]) into.add(m[1]);
  }
  // .env.example listet Namen direkt (KEY=...): auch die aufnehmen.
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) into.add(parsed.key);
  }
}

export function scanEnvKeys(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const found = new Set<string>();
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || visited > SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited > SCAN_MAX_FILES) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name)) walk(p, depth + 1);
      } else if (e.isFile() && shouldScanFile(e.name)) {
        visited++;
        scanFileInto(p, found);
      }
    }
  };
  walk(root, 0);
  return [...found].sort();
}

function shouldScanFile(name: string): boolean {
  if (name.startsWith(".env")) return true; // .env, .env.example, .env.local …
  return SCAN_EXTS.has(extname(name).toLowerCase());
}

function scanFileInto(file: string, into: Set<string>): void {
  try {
    if (statSync(file).size > SCAN_MAX_BYTES) return;
    collectFromText(readFileSync(file, "utf8"), into);
  } catch {
    // unlesbare/zu große Datei überspringen — der Scan läuft weiter
  }
}
