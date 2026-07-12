// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Gedächtnis & Regeln (Config-Ansicht, cola2-Struktur beibehalten): je Projekt
// die CLAUDE.md mit Zeichen-Budget und Git-Diff (neue Einträge / Streichungen
// seit HEAD). Dazu der gehärtete Datei-Lesepfad für den internen Viewer.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { cockpitHome, normalizeProjectPath } from "./paths.js";
import type { Store } from "./store.js";

// TODO: Budget-Zahl mit dem Nutzer bestätigen — cola2 hatte kein dokumentiertes
// Limit; 10k Zeichen ist der Startwert, per Env übersteuerbar.
export function claudeMdBudget(): number {
  const env = Number(process.env["COCKPIT_CLAUDEMD_BUDGET"]);
  return Number.isFinite(env) && env > 0 ? env : 10_000;
}

export interface ConfigDiff {
  added: string[];
  removed: string[];
  // true = Datei ist nicht in Git erfasst (alles zählt als neu) oder kein Repo.
  untracked: boolean;
}

export interface ConfigEntry {
  label: string;
  projectPath: string | null; // null = global (~/.claude/CLAUDE.md)
  file: string;
  exists: boolean;
  chars: number;
  budget: number;
  remaining: number; // negativ = über Budget
  diff: ConfigDiff | null; // null = kein Diff ermittelbar
}

function gitDiffLines(cwd: string, file: string): ConfigDiff | null {
  const run = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const tracked = run(["ls-files", "--", file]).trim() !== "";
    if (!tracked) return { added: [], removed: [], untracked: true };
    const out = run(["diff", "--no-color", "--unified=0", "HEAD", "--", file]);
    const added: string[] = [];
    const removed: string[] = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
      else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
    }
    return { added, removed, untracked: false };
  } catch {
    return null; // kein Repo / kein git — Ansicht zeigt dann nur das Budget
  }
}

function entryFor(label: string, projectPath: string | null, file: string): ConfigEntry {
  const budget = claudeMdBudget();
  let chars = 0;
  const exists = existsSync(file);
  if (exists) {
    try {
      chars = readFileSync(file, "utf8").length;
    } catch {
      // unlesbar behandeln wie leer; exists bleibt true
    }
  }
  const cwd = projectPath ?? join(homedir(), ".claude");
  return {
    label,
    projectPath,
    file: normalizeProjectPath(file),
    exists,
    chars,
    budget,
    remaining: budget - chars,
    diff: exists ? gitDiffLines(cwd, file) : null,
  };
}

// Alle bekannten Projekte = DISTINCT project_path aus turns (dieselbe Quelle
// wie portfolioView) — optional auf ein Projekt gefiltert.
export function configView(store: Store, opts: { project?: string } = {}): ConfigEntry[] {
  const db = store.rawDb();
  const filter = opts.project ? normalizeProjectPath(opts.project) : null;
  const rows = db
    .prepare("SELECT DISTINCT project_path FROM turns ORDER BY project_path")
    .all() as Array<{ project_path: string }>;
  const entries: ConfigEntry[] = [
    entryFor("Global (~/.claude/CLAUDE.md)", null, join(homedir(), ".claude", "CLAUDE.md")),
  ];
  for (const r of rows) {
    if (filter && r.project_path !== filter) continue;
    entries.push(entryFor(r.project_path, r.project_path, join(r.project_path, "CLAUDE.md")));
  }
  return entries;
}

// Ziel-CLAUDE.md für den Baukasten-Apply (U6) SICHER auflösen: der Client
// schickt NIE einen Rohpfad, sondern nur einen Projekt-Selektor. "" = global
// (~/.claude/CLAUDE.md); sonst muss project ein bekanntes, erfasstes Projekt
// sein (DISTINCT project_path aus turns) — sonst null. Der Basename ist fest
// "CLAUDE.md", also kann nur die jeweils eigene Config geschrieben werden.
export function resolveClaudeMdTarget(store: Store, project: string | undefined): string | null {
  if (!project) return join(homedir(), ".claude", "CLAUDE.md");
  const norm = normalizeProjectPath(project);
  const known = store
    .rawDb()
    .prepare("SELECT 1 FROM turns WHERE project_path = ? LIMIT 1")
    .get(norm);
  return known ? join(norm, "CLAUDE.md") : null;
}

// --- Interner Datei-Viewer (Vorstufe) ---------------------------------------
// Nur Dateien UNTER bekannten Wurzeln (erfasste Projekte, ~/.claude, ~/.cockpit)
// sind lesbar; Secret-artige Basenamen sind gesperrt. Textdateien bis 512 KB.

