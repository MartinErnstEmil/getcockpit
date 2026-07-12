// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Item-Datenmodell konzeptionell aus dev/cola schema.ts (ursprünglich MIT,
// (c) 2026, relizenziert durch denselben Rechteinhaber) — ohne escalated_*,
// order_index, Composer-/Statement-Tabellen (ADR-004).
import type { Database, Statement } from "better-sqlite3";
import { openDb } from "./db.js";
import { newId, nowIso } from "./ids.js";
import { normalizeProjectPath, resolveDbPath } from "./paths.js";
import { redactText } from "./redact.js";
import { isInternalSession } from "./transcript.js";
import {
  SQL_CLAIM_ANSWERS,
  SQL_HAS_EVENT,
  SQL_INSERT_EVENT,
  SQL_INSERT_TURN,
  SQL_UPSERT_GIT_STATE,
  SQL_UPSERT_PROJECT_ARCHIVE,
  SQL_UPSERT_PROJECT_CAPTURE,
  eventInsertParams,
  gitStateParams,
  turnInsertParams,
  type ClaimedAnswer,
  type GitStateInput,
  type TurnParamsInput,
} from "./schema.js";

// Git-Tab: eine Zeile je Projekt aus dem git_state-Cache (Stop-Hook füllt ihn
// opportunistisch; /api/git-refresh aktualisiert gezielt live).
export interface GitStateRow {
  projectPath: string;
  headSha: string | null;
  branch: string | null;
  dirtyFiles: number;
  lastCommitAt: string | null;
  recentCommits: Array<{ sha: string; at: string; subject: string }>;
  updatedAt: string;
}

export interface ProjectSetting {
  projectPath: string;
  captureEnabled: boolean;
  archivedAt: string | null;
  updatedAt: string;
}

export interface ProjectAdmin {
  projectPath: string;
  captureEnabled: boolean;
  archived: boolean;
  lastActivity: string | null;
  turns: number;
  openItems: number;
}

export const ITEM_TYPES = ["question", "proposal", "decision", "result", "blocker", "fyi"] as const;
export const ITEM_STATUSES = ["new", "in_progress", "answered", "postponed", "rejected", "done"] as const;
export const ITEM_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
// Wer geantwortet hat — das Briefing (F7) hängt an answered_by = 'human'.
export const ANSWER_SOURCES = ["human", "claude"] as const;

// Enum-Validierung lebt hier, weil ALLE Eintrittspunkte (CLI, MCP, Web)
// durch den Store laufen; das DB-Schema hat keine CHECK-Constraints.
function assertOneOf(field: string, value: string, allowed: ReadonlyArray<string>): void {
  if (!allowed.includes(value)) {
    throw new Error(`Ungültiger Wert für ${field}: "${value}" (erlaubt: ${allowed.join(", ")})`);
  }
}

export interface Anchor {
  file: string;
  line?: number;
  endLine?: number;
}

export interface Item {
  id: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  body?: string;
  answer?: string;
  anchor?: Anchor;
  tags: string[];
  source: string;
  sessionId?: string;
  parentId?: string;
  projectPath?: string;
  gitSha?: string;
  gitBranch?: string;
  createdAt: string;
  updatedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  doneAt?: string;
  deliveredAt?: string;
  // Projektspezifische laufende Nummer (#1 = ältestes Item des Projekts).
  // Berechnet beim Lesen (ROW_NUMBER über die volle Partition, keine Spalte);
  // purge eines Projekts nummeriert neu — für die Anzeige akzeptiert.
  projectSeq?: number;
}

export interface NewItem {
  type: string;
  title: string;
  priority?: string;
  status?: string;
  body?: string;
  anchor?: Anchor;
  tags?: string[];
  source?: string;
  sessionId?: string;
  parentId?: string;
  projectPath?: string;
  gitSha?: string;
  gitBranch?: string;
}

export interface ItemPatch {
  status?: string;
  priority?: string;
  title?: string;
  body?: string;
  answer?: string;
  answeredBy?: string;
  tags?: string[];
  anchor?: Anchor;
  deliveredAt?: string;
}

export interface ItemFilter {
  status?: string;
  type?: string;
  priority?: string;
  project?: string;
  tag?: string;
  updatedSince?: string;
  answeredBy?: string;
  limit?: number;
}

export interface ItemSearchOpts {
  types?: string[];
  // undefined = kein Projektfilter; gesetzt = nur dieses Projekt + globale Items.
  project?: string;
  status?: string;
  since?: string;
  limit?: number;
}

