// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Gedächtnis & Regeln (Config-Ansicht, cola2-Struktur beibehalten): je Projekt
// die CLAUDE.md mit Zeichen-Budget und Git-Diff (neue Einträge / Streichungen
// seit HEAD). Dazu der gehärtete Datei-Lesepfad für den internen Viewer.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
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

export function readViewerFile(store: Store, rawPath: string, project?: string): FileReadResult {
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
  // muss aus der Allowlist stammen; Sicherheitsgrenze bleibt der
  // inRoot-Check unten (decode→resolve→within-root, Auflage T5).
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
  const base = requested.split(sep).pop() ?? "";
  if (DENY_BASENAME.test(base)) return { ok: false, status: 403, error: "Datei ist gesperrt (Secrets)" };
  if (!existsSync(requested) || !statSync(requested).isFile()) {
    return { ok: false, status: 404, error: "Datei nicht gefunden" };
  }
  const size = statSync(requested).size;
  if (size > MAX_FILE_BYTES * 4) return { ok: false, status: 413, error: "Datei zu groß für den Viewer" };
  const buf = readFileSync(requested);
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, status: 415, error: "Binärdatei — kein Text-Viewer" };
  const truncated = buf.length > MAX_FILE_BYTES;
  return {
    ok: true,
    file: normalizeProjectPath(requested),
    content: buf.subarray(0, MAX_FILE_BYTES).toString("utf8"),
    truncated,
  };
}
