// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Standup-Generator (PRD F11): deterministische Sammelphase, EIN gebündelter
// `claude -p`-Call übers bestehende Abo (--model-Pinning, harter Timeout),
// Source-Grounding-Validator, Degradation auf den Rohbericht. Halluzinierte
// Provenienz ist der eine vertrauenszerstörende Fehler dieses Produkts.
import { execFile } from "node:child_process";
import { normalizeProjectPath } from "./paths.js";
import type { Store } from "./store.js";
import { INTERNAL_MARKER } from "./transcript.js";

export const STANDUP_MODEL = process.env["COCKPIT_MODEL"] ?? "haiku";
export const STANDUP_TIMEOUT_MS = 60_000;
export const PAYLOAD_BUDGET_CHARS = 30_000;
const MIN_PROJECT_SHARE = 2_000;
const PROMPT_TRUNCATE = 300;

export interface StandupItemRef {
  id: string;
  type: string;
  status: string;
  title: string;
}

export interface StandupProject {
  projectPath: string;
  userPrompts: string[];
  commits: Array<{ sha: string; at: string; subject: string }>;
  newItems: StandupItemRef[];
  resolvedItems: StandupItemRef[];
  truncated: boolean;
}

export interface StandupData {
  since: string;
  generatedAt: string;
  projects: StandupProject[];
}

export interface StandupResult {
  report: string;
  // "llm" = geglättet + grounded; "raw" = deterministischer Fallback.
  mode: "llm" | "raw";
  strippedReferences: number;
  degradedBecause?: string;
}

// --- Sammelphase (deterministisch, < 2 s Budget) ---------------------------