export interface TurnListOpts {
  project?: string;
  role?: string;
  since?: string;
  limit?: number;
}

export interface TurnRow {
  uuid: string;
  sessionId: string;
  projectPath: string;
  role: string;
  content: string;
  timestamp: string;
}

// Identisch zur Parameter-Assemblierung in schema.ts — ein Shape, ein Name.
export type TurnInput = TurnParamsInput;

// Verlauf-Tab: eine Zeile je Session bzw. je Turn der Raw-Ansicht.
export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  firstAt: string;
  lastAt: string;
  turns: number;
  firstPrompt: string | null;
}

export interface SessionTurn {
  uuid: string;
  sessionId: string;
  projectPath: string;
  role: string;
  content: string;
  timestamp: string;
  isSidechain: boolean;
  truncated: boolean;
}

// Verlauf B (Meilensteine): Ereignisse, die WÄHREND einer Session im selben
// Projekt entstanden — zeitlich zwischen die Wortmeldungen eingewoben.
export interface SessionMarker {
  kind: "decision" | "item" | "commit";
  at: string;
  title: string;
  itemId?: string;
  itemType?: string;
  sha?: string;
  branch?: string | null;
}

// Raw-Turns sind zum Lesen gekappt; Voll-Text liefert die Suche.
const SESSION_TURN_MAX_CHARS = 6_000;

export interface InsertTurnResult {
  inserted: boolean;
  redactions: number;
}

export interface PurgeReport {
  turns: number;
  items: number;
  events: number;
}

export interface TurnHit {
  uuid: string;
  sessionId: string;
  projectPath: string;
  role: string;
  timestamp: string;
  snippet: string;
  score: number;
}

export interface ItemHit {
  id: string;
  type: string;
  status: string;
  title: string;
  projectPath: string | null;
  createdAt: string;
  snippet: string;
  score: number;
}

export interface TurnSearchOpts {
  project?: string;
  since?: string;
  role?: string;
  limit?: number;
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '""');
}

// FTS5-Query-Aufbau (PRD F2): Terme einzeln gequotet, implizites AND.
function termQuery(q: string): string | null {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${escapeQuotes(t)}"`).join(" ");
}

function phraseQuery(q: string): string {
  return `"${escapeQuotes(q.trim())}"`;
}

interface ItemRow {
  uuid: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  body: string | null;
  answer: string | null;
  anchor_file: string | null;
  anchor_line: number | null;
  anchor_end_line: number | null;
  tags: string;
  source: string;
  session_id: string | null;
  parent_id: string | null;
  project_path: string | null;
  git_sha: string | null;
  git_branch: string | null;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
  answered_by: string | null;
  done_at: string | null;
  delivered_at: string | null;
  project_seq?: number;
}

function rowToItem(r: ItemRow): Item {
  const anchor: Anchor | undefined = r.anchor_file
    ? {
        file: r.anchor_file,
        ...(r.anchor_line != null ? { line: r.anchor_line } : {}),
        ...(r.anchor_end_line != null ? { endLine: r.anchor_end_line } : {}),
      }
    : undefined;
  return {
    id: r.uuid,
    type: r.type,
    status: r.status,
    priority: r.priority,
    title: r.title,
    body: r.body ?? undefined,
    answer: r.answer ?? undefined,
    anchor,
    tags: JSON.parse(r.tags) as string[],
    source: r.source,
    sessionId: r.session_id ?? undefined,
    parentId: r.parent_id ?? undefined,
    projectPath: r.project_path ?? undefined,
    gitSha: r.git_sha ?? undefined,
    gitBranch: r.git_branch ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    answeredAt: r.answered_at ?? undefined,
    answeredBy: r.answered_by ?? undefined,
    doneAt: r.done_at ?? undefined,
    deliveredAt: r.delivered_at ?? undefined,
    projectSeq: r.project_seq ?? undefined,
  };
}

// Sequenznummern-CTE: nummeriert IMMER über die volle Partition (alle Items
// eines Projekts, NULL = global), bevor WHERE/LIMIT greifen — sonst würde nur
// der geladene Ausschnitt nummeriert. Sortierordnung (created_at, id) ist
// immutabel, die Nummern sind damit stabil, solange nichts gelöscht wird.
const SEQ_CTE = `WITH seq AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY created_at, id) AS project_seq
  FROM items
)`;


