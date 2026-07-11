// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Backfill-Importer (PRD F1): streamt ~/.claude/projects/**/*.jsonl in die DB.
// Idempotent über Transcript-uuid (ADR-005); eine Transaktion pro Datei;
// Projektpfad ausschließlich aus dem cwd-Feld der Zeile (ADR-007).
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeProjectPath } from "./paths.js";
import { redactText } from "./redact.js";
import type { Store } from "./store.js";
import { createInternalSessionFilter, readTranscript, type TranscriptTurn } from "./transcript.js";

export interface BackfillOptions {
  projectsDir?: string;
  dryRun?: boolean;
  limit?: number;
  project?: string;
  onProgress?: (message: string) => void;
}

export interface BackfillReport {
  files: number;
  filesUnchanged: number;
  turnsInserted: number;
  duplicates: number;
  brokenLines: number;
  redactions: number;
  durationMs: number;
  dryRun: boolean;
}

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function listTranscriptFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  return entries
    .filter((e) => e.endsWith(".jsonl"))
    .map((e) => join(dir, e))
    .sort();
}

interface FileResult {
  turns: number;
  duplicates: number;
  broken: number;
  redactions: number;
}

export async function backfill(store: Store, opts: BackfillOptions = {}): Promise<BackfillReport> {
  const start = Date.now();
  const dir = opts.projectsDir ?? defaultProjectsDir();
  let files = listTranscriptFiles(dir);
  if (opts.limit != null) files = files.slice(0, opts.limit);
  const projectFilter = opts.project ? normalizeProjectPath(opts.project) : null;
  const report: BackfillReport = {
    files: 0,
    filesUnchanged: 0,
    turnsInserted: 0,
    duplicates: 0,
    brokenLines: 0,
    redactions: 0,
    durationMs: 0,
    dryRun: opts.dryRun === true,
  };
  for (const file of files) {
    const stat = statSync(file);
    const seen = store.getBackfillFile(file);
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) {
      report.filesUnchanged++;
      continue;
    }
    const res = await importFile(store, file, projectFilter, opts.dryRun === true);
    report.files++;
    report.turnsInserted += res.turns;
    report.duplicates += res.duplicates;
    report.brokenLines += res.broken;
    report.redactions += res.redactions;
    if (!opts.dryRun && !projectFilter) {
      store.upsertBackfillFile({
        path: file,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        turns: res.turns,
        skipped: res.broken,
        redactions: res.redactions,
      });
    }
    opts.onProgress?.(`${file}: ${res.turns} Turns, ${res.broken} Skips`);
  }
  if (!opts.dryRun && report.turnsInserted > 0) store.optimizeFts();
  report.durationMs = Date.now() - start;
  return report;
}

// Streaming-Parse außerhalb, synchroner Insert-Block innerhalb der
// Transaktion (better-sqlite3-Transaktionen sind synchron).
async function importFile(
  store: Store,
  file: string,
  projectFilter: string | null,
  dryRun: boolean,
): Promise<FileResult> {
  const res: FileResult = { turns: 0, duplicates: 0, broken: 0, redactions: 0 };
  const turns: TranscriptTurn[] = [];
  // Assist-Rauschfilter (Paket 0): interne `claude -p`-Spawn-Sessions gar
  // nicht erst erfassen. Frische Instanz je Datei — Transcripts sind session-rein.
  const internal = createInternalSessionFilter();
  for await (const parsed of readTranscript(file)) {
    if (parsed.kind === "broken") res.broken++;
    if (parsed.kind !== "turn") continue;
    if (!internal.keep(parsed.turn)) continue;
    if (projectFilter && normalizeProjectPath(parsed.turn.cwd) !== projectFilter) continue;
    turns.push(parsed.turn);
  }
  if (dryRun) {
    res.turns = turns.length;
    // Redactions MITZÄHLEN (nichts persistieren): Der Dry-Run ist das
    // Human-Gate "Report vor Import sichten" — ohne Zählung ist es blind
    // (live 2026-07-07: dry-run 0, Echtlauf 386).
    for (const t of turns) res.redactions += redactText(t.content).total;
    return res;
  }
  store.transaction(() => {
    for (const t of turns) {
      const { inserted, redactions } = store.insertTurn({
        uuid: t.uuid,
        sessionId: t.sessionId,
        projectPath: t.cwd,
        role: t.role,
        content: t.content,
        timestamp: t.timestamp,
        isSidechain: t.isSidechain,
        gitBranch: t.gitBranch ?? null,
      });
      if (inserted) {
        res.turns++;
        res.redactions += redactions;
      } else {
        res.duplicates++;
      }
    }
  });
  return res;
}
