// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Schema v1 (ADR-004) — treiberfrei, damit better-sqlite3 (CLI/MCP) und
// node:sqlite (Hook-Bundle, D2) exakt dieselben Migrationen ausführen.
import { newId, nowIso } from "./ids.js";
import { normalizeProjectPath } from "./paths.js";
import { redactText } from "./redact.js";

const FTS_TOKENIZER = `tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"`;

// Von beiden Treibern bei jedem Open gesetzt (ADR-003).
export const PRAGMAS: ReadonlyArray<string> = [
  "journal_mode = WAL",
  "busy_timeout = 5000",
  "synchronous = NORMAL",
  "foreign_keys = ON",
];

// Geteilte Insert-SQL: hookdb.ts (node:sqlite) und store.ts (better-sqlite3)
// dürfen nicht auseinanderdriften — ein Schlüssel, ein Statement (ADR-005).
export const SQL_INSERT_TURN = `INSERT OR IGNORE INTO turns
  (uuid, session_id, project_path, role, content, timestamp, is_sidechain, git_branch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export const SQL_INSERT_EVENT = `INSERT INTO events
  (uuid, event_type, session_id, project_path, payload_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

export const SQL_HAS_EVENT =
  "SELECT 1 FROM events WHERE event_type = ? AND session_id = ? LIMIT 1";

// Atomares Beanspruchen unzugestellter menschlicher Antworten (Paket 1):
// EIN Statement liest UND quittiert. SQLite (WAL) serialisiert Schreiber, also
// beansprucht genau eine Session jede Zeile — kein Doppel zwischen Briefing,
// On-the-fly-Injektion (Hook) und pickup_answers (MCP). Geteilt zwischen
// better-sqlite3 (Store, .all()) und node:sqlite (Hook) — beide unterstützen
// RETURNING. Parameter: [nowIso, normalizedProject].
export const SQL_CLAIM_ANSWERS = `UPDATE items SET delivered_at = ?
  WHERE (project_path = ? OR project_path IS NULL)
    AND status = 'answered' AND answered_by = 'human' AND delivered_at IS NULL
  RETURNING uuid, type, status, title, answer`;

// Rückgabeform von SQL_CLAIM_ANSWERS — treiberfrei, damit Store und Hook-Bundle
// (node:sqlite) denselben Typ teilen, ohne dass der Hook store.ts zieht.
export interface ClaimedAnswer {
  uuid: string;
  type: string;
  status: string;
  title: string;
  answer: string | null;
}

// Geteilte Parameter-Assemblierung zu den Insert-SQLs oben: Redaction,
// Pfad-Normalisierung und Spaltenreihenfolge existieren genau einmal —
// store.ts (better-sqlite3) und hookdb.ts (node:sqlite) liefern nur noch
// das treiberspezifische prepare/run.
export interface TurnParamsInput {
  uuid: string;
  sessionId: string;
  projectPath: string;
  role: string;
  content: string;
  timestamp: string;
  isSidechain?: boolean;
  gitBranch?: string | null;
}

export function turnInsertParams(t: TurnParamsInput): {
  params: Array<string | number | null>;
  redactions: number;
} {
  const red = redactText(t.content);
  return {
    params: [
      t.uuid,
      t.sessionId,
      normalizeProjectPath(t.projectPath),
      t.role,
      red.text,
      t.timestamp,
      t.isSidechain ? 1 : 0,
      t.gitBranch ?? null,
    ],
    redactions: red.total,
  };
}

export interface EventParamsInput {
  eventType: string;
  sessionId?: string;
  projectPath?: string;
  payload?: unknown;
}

export function eventInsertParams(e: EventParamsInput): {
  id: string;
  params: Array<string | null>;
} {
  const id = newId("e");
  return {
    id,
    params: [
      id,
      e.eventType,
      e.sessionId ?? null,
      e.projectPath != null ? normalizeProjectPath(e.projectPath) : null,
      e.payload != null ? JSON.stringify(e.payload) : null,
      nowIso(),
    ],
  };
}

// Nummerierte, transaktionale Migrationen; user_version = Index+1.
// Kein CREATE IF NOT EXISTS-Probing (ADR-004).
// EINGEFROREN (append-only): bestehende Einträge nie editieren — Bestands-DBs
// führen sie nicht erneut aus. Schema-Änderung = neue Migration anhängen;
// test/schema-freeze.test.ts erzwingt das per SHA-256.
export const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    git_branch TEXT
  );
  CREATE INDEX turns_project_time ON turns(project_path, timestamp);
  CREATE INDEX turns_session ON turns(session_id);

  CREATE VIRTUAL TABLE turns_fts USING fts5(
    content, content='turns', content_rowid='id', ${FTS_TOKENIZER}
  );
  CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER turns_au AFTER UPDATE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    priority TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    body TEXT,
    answer TEXT,
    anchor_file TEXT,
    anchor_line INTEGER,
    anchor_end_line INTEGER,
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'claude',
    session_id TEXT,
    parent_id TEXT,
    project_path TEXT,
    git_sha TEXT,
    git_branch TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    answered_at TEXT,
    -- 'human' | 'claude': das SessionStart-Briefing (F7) darf nur menschlich
    -- beantwortete Items zustellen.
    answered_by TEXT,
    done_at TEXT,
    delivered_at TEXT
  );
  CREATE INDEX items_status ON items(status);
  CREATE INDEX items_project ON items(project_path);

  CREATE VIRTUAL TABLE items_fts USING fts5(
    title, body, answer, content='items', content_rowid='id', ${FTS_TOKENIZER}
  );
  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, body, answer)
      VALUES (new.id, new.title, new.body, new.answer);
  END;
  CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, body, answer)
      VALUES ('delete', old.id, old.title, old.body, old.answer);
  END;
  CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, body, answer)
      VALUES ('delete', old.id, old.title, old.body, old.answer);
    INSERT INTO items_fts(rowid, title, body, answer)
      VALUES (new.id, new.title, new.body, new.answer);
  END;

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    project_path TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_type ON events(event_type);

  CREATE TABLE backfill_files (
    path TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    turns INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    redactions INTEGER NOT NULL
  );
  `,
  // v2 (PRD F10): Git-Delta als rebuildbarer Cache statt Live-Shellen von
  // 30 Repos pro status-Aufruf — der Stop-Hook aktualisiert opportunistisch.
  `
  CREATE TABLE git_state (
    project_path TEXT PRIMARY KEY,
    head_sha TEXT,
    branch TEXT,
    dirty_files INTEGER NOT NULL DEFAULT 0,
    last_commit_at TEXT,
    recent_commits TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  `,
  // v3 (Paket 5): Projekt-Verwaltung. EINE Tabelle trägt Capture-Opt-out (in der
  // DB statt Datei) UND Archiv-Zustand. Fehlender Eintrag = Default (Capture an,
  // nicht archiviert) — keine Backfill-Zeilen nötig.
  `
  CREATE TABLE project_settings (
    project_path TEXT PRIMARY KEY,
    capture_enabled INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  // v4 (Git-Modi): git_mode je Projekt. DEFAULT 'advisory' backfillt bestehende
  // project_settings-Zeilen — Bestandsprojekte verhalten sich danach exakt wie
  // heute (globale Advisory). Fehlt der ganze Eintrag, defaultet der Lesecode.
  `
  ALTER TABLE project_settings ADD COLUMN git_mode TEXT NOT NULL DEFAULT 'advisory';
  `,
];

// Geteilt zwischen Store (better-sqlite3) und Hook-Bundle (node:sqlite): Upsert
// der Projekt-Einstellungen und Lesen des Capture-Flags — ein Statement, eine
// Wahrheit (wie SQL_INSERT_TURN).
export const SQL_UPSERT_PROJECT_CAPTURE = `INSERT INTO project_settings
  (project_path, capture_enabled, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(project_path) DO UPDATE SET
    capture_enabled = excluded.capture_enabled, updated_at = excluded.updated_at`;

export const SQL_UPSERT_PROJECT_ARCHIVE = `INSERT INTO project_settings
  (project_path, archived_at, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(project_path) DO UPDATE SET
    archived_at = excluded.archived_at, updated_at = excluded.updated_at`;

// Capture-Flag lesen (Hook): fehlender Eintrag ODER capture_enabled=1 → an.
export const SQL_SELECT_CAPTURE = "SELECT capture_enabled FROM project_settings WHERE project_path = ?";

// Git-Modus upserten (Store) und lesen (Hook-Bundle, node:sqlite): wie
// SQL_UPSERT_PROJECT_CAPTURE — eine Wahrheit für beide Treiber. Fehlender
// Eintrag beim SELECT (kein Row) = Default 'advisory' im Lesecode.
export const SQL_UPSERT_PROJECT_GITMODE = `INSERT INTO project_settings
  (project_path, git_mode, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(project_path) DO UPDATE SET
    git_mode = excluded.git_mode, updated_at = excluded.updated_at`;

export const SQL_SELECT_GITMODE = "SELECT git_mode FROM project_settings WHERE project_path = ?";

// Geteilt zwischen Stop-Hook (node:sqlite) und Store (better-sqlite3) — wie
// SQL_INSERT_TURN: ein Statement, eine Parameter-Assemblierung.
export const SQL_UPSERT_GIT_STATE = `INSERT INTO git_state
  (project_path, head_sha, branch, dirty_files, last_commit_at, recent_commits, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_path) DO UPDATE SET
    head_sha = excluded.head_sha, branch = excluded.branch,
    dirty_files = excluded.dirty_files, last_commit_at = excluded.last_commit_at,
    recent_commits = excluded.recent_commits, updated_at = excluded.updated_at`;

export interface GitStateInput {
  projectPath: string;
  headSha: string | null;
  branch: string | null;
  dirtyFiles: number;
  lastCommitAt: string | null;
  recentCommits: Array<{ sha: string; at: string; subject: string }>;
}

export function gitStateParams(g: GitStateInput): Array<string | number | null> {
  return [
    normalizeProjectPath(g.projectPath),
    g.headSha,
    g.branch,
    g.dirtyFiles,
    g.lastCommitAt,
    JSON.stringify(g.recentCommits),
    nowIso(),
  ];
}