export class Store {
  // better-sqlite3 cached .prepare() nicht; insertTurn läuft im Backfill
  // millionenfach — einmal pro SQL-Text vorbereiten.
  private readonly stmts = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private prep(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  static open(filePath: string = resolveDbPath()): Store {
    return new Store(openDb(filePath));
  }

  rawDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- Turns ---------------------------------------------------------------

  insertTurn(t: TurnInput): InsertTurnResult {
    const { params, redactions } = turnInsertParams(t);
    const res = this.prep(SQL_INSERT_TURN).run(...params);
    const inserted = res.changes > 0;
    return { inserted, redactions: inserted ? redactions : 0 };
  }

  countTurns(): number {
    return (this.prep("SELECT COUNT(*) c FROM turns").get() as { c: number }).c;
  }

  // --- Backfill-Bookkeeping (PRD F1): Resume und Inkremental-Import sind
  // derselbe Codepfad — unveränderte Dateien (mtime+size) werden übersprungen.

  getBackfillFile(path: string): { mtimeMs: number; size: number } | null {
    const row = this.prep(
      "SELECT mtime_ms AS mtimeMs, size FROM backfill_files WHERE path = ?",
    ).get(path) as { mtimeMs: number; size: number } | undefined;
    return row ?? null;
  }

  upsertBackfillFile(rec: {
    path: string;
    mtimeMs: number;
    size: number;
    turns: number;
    skipped: number;
    redactions: number;
  }): void {
    this.prep(
      `INSERT INTO backfill_files (path, mtime_ms, size, imported_at, turns, skipped, redactions)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms = excluded.mtime_ms, size = excluded.size,
         imported_at = excluded.imported_at, turns = excluded.turns,
         skipped = excluded.skipped, redactions = excluded.redactions`,
    ).run(rec.path, rec.mtimeMs, rec.size, nowIso(), rec.turns, rec.skipped, rec.redactions);
  }

  // Nach großen Importen (ADR-004): FTS-Index zusammenführen.
  optimizeFts(): void {
    this.db.exec("INSERT INTO turns_fts(turns_fts) VALUES('optimize')");
    this.db.exec("INSERT INTO items_fts(items_fts) VALUES('optimize')");
  }

  // --- Items ---------------------------------------------------------------

  addItem(input: NewItem): Item {
    assertOneOf("type", input.type, ITEM_TYPES);
    if (input.status != null) assertOneOf("status", input.status, ITEM_STATUSES);
    if (input.priority != null) assertOneOf("priority", input.priority, ITEM_PRIORITIES);
    const now = nowIso();
    const id = newId("i");
    this.prep(
        `INSERT INTO items
           (uuid, type, status, priority, title, body, anchor_file, anchor_line,
            anchor_end_line, tags, source, session_id, parent_id, project_path,
            git_sha, git_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.status ?? "new",
        input.priority ?? "medium",
        redactText(input.title).text,
        input.body != null ? redactText(input.body).text : null,
        input.anchor?.file ?? null,
        input.anchor?.line ?? null,
        input.anchor?.endLine ?? null,
        JSON.stringify(input.tags ?? []),
        input.source ?? "claude",
        input.sessionId ?? null,
        input.parentId ?? null,
        input.projectPath != null ? normalizeProjectPath(input.projectPath) : null,
        input.gitSha ?? null,
        input.gitBranch ?? null,
        now,
        now,
      );
    return this.mustGetItem(id);
  }

  getItem(id: string): Item | null {
    const exact = this.prep(
      `${SEQ_CTE} SELECT items.*, seq.project_seq FROM items JOIN seq ON seq.id = items.id WHERE uuid = ?`,
    ).get(id) as ItemRow | undefined;
    if (exact) return rowToItem(exact);
    // Komfort: eindeutiger uuid-Präfix reicht (CLI: `cockpit answer i-3f`).
    const prefix = this.prep(
      `${SEQ_CTE} SELECT items.*, seq.project_seq FROM items JOIN seq ON seq.id = items.id WHERE uuid LIKE ? LIMIT 2`,
    ).all(`${id}%`) as ItemRow[];
    return prefix.length === 1 ? rowToItem(prefix[0]!) : null;
  }

  private mustGetItem(id: string): Item {
    const item = this.getItem(id);
    if (!item) throw new Error(`Item ${id} nicht gefunden`);
    return item;
  }

  listItems(filter: ItemFilter = {}): Item[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      // Komma-Liste (Auflage T3): `status=new,in_progress` -> status IN (...),
      // damit Liste und Kachel-/Badge-Zahl dieselbe Definition laden.
      const statuses = filter.status.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conds.push("status = ?");
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        conds.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    if (filter.type) {
      conds.push("type = ?");
      params.push(filter.type);
    }
    if (filter.priority) {
      conds.push("priority = ?");
      params.push(filter.priority);
    }
    if (filter.project) {
      conds.push("(project_path = ? OR project_path IS NULL)");
      params.push(normalizeProjectPath(filter.project));
    }
    if (filter.tag) {
      conds.push("EXISTS (SELECT 1 FROM json_each(items.tags) WHERE json_each.value = ?)");
      params.push(filter.tag);
    }
    if (filter.updatedSince) {
      conds.push("updated_at >= ?");
      params.push(filter.updatedSince);
    }
    if (filter.answeredBy) {
      conds.push("answered_by = ?");
      params.push(filter.answeredBy);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sql = `${SEQ_CTE} SELECT items.*, seq.project_seq FROM items JOIN seq ON seq.id = items.id ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(filter.limit ?? 100);
    return (this.prep(sql).all(...params) as ItemRow[]).map(rowToItem);
  }

  updateItem(id: string, patch: ItemPatch): Item | null {
    if (patch.status != null) assertOneOf("status", patch.status, ITEM_STATUSES);
    if (patch.priority != null) assertOneOf("priority", patch.priority, ITEM_PRIORITIES);
    if (patch.answeredBy != null) assertOneOf("answeredBy", patch.answeredBy, ANSWER_SOURCES);
    // MCP-Zod lässt "   " durch (min(1) zählt Roh-Länge); nach dem Trim wäre
    // das ein answered-Item ohne sichtbare Antwort im Briefing.
    if (patch.answer != null && patch.answer.trim() === "") {
      throw new Error("answer darf nicht leer oder nur Whitespace sein");
    }
    const existing = this.getItem(id);
    if (!existing) return null;
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [nowIso()];
    const push = (col: string, val: unknown): void => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.status != null) push("status", patch.status);
    if (patch.priority != null) push("priority", patch.priority);
    if (patch.title != null) push("title", redactText(patch.title).text);
    if (patch.body != null) push("body", redactText(patch.body).text);
    // Trim hier statt pro Eintrittspunkt (Web/CLI/MCP): Antworten landen im
    // Briefing und im FTS-Index — Whitespace-Polster darf nie persistieren.
    if (patch.answer != null) push("answer", redactText(patch.answer.trim()).text);
    if (patch.answeredBy != null) push("answered_by", patch.answeredBy);
    if (patch.tags != null) push("tags", JSON.stringify(patch.tags));
    if (patch.deliveredAt != null) push("delivered_at", patch.deliveredAt);
    if (patch.anchor != null) {
      push("anchor_file", patch.anchor.file);
      push("anchor_line", patch.anchor.line ?? null);
      push("anchor_end_line", patch.anchor.endLine ?? null);
    }
    if (patch.answer != null && existing.answeredAt == null) push("answered_at", nowIso());
    if (patch.status === "done" && existing.doneAt == null) push("done_at", nowIso());
    params.push(existing.id);
    this.prep(`UPDATE items SET ${sets.join(", ")} WHERE uuid = ?`).run(...params);
    return this.mustGetItem(existing.id);
  }

  answerItem(id: string, answer: string, by: "human" | "claude" = "human"): Item | null {
    return this.updateItem(id, { answer, status: "answered", answeredBy: by });
  }

  // Atomares Beanspruchen unzugestellter menschlicher Antworten (Paket 1): liest
  // UND quittiert in EINEM Statement (delivered_at). Wiederverwendet von
  // pickup_answers (Paket 2). Kein Doppel mit Briefing/On-the-fly (gemeinsames
  // delivered_at). Für project = '' werden nur globale Items (IS NULL) beansprucht.
  claimHumanAnswers(project: string): ClaimedAnswer[] {
    return this.prep(SQL_CLAIM_ANSWERS).all(nowIso(), normalizeProjectPath(project)) as ClaimedAnswer[];
  }

  // Entwurf serverseitig sichern (Paket A, Antwort-Flow v2): der Antworttext
  // landet in answer, OHNE answered zu setzen — Status, answered_by und
  // answered_at bleiben unangetastet. Damit zählt der Entwurf nirgends als
  // Entscheidung (decisionsView/Report/Portfolio verlangen status='answered')
  // und wird nicht zugestellt (Briefing/claim verlangen answered_by='human').
  // Erkennung im UI: answer gesetzt UND status != 'answered'. Kein Missbrauch
  // des answered-Status, keine Migration (bewusste Umsetzer-Entscheidung).
  saveDraft(id: string, text: string): Item | null {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("Entwurf darf nicht leer oder nur Whitespace sein");
    const existing = this.getItem(id);
    if (!existing) return null;
    // Rohes UPDATE statt updateItem: dessen answered_at-Automatik (answer erstmals
    // gesetzt) darf für einen Entwurf NICHT feuern. FTS bleibt über items_au synchron.
    this.prep("UPDATE items SET answer = ?, updated_at = ? WHERE uuid = ?").run(
      redactText(trimmed).text,
      nowIso(),
      existing.id,
    );
    return this.mustGetItem(existing.id);
  }

  // --- Events --------------------------------------------------------------

  recordEvent(e: {
    eventType: string;
    sessionId?: string;
    projectPath?: string;
    payload?: unknown;
  }): { id: string } {
    const { id, params } = eventInsertParams(e);
    this.prep(SQL_INSERT_EVENT).run(...params);
    return { id };
  }

  hasEvent(eventType: string, sessionId: string): boolean {
    return this.prep(SQL_HAS_EVENT).get(eventType, sessionId) !== undefined;
  }

  // Onboarding-Hinweis-Zustand lebt in DB-Events, NICHT in localStorage
  // (bindende Entscheidung 5). Dedup vor Insert (Auflage T8): ein Hinweis wird
  // pro Wert nur einmal als "dauerhaft ausgeblendet" vermerkt.
  hasHintDismiss(hint: string): boolean {
    return (
      this.prep(
        "SELECT 1 FROM events WHERE event_type = 'hint_dismiss' AND json_extract(payload_json, '$.hint') = ? LIMIT 1",
      ).get(hint) !== undefined
    );
  }

  // Spalte heißt payload_json, nicht payload (Auflage T2).
  listDismissedHints(): string[] {
    const rows = this.prep(
      "SELECT DISTINCT json_extract(payload_json, '$.hint') AS hint FROM events WHERE event_type = 'hint_dismiss'",
    ).all() as Array<{ hint: string | null }>;
    return rows.map((r) => r.hint).filter((h): h is string => h != null);
  }

  // --- Entscheidungs-Karten v2 (U2) ----------------------------------------

  // Kommentar an eine Entscheidung: append-only im Events-Log (keine Migration,
  // die Entscheidung selbst bleibt unverändert). Redaction wie bei answer.
  addDecisionComment(itemId: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("Kommentar darf nicht leer sein");
    this.recordEvent({
      eventType: "decision_comment",
      payload: { itemId, text: redactText(trimmed).text, at: nowIso() },
    });
  }

  listDecisionComments(itemId: string): Array<{ text: string; at: string }> {
    return this.prep(
      `SELECT json_extract(payload_json, '$.text') AS text,
              json_extract(payload_json, '$.at') AS at
       FROM events WHERE event_type = 'decision_comment'
         AND json_extract(payload_json, '$.itemId') = ? ORDER BY created_at`,
    ).all(itemId) as Array<{ text: string; at: string }>;
  }

  // Archivieren = 'archived'-Tag setzen/entfernen (kein neuer Statuswert, keine
  // Migration): decisionsView blendet getaggte Items im Default aus. Die
  // Entscheidung bleibt erhalten und durchsuchbar.
  setItemArchived(id: string, archived: boolean): Item | null {
    const existing = this.getItem(id);
    if (!existing) return null;
    const tags = new Set(existing.tags);
    if (archived) tags.add("archived");
    else tags.delete("archived");
    return this.updateItem(id, { tags: [...tags] });
  }

  // Revidieren: neue Entscheidung, die die alte per parent_id ablöst (dieselbe
  // Supersede-Kette wie im Log). answer trägt addItem nicht — daher answerItem
  // im zweiten Schritt (status='answered', answered_by='human').
  reviseDecision(parentId: string, title: string, answer: string): Item | null {
    const parent = this.getItem(parentId);
    if (!parent) return null;
    const created = this.addItem({
      type: "decision",
      title,
      status: "new",
      source: "human",
      parentId,
      projectPath: parent.projectPath ?? undefined,
    });
    return this.answerItem(created.id, answer, "human");
  }

  // Löscht Inhalte (Projekt-scoped oder alles); FTS-Trigger räumen den Index
  // ab, die DB-Datei bleibt. Destruktiv — Bestätigung ist Sache des Aufrufers.
  purge(project?: string): PurgeReport {
    const del = (sql: string, ...params: unknown[]): number =>
      Number(this.prep(sql).run(...params).changes);
    if (project) {
      const p = normalizeProjectPath(project);
      const report = {
        turns: del("DELETE FROM turns WHERE project_path = ?", p),
        items: del("DELETE FROM items WHERE project_path = ?", p),
        events: del("DELETE FROM events WHERE project_path = ?", p),
      };
      // Projekt-Einstellungen (Capture/Archiv) mitentfernen — sonst bliebe ein
      // verwaister Opt-out/Archiv-Zustand zurück (Paket 5).
      del("DELETE FROM project_settings WHERE project_path = ?", p);
      return report;
    }
    const report = {
      turns: del("DELETE FROM turns"),
      items: del("DELETE FROM items"),
      events: del("DELETE FROM events"),
    };
    del("DELETE FROM backfill_files");
    del("DELETE FROM project_settings");
    return report;
  }

  // --- Projekt-Verwaltung (Paket 5, Migration v3) --------------------------
  // Fehlender Eintrag = Default (Capture an, nicht archiviert). Upserts teilen
  // die SQL mit dem Hook-Bundle (schema.ts).

  setCapture(project: string, enabled: boolean): void {
    this.prep(SQL_UPSERT_PROJECT_CAPTURE).run(normalizeProjectPath(project), enabled ? 1 : 0, nowIso());
  }

  setArchived(project: string, archived: boolean): void {
    this.prep(SQL_UPSERT_PROJECT_ARCHIVE).run(
      normalizeProjectPath(project),
      archived ? nowIso() : null,
      nowIso(),
    );
  }

  listProjectSettings(): ProjectSetting[] {
    const rows = this.prep(
      "SELECT project_path, capture_enabled, archived_at, updated_at FROM project_settings",
    ).all() as Array<{ project_path: string; capture_enabled: number; archived_at: string | null; updated_at: string }>;
    return rows.map((r) => ({
      projectPath: r.project_path,
      captureEnabled: r.capture_enabled !== 0,
      archivedAt: r.archived_at,
      updatedAt: r.updated_at,
    }));
  }

  // --- Git-Zustand (Git-Tab) ------------------------------------------------

  upsertGitState(g: GitStateInput): void {
    this.prep(SQL_UPSERT_GIT_STATE).run(...gitStateParams(g));
  }

  listGitStates(): GitStateRow[] {
    const rows = this.prep(
      `SELECT project_path, head_sha, branch, dirty_files, last_commit_at, recent_commits, updated_at
       FROM git_state ORDER BY updated_at DESC`,
    ).all() as Array<{
      project_path: string;
      head_sha: string | null;
      branch: string | null;
      dirty_files: number;
      last_commit_at: string | null;
      recent_commits: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      projectPath: r.project_path,
      headSha: r.head_sha,
      branch: r.branch,
      dirtyFiles: r.dirty_files,
      lastCommitAt: r.last_commit_at,
      recentCommits: JSON.parse(r.recent_commits) as GitStateRow["recentCommits"],
      updatedAt: r.updated_at,
    }));
  }

  // Archivierte Projektpfade — für den Archiv-Ausschluss in den zählenden Views.
  archivedProjects(): string[] {
    return (
      this.prep("SELECT project_path FROM project_settings WHERE archived_at IS NOT NULL").all() as Array<{
        project_path: string;
      }>
    ).map((r) => r.project_path);
  }

  // Settings-Projektliste (Paket 5): ALLE Projekte inkl. archivierter, mit
  // Capture-/Archiv-Zustand und etwas Kontext (letzte Aktivität, Turns, offene
  // Karten). Bewusst nicht archiv-gefiltert — hier bleibt alles umkehrbar sichtbar.
  projectAdminList(): ProjectAdmin[] {
    const turnRows = this.prep(
      "SELECT project_path AS projectPath, MAX(timestamp) AS lastActivity, COUNT(*) AS turns FROM turns GROUP BY project_path",
    ).all() as Array<{ projectPath: string; lastActivity: string; turns: number }>;
    const openRows = this.prep(
      "SELECT project_path AS projectPath, COUNT(*) AS openItems FROM items WHERE status IN ('new', 'in_progress') AND project_path IS NOT NULL GROUP BY project_path",
    ).all() as Array<{ projectPath: string; openItems: number }>;
    const openByProject = new Map(openRows.map((r) => [r.projectPath, r.openItems]));
    const settings = new Map(this.listProjectSettings().map((s) => [s.projectPath, s]));
    const byPath = new Map(turnRows.map((t) => [t.projectPath, t]));
    const paths = new Set<string>([...byPath.keys(), ...settings.keys()]);
    return [...paths]
      .map((p) => {
        const t = byPath.get(p);
        const s = settings.get(p);
        return {
          projectPath: p,
          captureEnabled: s ? s.captureEnabled : true,
          archived: s ? s.archivedAt !== null : false,
          lastActivity: t?.lastActivity ?? null,
          turns: t?.turns ?? 0,
          openItems: openByProject.get(p) ?? 0,
        };
      })
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  }

  // --- Suche (PRD F2) ------------------------------------------------------

  searchTurns(query: string, opts: TurnSearchOpts = {}): TurnHit[] {
    return this.tryMatch(query, (match) => {
      const conds = ["turns_fts MATCH ?"];
      const params: unknown[] = [match];
      if (opts.project) {
        conds.push("t.project_path = ?");
        params.push(normalizeProjectPath(opts.project));
      }
      if (opts.since) {
        conds.push("t.timestamp >= ?");
        params.push(opts.since);
      }
      if (opts.role) {
        conds.push("t.role = ?");
        params.push(opts.role);
      }
      params.push(opts.limit ?? 20);
      const sql = `
        SELECT t.uuid, t.session_id AS sessionId, t.project_path AS projectPath,
               t.role, t.timestamp,
               snippet(turns_fts, -1, '«', '»', '…', 16) AS snippet,
               bm25(turns_fts) AS score
        FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
        WHERE ${conds.join(" AND ")}
        ORDER BY score LIMIT ?`;
      return this.prep(sql).all(...params) as TurnHit[];
    });
  }

  searchItems(query: string, opts: ItemSearchOpts = {}): ItemHit[] {
    return this.tryMatch(query, (match) => {
      const conds = ["items_fts MATCH ?"];
      const params: unknown[] = [match];
      if (opts.types && opts.types.length > 0) {
        conds.push(`i.type IN (${opts.types.map(() => "?").join(", ")})`);
        params.push(...opts.types);
      }
      if (opts.project) {
        conds.push("(i.project_path = ? OR i.project_path IS NULL)");
        params.push(normalizeProjectPath(opts.project));
      }
      if (opts.status) {
        conds.push("i.status = ?");
        params.push(opts.status);
      }
      if (opts.since) {
        conds.push("i.updated_at >= ?");
        params.push(opts.since);
      }
      params.push(opts.limit ?? 20);
      // Spaltengewichte: Titel schlägt Antwort schlägt Body (PRD F2-Akzeptanz).
      const sql = `
        SELECT i.uuid AS id, i.type, i.status, i.title,
               i.project_path AS projectPath, i.created_at AS createdAt,
               snippet(items_fts, -1, '«', '»', '…', 16) AS snippet,
               bm25(items_fts, 4.0, 1.0, 2.0) AS score
        FROM items_fts JOIN items i ON i.id = items_fts.rowid
        WHERE ${conds.join(" AND ")}
        ORDER BY score LIMIT ?`;
      return this.prep(sql).all(...params) as ItemHit[];
    });
  }

  // Session-Liste für den Verlauf-Tab: eine Zeile je erfasster Session mit
  // Zeitspanne, Turn-Zahl und dem ersten User-Prompt als Thema.
  listSessions(opts: { project?: string; limit?: number } = {}): SessionSummary[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.project) {
      conds.push("project_path = ?");
      params.push(normalizeProjectPath(opts.project));
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(opts.limit ?? 200);
    const sql = `
      SELECT session_id AS sessionId, project_path AS projectPath,
             MIN(timestamp) AS firstAt, MAX(timestamp) AS lastAt,
             COUNT(*) AS turns,
             (SELECT content FROM turns t2
                WHERE t2.session_id = turns.session_id AND t2.role = 'user'
                ORDER BY t2.timestamp, t2.id LIMIT 1) AS firstPrompt
      FROM turns ${where}
      GROUP BY session_id, project_path
      ORDER BY lastAt DESC LIMIT ?`;
    const rows = this.prep(sql).all(...params) as Array<SessionSummary & { firstPrompt: string | null }>;
    // Assist-Rauschfilter (Paket 0): erfasste interne Spawn-Sessions
    // (Bestandsdaten ohne Marker) ausblenden — kein Löschen. Filter nach dem
    // LIMIT: die paar Rausch-Zeilen dürfen die Liste minimal verkürzen.
    return rows
      .filter((r) => !isInternalSession(r.firstPrompt, r.turns))
      .map((r) => ({ ...r, firstPrompt: r.firstPrompt?.slice(0, 240) ?? null }));
  }

  // Raw-Ansicht einer Session: chronologisch, Inhalt pro Turn gekappt (die
  // Ansicht dient dem Lesen — Voll-Text findet die Suche). Bewusst getrennt
  // von listTurns: das MCP-recent_turns darf nicht gekappt werden.
  listSessionTurns(sessionId: string, opts: { limit?: number } = {}): SessionTurn[] {
    const rows = this.prep(
      `SELECT uuid, session_id AS sessionId, project_path AS projectPath,
              role, content, timestamp, is_sidechain AS isSidechain
       FROM turns WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?`,
    ).all(sessionId, opts.limit ?? 1000) as Array<
      Omit<SessionTurn, "isSidechain" | "truncated"> & { isSidechain: number }
    >;
    return rows.map((r) => ({
      ...r,
      isSidechain: Boolean(r.isSidechain),
      truncated: r.content.length > SESSION_TURN_MAX_CHARS,
      content: r.content.slice(0, SESSION_TURN_MAX_CHARS),
    }));
  }

  // Verlauf B (Meilensteine): was WÄHREND der Session im selben Projekt entstand
  // — Items (Entscheidung / neue Frage-Vorschlag-Blocker) im Zeitfenster der
  // Session plus Commits aus dem git_state-Cache. Zeitlich sortiert, damit die
  // SPA sie zwischen die Wortmeldungen einweben kann. Reine Ableitung, kein
  // Zustand: das Zeitfenster kommt aus den Turns der Session.
  listSessionMarkers(sessionId: string): SessionMarker[] {
    const span = this.prep(
      "SELECT project_path AS project, MIN(timestamp) AS firstAt, MAX(timestamp) AS lastAt FROM turns WHERE session_id = ?",
    ).get(sessionId) as { project: string | null; firstAt: string | null; lastAt: string | null } | undefined;
    if (!span?.project || !span.firstAt || !span.lastAt) return [];
    const markers: SessionMarker[] = [];
    const items = this.prep(
      `SELECT uuid, type, title, created_at FROM items
       WHERE project_path = ? AND created_at >= ? AND created_at <= ?
         AND type IN ('decision', 'question', 'proposal', 'blocker')
       ORDER BY created_at`,
    ).all(span.project, span.firstAt, span.lastAt) as Array<{
      uuid: string;
      type: string;
      title: string;
      created_at: string;
    }>;
    for (const it of items) {
      markers.push(
        it.type === "decision"
          ? { kind: "decision", at: it.created_at, title: it.title, itemId: it.uuid }
          : { kind: "item", at: it.created_at, title: it.title, itemId: it.uuid, itemType: it.type },
      );
    }
    const git = this.prep("SELECT branch, recent_commits FROM git_state WHERE project_path = ?").get(
      span.project,
    ) as { branch: string | null; recent_commits: string } | undefined;
    if (git) {
      const commits = JSON.parse(git.recent_commits) as Array<{ sha: string; at: string; subject: string }>;
      for (const c of commits) {
        if (c.at >= span.firstAt && c.at <= span.lastAt) {
          // Branch: git_state führt nur den aktuellen Branch, nicht pro Commit —
          // als Näherung mitgegeben (Einzel-Branch-Workflows stimmen).
          markers.push({ kind: "commit", at: c.at, title: c.subject, sha: c.sha, branch: git.branch });
        }
      }
    }
    return markers.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  // Jüngste Turns ohne FTS (MCP recent_turns): Kontext-Recall über Sessions.
  listTurns(opts: TurnListOpts = {}): TurnRow[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.project) {
      conds.push("project_path = ?");
      params.push(normalizeProjectPath(opts.project));
    }
    if (opts.role) {
      conds.push("role = ?");
      params.push(opts.role);
    }
    if (opts.since) {
      conds.push("timestamp >= ?");
      params.push(opts.since);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(opts.limit ?? 20);
    const sql = `
      SELECT uuid, session_id AS sessionId, project_path AS projectPath,
             role, content, timestamp
      FROM turns ${where} ORDER BY timestamp DESC LIMIT ?`;
    return this.prep(sql).all(...params) as TurnRow[];
  }

  // FTS5-Syntaxfehler → Fallback Phrasensuche; deren Fehler werden nicht
  // mehr gefangen (echte DB-Fehler sollen sichtbar bleiben, kein Swallowing).
  private tryMatch<T>(query: string, run: (match: string) => T[]): T[] {
    const match = termQuery(query);
    if (!match) return [];
    try {
      return run(match);
    } catch {
      return run(phraseQuery(query));
    }
  }
}