const DENY_BASENAME = /^\.env(\..*)?$|credential|secret|id_rsa|id_ed25519|\.pem$|^web-token$/i;
const MAX_FILE_BYTES = 512 * 1024;

export type FileReadResult =
  | { ok: true; file: string; content: string; truncated: boolean }
  | { ok: false; status: number; error: string };

// Gemeinsame, gehärtete Pfad-Auflösung für Lesen UND Schreiben: Allowlist-
// Wurzeln, Anker für Relativpfade, decode→resolve→within-root (Auflage T5),
// Secret-Sperre. KEINE Existenz- und KEINE toleranten-Fallback-Entscheidung —
// die trifft der Aufrufer (Lesen darf fuzzy nachschlagen, Schreiben NIE).
type ResolveResult =
  | { ok: true; requested: string; roots: string[] }
  | { ok: false; status: number; error: string };

function resolveTargetPath(store: Store, rawPath: string, project?: string): ResolveResult {
  const db = store.rawDb();
  // Wurzeln aus turns UND items: ein Projekt kann Items tragen, ohne dass je
  // ein Turn erfasst wurde (z. B. nur MCP-Zugriffe) — dessen Datei-Links
  // wären sonst grundsätzlich tot.
  const roots = (
    db
      .prepare(
        `SELECT DISTINCT project_path FROM turns
         UNION SELECT DISTINCT project_path FROM items WHERE project_path IS NOT NULL`,
      )
      .all() as Array<{ project_path: string }>
  ).map((r) => resolve(r.project_path));
  roots.push(resolve(join(homedir(), ".claude")), resolve(cockpitHome()));

  // Relativpfade (aus Item-Texten verlinkt) gegen die mitgegebene Projekt-
  // wurzel ankern — resolve() allein ankert an der Server-cwd und liefert
  // dann 404 bzw. bei Namenskollision still die falsche Datei. Die Wurzel
  // muss aus der Allowlist stammen; Sicherheitsgrenze bleibt der inRoot-Check.
  let anchored = rawPath;
  if (!isAbsolute(rawPath) && project) {
    const root = resolve(normalizeProjectPath(project));
    const rootCmp = root.toLowerCase();
    if (!roots.some((r) => r.toLowerCase() === rootCmp)) {
      return { ok: false, status: 400, error: "Unbekanntes Projekt für Relativpfad" };
    }
    anchored = join(root, rawPath);
  }
  const requested = resolve(anchored);
  // Windows-Pfade sind case-insensitiv: DB-Wurzeln sind normalisiert (c:/…),
  // homedir() liefert C:\… — der Prefix-Vergleich muss beides matchen.
  const reqCmp = requested.toLowerCase();
  const inRoot = roots.some((root) => {
    const rootCmp = root.toLowerCase();
    return reqCmp === rootCmp || reqCmp.startsWith(rootCmp + sep);
  });
  if (!inRoot) return { ok: false, status: 403, error: "Pfad liegt außerhalb der erfassten Projekte" };
  if (DENY_BASENAME.test(basename(requested))) {
    return { ok: false, status: 403, error: "Datei ist gesperrt (Secrets)" };
  }
  return { ok: true, requested, roots };
}

export function readViewerFile(store: Store, rawPath: string, project?: string): FileReadResult {
  const r = resolveTargetPath(store, rawPath, project);
  if (!r.ok) return r;
  const { requested, roots } = r;
  const reqCmp = requested.toLowerCase();
  const base = basename(requested);
  let target = requested;
  if (!existsSync(target) || !statSync(target).isFile()) {
    // Tolerante Auflösung: Item-Texte speichern Pfade, die veralten, sobald
    // ein Repo umgeräumt wird — die Karten selbst bleiben aber stehen. Statt
    // die Historie zu patchen, sucht der Viewer den Basenamen unterhalb der
    // Anker-Wurzel; GENAU EIN Treffer wird serviert (Ambiguität bleibt 404,
    // nie stilles Raten). Sicherheitsgrenzen unverändert: die Suche startet
    // in einer Allowlist-Wurzel und der Deny-Check lief bereits auf dem Basenamen.
    // Die SPEZIFISCHSTE (längste) passende Wurzel, nicht die erste: die
    // Allowlist enthält auch übergeordnete Projekte (z. B. c:/dev neben
    // c:/dev/repo) — von dort aus wäre die Suche teuer und fände Kopien
    // desselben Basenamens in Nachbarprojekten (Mehrdeutigkeit -> 404).
    const searchRoot = roots
      .filter((r) => {
        const rc = r.toLowerCase();
        return reqCmp === rc || reqCmp.startsWith(rc + sep);
      })
      .sort((a, b) => b.length - a.length)[0];
    const found = searchRoot ? findUniqueByBasename(searchRoot, base) : null;
    if (!found) {
      return { ok: false, status: 404, error: "Datei nicht gefunden (auch nicht unter neuem Ort — verschoben oder gelöscht?)" };
    }
    target = found;
  }
  const size = statSync(target).size;
  if (size > MAX_FILE_BYTES * 4) return { ok: false, status: 413, error: "Datei zu groß für den Viewer" };
  const buf = readFileSync(target);
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, status: 415, error: "Binärdatei — kein Text-Viewer" };
  const truncated = buf.length > MAX_FILE_BYTES;
  return {
    ok: true,
    file: normalizeProjectPath(target),
    content: buf.subarray(0, MAX_FILE_BYTES).toString("utf8"),
    truncated,
  };
}