export function collectStandupData(
  store: Store,
  opts: { since: string; project?: string; now?: string } = { since: "" },
): StandupData {
  const db = store.rawDb();
  const projectFilter = opts.project ? normalizeProjectPath(opts.project) : null;

  const turnRows = db
    .prepare(
      `SELECT project_path, role, content, timestamp FROM turns
       WHERE timestamp >= ? ${projectFilter ? "AND project_path = ?" : ""}
       ORDER BY timestamp ASC`,
    )
    .all(...(projectFilter ? [opts.since, projectFilter] : [opts.since])) as Array<{
    project_path: string;
    role: string;
    content: string;
    timestamp: string;
  }>;

  const itemRows = db
    .prepare(
      `SELECT uuid, type, status, title, project_path, created_at, updated_at FROM items
       WHERE updated_at >= ? ${projectFilter ? "AND (project_path = ? OR project_path IS NULL)" : ""}`,
    )
    .all(...(projectFilter ? [opts.since, projectFilter] : [opts.since])) as Array<{
    uuid: string;
    type: string;
    status: string;
    title: string;
    project_path: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const gitRows = db
    .prepare("SELECT project_path, recent_commits FROM git_state")
    .all() as Array<{ project_path: string; recent_commits: string }>;
  const gitByProject = new Map(
    gitRows.map((g) => [
      g.project_path,
      (JSON.parse(g.recent_commits) as StandupProject["commits"]).filter((c) => c.at >= opts.since),
    ]),
  );

  const byProject = new Map<string, StandupProject>();
  const proj = (p: string): StandupProject => {
    let entry = byProject.get(p);
    if (!entry) {
      entry = {
        projectPath: p,
        userPrompts: [],
        commits: gitByProject.get(p) ?? [],
        newItems: [],
        resolvedItems: [],
        truncated: false,
      };
      byProject.set(p, entry);
    }
    return entry;
  };

  for (const t of turnRows) {
    if (t.role !== "user") continue;
    proj(t.project_path).userPrompts.push(t.content.slice(0, PROMPT_TRUNCATE));
  }
  for (const i of itemRows) {
    const p = proj(i.project_path ?? "(global)");
    const ref: StandupItemRef = { id: i.uuid, type: i.type, status: i.status, title: i.title };
    if (i.created_at >= opts.since) p.newItems.push(ref);
    if ((i.status === "answered" || i.status === "done") && i.updated_at >= opts.since) {
      p.resolvedItems.push(ref);
    }
  }

  // Pro-Projekt-Fair-Share (Review-Befund): ein gesprächiges Projekt darf die
  // anderen nicht aus dem Bericht drängen — Kürzung wird sichtbar markiert.
  const projects = [...byProject.values()].sort((a, b) => a.projectPath.localeCompare(b.projectPath));
  const share = Math.max(MIN_PROJECT_SHARE, Math.floor(PAYLOAD_BUDGET_CHARS / Math.max(1, projects.length)));
  for (const p of projects) {
    let used = 0;
    const kept: string[] = [];
    for (const prompt of p.userPrompts) {
      if (used + prompt.length > share) {
        p.truncated = true;
        break;
      }
      used += prompt.length;
      kept.push(prompt);
    }
    p.userPrompts = kept;
  }

  return { since: opts.since, generatedAt: opts.now ?? new Date().toISOString(), projects };
}

// --- Rohbericht (Fallback UND Grounding-Basis) ------------------------------

export function renderRawReport(data: StandupData): string {
  const lines: string[] = [`# Standup seit ${data.since.slice(0, 10)}`, ""];
  if (data.projects.length === 0) {
    lines.push("Keine Aktivität im Zeitraum.");
    return lines.join("\n");
  }
  for (const p of data.projects) {
    lines.push(`## ${p.projectPath}`);
    if (p.commits.length > 0) {
      lines.push("Getan (Commits):");
      for (const c of p.commits) lines.push(`- ${c.sha.slice(0, 7)} ${c.subject} (${c.at.slice(0, 10)})`);
    }
    if (p.userPrompts.length > 0) {
      lines.push(`Gearbeitet an (${p.userPrompts.length} Prompts${p.truncated ? ", gekürzt" : ""}):`);
      for (const u of p.userPrompts.slice(0, 5)) lines.push(`- ${u.split("\n")[0]}`);
    }
    if (p.resolvedItems.length > 0) {
      lines.push("Entschieden/erledigt:");
      for (const i of p.resolvedItems) lines.push(`- ${i.id} [${i.type}] ${i.title}`);
    }
    const open = p.newItems.filter((i) => i.status === "new" || i.status === "in_progress");
    if (open.length > 0) {
      lines.push("Offen (wartet auf Mensch):");
      for (const i of open) lines.push(`- ${i.id} [${i.type}] ${i.title}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --- Source-Grounding (Pflicht, PRD F11) ------------------------------------
// Zitierte SHAs, Item-Ids und Daten werden gegen den deterministischen
// Payload geprüft; Unbelegtes wird ersetzt und gezählt — nicht erhofft.

export function allowedReferences(data: StandupData): {
  shas: Set<string>;
  itemIds: Set<string>;
  minDate: string;
  maxDate: string;
} {
  const shas = new Set<string>();
  const itemIds = new Set<string>();
  for (const p of data.projects) {
    for (const c of p.commits) {
      for (let len = 7; len <= c.sha.length; len++) shas.add(c.sha.slice(0, len));
    }
    for (const i of [...p.newItems, ...p.resolvedItems]) itemIds.add(i.id);
  }
  return {
    shas,
    itemIds,
    minDate: data.since.slice(0, 10),
    maxDate: data.generatedAt.slice(0, 10),
  };
}

// Lookbehind statt \b links: der Hex-Teil einer Item-Id ("i-eee907cecb")
// oder eines Bindestrich-Worts darf nie als SHA-Zitat gelten.
const SHA_RE = /(?<![\w-])[0-9a-f]{7,40}\b/g;
const ITEM_ID_RE = /\b(?:i-[0-9a-f]{6,12}|[a-z0-9]{8}-[a-z0-9]{6})\b/g;
const DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/g;

export function groundReport(report: string, data: StandupData): { text: string; stripped: number } {
  const allowed = allowedReferences(data);
  let stripped = 0;
  let text = report.replace(SHA_RE, (m) => {
    // Reine Zahlfolgen (z. B. "20260707") sind keine SHA-Zitate.
    if (!/[a-f]/.test(m)) return m;
    if (allowed.shas.has(m)) return m;
    stripped++;
    return "[unbelegte-ref]";
  });
  text = text.replace(ITEM_ID_RE, (m) => {
    if (allowed.itemIds.has(m)) return m;
    stripped++;
    return "[unbelegte-ref]";
  });
  text = text.replace(DATE_RE, (m) => {
    if (m >= allowed.minDate && m <= allowed.maxDate) return m;
    stripped++;
    return "[unbelegtes-datum]";
  });
  if (stripped > 0) {
    text += `\n\n_(${stripped} unbelegte Referenzen entfernt — Quellenpflicht ist Invariante.)_`;
  }
  return { text, stripped };
}

// --- LLM-Pfad (async, hart budgetiert, degradiert fail-open) ----------------

function buildPrompt(data: StandupData): string {
  return [
    // Marker (Paket 0): hält die Spawn-Session aus Verlauf/Report heraus.
    INTERNAL_MARKER,
    "Du schreibst einen Standup-Bericht für einen Entwickler über seine Claude-Code-Projekte.",
    "Erzeuge pro Projekt einen Abschnitt '## <projektname>' mit genau diesen Unterpunkten:",
    "**Getan** / **Entschieden** / **Offen (wartet auf dich)** / **Nächste Schritte**.",
    "Sei konkret und kurz. STRENGE QUELLENPFLICHT: Zitiere Commit-SHAs, Item-Ids und",
    "Daten AUSSCHLIESSLICH, wenn sie wörtlich in den DATEN unten vorkommen. Erfinde nichts.",
    "Antworte nur mit dem Markdown-Bericht, ohne Vor- oder Nachwort.",
    "",
    "DATEN (JSON):",
    JSON.stringify(data),
  ].join("\n");
}

// Test-Injektion: abweichendes Binary (z. B. Mock-Skript) statt `claude`.
export interface ClaudeCmd {
  cmd: string;
  baseArgs: string[];
}

export interface RunStandupOptions {
  since: string;
  project?: string;
  noLlm?: boolean;
  claudeCmd?: ClaudeCmd;
  timeoutMs?: number;
}

// In Prompts fließt beeinflussbarer Text (Turns, Item-Bodies) — der Spawn
// bekommt deshalb KEINE Werkzeuge (Review SCHARF-1): sonst könnte eine
// Injection im Item-Text den Assist Dateien lesen lassen.
const NO_TOOLS_ARGS: ReadonlyArray<string> = [
  "--disallowedTools",
  "Bash,Read,Glob,Grep,LS,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite,KillShell,BashOutput",
];

// Geteilter LLM-Aufruf (Standup F11, Assists): ein Muster für Spawn, stdin,
// Timeout-Kill und Fehlerklassifikation — kein zweiter Spawn-Pfad im Repo.
export function runClaude(
  prompt: string,
  opts: { claudeCmd?: ClaudeCmd; timeoutMs?: number; allowWebSearch?: boolean } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  // Standardpfad ohne Werkzeuge (SCHARF-1). Der CLAUDE.md-Budget-Check
  // (Nachtrag 10.07.) braucht EXPLIZIT WebSearch — der Prompt trägt dort keinen
  // beeinflussbaren Text, daher unbedenklich. shell:true auf Windows bleibt
  // erhalten, weil weiterhin der Default-cmd genutzt wird.
  const defaultArgs = opts.allowWebSearch
    ? ["-p", "--model", STANDUP_MODEL, "--allowedTools", "WebSearch"]
    : ["-p", "--model", STANDUP_MODEL, ...NO_TOOLS_ARGS];
  const cmd = opts.claudeCmd ?? { cmd: "claude", baseArgs: defaultArgs };
  return new Promise((resolve) => {
    // Prompt IMMER über stdin: als argv reißt der 30k-Payload das Windows-
    // Kommandozeilen-Limit ("Die Befehlszeile ist zu lang", live 2026-07-07).
    const child = execFile(
      cmd.cmd,
      cmd.baseArgs,
      {
        encoding: "utf8",
        timeout: opts.timeoutMs ?? STANDUP_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        shell: process.platform === "win32" && !opts.claudeCmd,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: err.killed ? "timeout" : err.message });
        if (!stdout.trim()) return resolve({ ok: false, reason: "leere Ausgabe" });
        resolve({ ok: true, stdout });
      },
    );
    child.stdin?.on("error", () => {
      // EPIPE, wenn das Binary sofort stirbt — der execFile-Callback meldet den Fehler.
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

// Der Bericht muss die Projektstruktur tragen, sonst gilt er als unparsebar.
function looksLikeReport(text: string, data: StandupData): boolean {
  if (data.projects.length === 0) return text.trim().length > 0;
  return text.includes("##");
}

export async function runStandup(store: Store, opts: RunStandupOptions): Promise<StandupResult> {
  const data = collectStandupData(store, { since: opts.since, project: opts.project });
  const raw = renderRawReport(data);
  if (opts.noLlm || data.projects.length === 0) {
    return { report: raw, mode: "raw", strippedReferences: 0 };
  }
  const res = await runClaude(buildPrompt(data), opts);
  if (!res.ok) {
    return { report: raw, mode: "raw", strippedReferences: 0, degradedBecause: res.reason };
  }
  if (!looksLikeReport(res.stdout, data)) {
    return { report: raw, mode: "raw", strippedReferences: 0, degradedBecause: "unparsebare Ausgabe" };
  }
  const grounded = groundReport(res.stdout.trim(), data);
  return { report: grounded.text, mode: "llm", strippedReferences: grounded.stripped };
}

// "1d"/"7d"/"yesterday"/ISO → ISO-Zeitpunkt. Default des CLI: 1d.
export function parseSince(input: string, now = Date.now()): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "yesterday" || trimmed === "gestern") return new Date(now - 86_400_000).toISOString();
  const rel = /^(\d+)d$/.exec(trimmed);
  if (rel) return new Date(now - Number(rel[1]) * 86_400_000).toISOString();
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) throw new Error(`Ungültiges --since: "${input}" (erlaubt: 7d, yesterday, ISO-Datum)`);
  return new Date(parsed).toISOString();
}
