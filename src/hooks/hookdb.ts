// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// DB-Writer des Hook-Bundles: node:sqlite statt better-sqlite3 (D2), damit
// das esbuild-CJS zero-dependency nach ~/.cockpit/bin/ kopierbar ist.
// Identisches Schema/Pragmas wie db.ts — beide importieren schema.ts.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../ids.js";
import { normalizeProjectPath } from "../paths.js";
import {
  MIGRATIONS,
  PRAGMAS,
  SQL_CLAIM_ANSWERS,
  SQL_INSERT_EVENT,
  SQL_INSERT_TURN,
  SQL_SELECT_CAPTURE,
  SQL_UPSERT_GIT_STATE,
  eventInsertParams,
  gitStateParams,
  turnInsertParams,
  type ClaimedAnswer,
  type EventParamsInput,
  type GitStateInput,
} from "../schema.js";
import type { TranscriptTurn } from "../transcript.js";

export function openHookDb(filePath: string): DatabaseSync {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  for (const p of PRAGMAS) db.exec(`PRAGMA ${p}`);
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = row.user_version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function insertHookTurn(
  db: DatabaseSync,
  t: TranscriptTurn,
): { inserted: boolean; redactions: number } {
  const { params, redactions } = turnInsertParams({ ...t, projectPath: t.cwd });
  const res = db.prepare(SQL_INSERT_TURN).run(...params);
  const inserted = Number(res.changes) > 0;
  return { inserted, redactions: inserted ? redactions : 0 };
}

export function recordHookEvent(db: DatabaseSync, e: EventParamsInput): void {
  db.prepare(SQL_INSERT_EVENT).run(...eventInsertParams(e).params);
}

export function upsertGitState(db: DatabaseSync, g: GitStateInput): void {
  db.prepare(SQL_UPSERT_GIT_STATE).run(...gitStateParams(g));
}

// Zwilling zu store.claimHumanAnswers für node:sqlite (Hook-Bundle): atomares
// Beanspruchen unzugestellter menschlicher Antworten via SQL_CLAIM_ANSWERS.
export function claimHumanAnswers(db: DatabaseSync, project: string): ClaimedAnswer[] {
  return db
    .prepare(SQL_CLAIM_ANSWERS)
    .all(nowIso(), normalizeProjectPath(project)) as unknown as ClaimedAnswer[];
}

// Capture-Opt-out via DB (Paket 5): fehlender Eintrag ODER capture_enabled=1 →
// Aufzeichnung an. Der billige Datei-Opt-out (entry.ts) bleibt als Vor-DB-Guard.
export function captureEnabled(db: DatabaseSync, project: string): boolean {
  const row = db.prepare(SQL_SELECT_CAPTURE).get(normalizeProjectPath(project)) as
    | { capture_enabled: number }
    | undefined;
  return !row || row.capture_enabled !== 0;
}