// Toolchain-Config, die Cockpit/Claude selbst pflegen: über den Editor
// gesperrt, weil ein kaputter Edit (malformed JSON) die Installation lahmlegt
// — dafür gibt es cockpit init/uninstall bzw. `claude mcp`. Nur WRITE-seitig;
// Lesen bleibt erlaubt.
const WRITE_DENY_BASENAME = /^settings\.json$|^settings\.local\.json$|^\.claude\.json$/i;
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MB — ein Editor-Save, kein Bulk-Dump

// Datei-Editor (PO 12.07.): eine im Viewer angezeigte Datei überschreiben.
// Sicherheit wie beim Lesen (Allowlist, Secret-Sperre, Traversal), PLUS:
// KEIN toleranter Basename-Fallback (nie eine fuzzy-aufgelöste falsche Datei
// überschreiben — der Client schickt den aufgelösten Absolutpfad zurück),
// nur EXISTIERENDE Textdateien (kein Anlegen), Toolchain-Config gesperrt,
// Vorversion als Backup nach ~/.cockpit/file-backups (außerhalb der Projekt-
// ordner, damit nichts versehentlich commitet wird).
export function writeViewerFile(
  store: Store,
  rawPath: string,
  project: string | undefined,
  content: string,
): FileReadResult {
  const r = resolveTargetPath(store, rawPath, project);
  if (!r.ok) return r;
  const target = r.requested;
  if (WRITE_DENY_BASENAME.test(basename(target))) {
    return { ok: false, status: 403, error: "Diese Datei pflegt Cockpit/Claude selbst — über den Editor gesperrt (settings.json u. ä.)." };
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return { ok: false, status: 404, error: "Datei existiert nicht (Anlegen über den Viewer ist nicht möglich)." };
  }
  if (content.includes(String.fromCharCode(0))) return { ok: false, status: 415, error: "Binärinhalt nicht erlaubt." };
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    return { ok: false, status: 413, error: "Inhalt zu groß (max. 2 MB)." };
  }
  try {
    const backupDir = join(cockpitHome(), "file-backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(target, join(backupDir, `${stamp}__${basename(target).replace(/[^\w.-]/g, "_")}.bak`));
  } catch {
    // Backup ist ein Sicherheitsnetz, kein Muss — ein Fehler hier (z. B. Rechte)
    // darf das vom Nutzer ausdrücklich gewollte Speichern nicht blockieren.
  }
  writeFileSync(target, content, "utf8");
  return { ok: true, file: normalizeProjectPath(target), content, truncated: false };
}

// Begrenzte Basename-Suche unter einer Allowlist-Wurzel: liefert den Pfad nur
// bei GENAU EINEM Treffer, sonst null (Mehrdeutigkeit darf nie stilles Raten
// werden). Schranken halten den Worst Case klein: bekannte Bau-/Dep-Ordner
// werden übersprungen, Tiefe und Verzeichniszahl sind gedeckelt.
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "local_cache", ".smriti", ".backup"]);
const SEARCH_MAX_DEPTH = 7;
const SEARCH_MAX_DIRS = 2000;

function findUniqueByBasename(root: string, base: string): string | null {
  const baseCmp = base.toLowerCase();
  const hits: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (hits.length > 1 || depth > SEARCH_MAX_DEPTH || ++visited > SEARCH_MAX_DIRS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unlesbares Verzeichnis überspringen, kein Abbruch der Suche
    }
    for (const e of entries) {
      if (hits.length > 1) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, depth + 1);
      } else if (e.isFile() && basename(e.name).toLowerCase() === baseCmp) {
        hits.push(p);
      }
    }
  };
  walk(root, 0);
  return hits.length === 1 ? hits[0]! : null;
}
