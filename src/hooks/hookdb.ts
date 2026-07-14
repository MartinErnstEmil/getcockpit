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
  SQL_INSERT_EVENT,
  SQL_INSERT_TURN,
  SQL_SELECT_CAPTURE,
  SQL_SELECT_GITMODE,
  SQL_SELECT_OFFERABLE,
  SQL_UPSERT_GIT_STATE,
  eventInsertParams,
  gitStateParams,
  recordOfferOn,
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

// Ein Angebot je (item, session) atomar vermerken (node:sqlite-Zwilling zu
// store.recordOffer). true = frisch (injizieren), false = schon angeboten (Dedup).
export function recordOffer(db: DatabaseSync, itemUuid: string, sessionId: string): boolean {
  return recordOfferOn(
    (sql, ...p) => db.prepare(sql).run(...p),
    (sql, ...p) => db.prepare(sql).get(...p) as { n: number } | undefined,
    itemUuid,
    sessionId,
    nowIso(),
  );
}

// PUSH v2 (Hook, node:sqlite): anbietbare menschliche Antworten auswählen und je
// (item, session) atomar ein Angebot vermerken. Gibt NUR die FRISCH angebotenen
// zurück (changes()=1) — genau die werden injiziert. Finalisiert NIE (delivered_at
// bleibt NULL; erst der ACK finalisiert). Verhindert Doppel-Injektion in dieselbe
// Session (Dedup) und Briefing∩Prompt-TOCTOU (atomares INSERT OR IGNORE).
export function offerHumanAnswers(db: DatabaseSync, project: string, sessionId: string): ClaimedAnswer[] {
  const rows = db.prepare(SQL_SELECT_OFFERABLE).all(normalizeProjectPath(project)) as unknown as ClaimedAnswer[];
  const fresh: ClaimedAnswer[] = [];
  for (const r of rows) {
    if (recordOffer(db, r.uuid, sessionId)) fresh.push(r);
  }
  return fresh;
}

// Capture-Opt-out via DB (Paket 5): fehlender Eintrag ODER capture_enabled=1 →
// Aufzeichnung an. Der billige Datei-Opt-out (entry.ts) bleibt als Vor-DB-Guard.
export function captureEnabled(db: DatabaseSync, project: string): boolean {
  const row = db.prepare(SQL_SELECT_CAPTURE).get(normalizeProjectPath(project)) as
    | { capture_enabled: number }
    | undefined;
  return !row || row.capture_enabled !== 0;
}

// Git-Modus lesen (Hook): fehlender Eintrag = 'advisory' (wie im Store).
export function gitMode(db: DatabaseSync, project: string): string {
  const row = db.prepare(SQL_SELECT_GITMODE).get(normalizeProjectPath(project)) as
    | { git_mode: string }
    | undefined;
  return row?.git_mode ?? "advisory";
}
