// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Portfolio-Views (PRD F10): reine Ableitungen über turns/items/git_state.
// Es gibt keinen "Projektstatus", der gesetzt oder stale werden kann — jede
// Zahl hier ist eine Query und verschwindet mit ihrer Ursache (ARD §1.3).
import { normalizeProjectPath } from "./paths.js";
import { DELIVERY_EVENT } from "./schema.js";
import type { Store } from "./store.js";
import { isInternalSession } from "./transcript.js";

export const ACTIVE_SESSION_MS = 5 * 60 * 1000;
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NEXT_ACTIONS = 5;
const DECISIONS_PER_PROJECT = 3;

export interface GitDelta {
  branch: string | null;
  dirtyFiles: number;
  lastCommitAt: string | null;
  recentCommits: Array<{ sha: string; at: string; subject: string }>;
  updatedAt: string;
}

export interface ProjectStatus {
  projectPath: string;
  lastActivity: string;
  sessions: number;
  turns: number;
  activeSession: boolean;
  stale: boolean;
  openItems: number;
  blockers: number;
  urgent: number;
  waitingOnHuman: number;
  latestDecisions: Array<{ id: string; title: string; at: string }>;
  git: GitDelta | null;
  // Git-Modus je Projekt (Migration v4): steuert, ob Git-Empfehlungen in
  // Übersicht/Session-Prompt auftauchen. Fehlender Eintrag = 'advisory'.
  gitMode: string;
  // Synthetische Global-Zeile (Auflage P1): Aggregat der globalen Items
  // (project_path IS NULL). In JEDEM Scope "in Auswahl", aber keine echte
  // Projektkarte — die UI zählt sie nicht als Projekt.
  global?: boolean;
}

export interface NextAction {
  kind: "blocker" | "urgent" | "question" | "doctor";
  title: string;
  why: string;
  itemId?: string;
  projectPath?: string;
}

export interface PortfolioView {
  projects: ProjectStatus[];
  nextActions: NextAction[];
  // Erststart (PRD F10): Turns importiert, aber noch keine offenen Items —
  // der Empty-State feiert den Import statt Leere zu zeigen.
  firstRun: { turns: number; projects: number } | null;
  // Archivierte Projektpfade (Paket 5): aus Auswahl/Kacheln bereits entfernt;
  // die SPA blendet damit auch Inbox-Items und Badges dieser Projekte aus,
  // damit Kachel == Badge == Liste konsistent bleibt.
  archivedProjects: string[];
  // Tages-Zusammenfassung (U1): reine SQL-Ableitung fürs "Heute"-Band der
  // Übersicht. Sessions ohne Assist-Spawns, heute gefallene Entscheidungen,
  // heute neu eingetroffene Items.
  today: { sessions: number; decisions: number; newItems: number; delivered: number };
  // Offene Items älter als 7 Tage (U1): "Jetzt dran" zeigt das Neueste zuerst,
  // dieser Zähler macht die verdeckte Alt-Last ehrlich sichtbar (Link in die Inbox).
  olderOpen: number;
  // Menschlich beantwortete Antworten, die seit über 2 h nicht abgeholt wurden
  // (Zustell-Transparenz): treibt die Übersichts-Empfehlung "nichts liegt still".
  undeliveredAnswers: number;
}

interface TurnAgg {
  project_path: string;
  last_activity: string;
  sessions: number;
  turns: number;
}

interface ItemAgg {
  project_path: string | null;
  open: number;
  blockers: number;
  urgent: number;
  waiting: number;
}

interface OpenItemRow {
  uuid: string;
  type: string;
  priority: string;
  title: string;
  project_path: string | null;
  created_at: string;
}

const OPEN = "('new', 'in_progress')";

function daysAgo(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / (24 * 60 * 60 * 1000)));
}

export function portfolioView(store: Store, opts: { project?: string; now?: number } = {}): PortfolioView {
  const db = store.rawDb();
  const now = opts.now ?? Date.now();
  const projectFilter = opts.project ? normalizeProjectPath(opts.project) : null;
  // Archiv-Ausschluss (Paket 5): archivierte Projekte fehlen in Auswahl,
  // Kacheln, Badges und "Jetzt dran" — die Daten selbst bleiben (Suche/Verlauf).
  const archived = new Set(store.archivedProjects());

  const turnAgg = db
    .prepare(
      `SELECT project_path, MAX(timestamp) AS last_activity,
              COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS turns
       FROM turns GROUP BY project_path`,
    )
    .all() as TurnAgg[];

  const itemAgg = db
    .prepare(
      `SELECT project_path,
              COUNT(*) AS open,
              SUM(type = 'blocker') AS blockers,
              SUM(priority = 'urgent') AS urgent,
              SUM(source = 'claude') AS waiting
       FROM items WHERE status IN ${OPEN} GROUP BY project_path`,
    )
    .all() as ItemAgg[];
  const itemsByProject = new Map(itemAgg.map((r) => [r.project_path ?? "", r]));

  // Entscheidungen = decision-Items + menschlich beantwortete Fragen (die
  // Antwort IST die Entscheidung); JS-Gruppierung statt N+1-Queries.
  const decisionRows = db
    .prepare(
      `SELECT uuid, title, project_path, created_at FROM items
       WHERE type = 'decision' OR (type = 'question' AND status = 'answered')
       ORDER BY created_at DESC LIMIT 300`,
    )
    .all() as Array<{ uuid: string; title: string; project_path: string | null; created_at: string }>;
  const decisionsByProject = new Map<string, ProjectStatus["latestDecisions"]>();
  for (const d of decisionRows) {
    const key = d.project_path ?? "";
    const list = decisionsByProject.get(key) ?? [];
    if (list.length < DECISIONS_PER_PROJECT) {
      list.push({ id: d.uuid, title: d.title, at: d.created_at });
      decisionsByProject.set(key, list);
    }
  }

  const gitRows = db.prepare("SELECT * FROM git_state").all() as Array<{
    project_path: string;
    head_sha: string | null;
    branch: string | null;
    dirty_files: number;
    last_commit_at: string | null;
    recent_commits: string;
    updated_at: string;
  }>;
  const gitByProject = new Map(
    gitRows.map((g) => [
      g.project_path,
      {
        branch: g.branch,
        dirtyFiles: g.dirty_files,
        lastCommitAt: g.last_commit_at,
        recentCommits: JSON.parse(g.recent_commits) as GitDelta["recentCommits"],
        updatedAt: g.updated_at,
      } satisfies GitDelta,
    ]),
  );

  // Git-Modus je Projekt (Projekte ohne project_settings-Eintrag = 'advisory').
  const gitModes = new Map(store.listProjectSettings().map((s) => [s.projectPath, s.gitMode]));

  const projects: ProjectStatus[] = turnAgg
    .filter((t) => (!projectFilter || t.project_path === projectFilter) && !archived.has(t.project_path))
    .map((t) => {
      const items = itemsByProject.get(t.project_path);
      const last = Date.parse(t.last_activity);
      return {
        projectPath: t.project_path,
        lastActivity: t.last_activity,
        sessions: t.sessions,
        turns: t.turns,
        activeSession: now - last < ACTIVE_SESSION_MS,
        stale: now - last > STALE_AFTER_MS,
        openItems: items?.open ?? 0,
        blockers: items?.blockers ?? 0,
        urgent: items?.urgent ?? 0,
        waitingOnHuman: items?.waiting ?? 0,
        latestDecisions: decisionsByProject.get(t.project_path) ?? [],
        git: gitByProject.get(t.project_path) ?? null,
        gitMode: gitModes.get(t.project_path) ?? "advisory",
      };
    })
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  const nextActions = deriveNextActions(store, now, projectFilter).filter(
    (a) => !a.projectPath || !archived.has(a.projectPath),
  );
  const totalOpen = itemAgg
    .filter((r) => !r.project_path || !archived.has(r.project_path))
    .reduce((a, r) => a + r.open, 0);
  // firstRun zählt nur ECHTE Projekte — vor dem Anhängen der Global-Zeile.
  const firstRun =
    totalOpen === 0 && projects.length > 0
      ? { turns: projects.reduce((a, p) => a + p.turns, 0), projects: projects.length }
      : null;

  // Synthetische Global-Zeile (Auflage P1): globale Items haben keine turns-Zeile
  // und fielen sonst aus allen Kachelsummen. Aggregat aus itemsByProject.get(""),
  // ans Ende gehängt, damit die Global-Items in jeder Auswahl mitzählen — auch
  // bei Einzelauswahl. Keine echte Projektkarte (global:true), die UI zählt sie
  // nicht als Projekt.
  const globalItems = itemsByProject.get("");
  projects.push({
    projectPath: "",
    lastActivity: "",
    sessions: 0,
    turns: 0,
    activeSession: false,
    stale: false,
    openItems: globalItems?.open ?? 0,
    blockers: Number(globalItems?.blockers ?? 0),
    urgent: Number(globalItems?.urgent ?? 0),
    waitingOnHuman: Number(globalItems?.waiting ?? 0),
    latestDecisions: decisionsByProject.get("") ?? [],
    git: null,
    gitMode: "advisory",
    global: true,
  });

  const today = todayCounts(store, now, projectFilter);
  const olderOpen = olderOpenCount(store, now, projectFilter, archived);
  const undeliveredAnswers = undeliveredAnswersCount(store, now, projectFilter, archived);
  return { projects, nextActions, firstRun, archivedProjects: [...archived], today, olderOpen, undeliveredAnswers };
}

// "Heute"-Band der Übersicht (U1): Sessions von heute (Assist-Spawns raus, wie
// im Tagebuch), heute gefallene Entscheidungen (decision-Item angelegt ODER
// Frage/Vorschlag/Blocker heute beantwortet) und heute neu eingetroffene Items.
// Lokaler Kalendertag über die JS-Mitternacht statt SQL-Zeitzonenlogik.
function todayCounts(
  store: Store,
  now: number,
  projectFilter: string | null,
): { sessions: number; decisions: number; newItems: number; delivered: number } {
  const db = store.rawDb();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startIso = start.toISOString();
  const pCond = projectFilter ? "AND (project_path = ? OR project_path IS NULL)" : "";
  const pParams = projectFilter ? [projectFilter] : [];
  const decisions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE
           ((type = 'decision' AND created_at >= ?)
            OR (type IN ('question', 'proposal', 'blocker') AND status = 'answered'
                AND answer IS NOT NULL AND answered_at >= ?)) ${pCond}`,
      )
      .get(startIso, startIso, ...pParams) as { n: number }
  ).n;
  const newItems = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE created_at >= ? ${pCond}`)
      .get(startIso, ...pParams) as { n: number }
  ).n;
  // Heute bestätigte Antworten (Zustellung v2): DISTINCT itemId über answer_acked
  // (finalisiert vom Agenten), damit mehrere Ack-Events je Item nicht doppelt zählen.
  const delivered = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT json_extract(payload_json, '$.itemId')) AS n FROM events
          WHERE event_type = ? AND created_at >= ? ${pCond}`,
      )
      .get(DELIVERY_EVENT.ACKED, startIso, ...pParams) as { n: number }
  ).n;
  return { sessions: countTodaySessions(store, startIso, projectFilter), decisions, newItems, delivered };
}

// Distinkte Sessions von heute ohne interne Assist-Spawns (isInternalSession
// braucht ersten User-Prompt + Turn-Zahl je Session — wie reportView).
function countTodaySessions(store: Store, startIso: string, projectFilter: string | null): number {
  const db = store.rawDb();
  const pCond = projectFilter ? "AND project_path = ?" : "";
  const pParams = projectFilter ? [projectFilter] : [];
  const sess = db
    .prepare(
      `SELECT session_id, COUNT(*) AS turns FROM turns
       WHERE timestamp >= ? AND is_sidechain = 0 ${pCond} GROUP BY session_id`,
    )
    .all(startIso, ...pParams) as Array<{ session_id: string; turns: number }>;
  const prompts = db
    .prepare(
      `SELECT t.session_id, substr(t.content, 1, 80) AS text FROM turns t JOIN (
         SELECT session_id, MIN(timestamp) AS mt FROM turns
         WHERE role = 'user' AND timestamp >= ? GROUP BY session_id
       ) m ON m.session_id = t.session_id AND m.mt = t.timestamp WHERE t.role = 'user'`,
    )
    .all(startIso) as Array<{ session_id: string; text: string }>;
  const promptBy = new Map(prompts.map((p) => [p.session_id, p.text]));
  return sess.filter((s) => !isInternalSession(promptBy.get(s.session_id), s.turns)).length;
}

// "+N ältere offene" (U1): offene Items älter als 7 Tage, archivierte Projekte
// ausgenommen — der ehrliche Gegenpol zum Neueste-zuerst-"Jetzt dran".
function olderOpenCount(
  store: Store,
  now: number,
  projectFilter: string | null,
  archived: Set<string>,
): number {
  const db = store.rawDb();
  const cutoff = new Date(now - 7 * 86_400_000).toISOString();
  const cond = projectFilter ? "AND (project_path = ? OR project_path IS NULL)" : "";
  const params = projectFilter ? [projectFilter] : [];
  const rows = db
    .prepare(
      `SELECT project_path FROM items WHERE status IN ${OPEN} AND created_at < ? ${cond}`,
    )
    .all(cutoff, ...params) as Array<{ project_path: string | null }>;
  return rows.filter((r) => !r.project_path || !archived.has(r.project_path)).length;
}

// Menschlich beantwortete, aber seit >2 h nicht BESTÄTIGTE Antworten (Zustellung
// v2): delivered_at IS NULL = noch nicht geackt (wartend ODER angeboten-unbestätigt).
// dead=0 schließt die laut in der UI gezeigten toten Antworten aus (eigener Zustand).
// Archiv-Ausschluss wie bei olderOpenCount (JS-Filter nach der Query).
function undeliveredAnswersCount(
  store: Store,
  now: number,
  projectFilter: string | null,
  archived: Set<string>,
): number {
  const db = store.rawDb();
  const cutoff = new Date(now - 2 * 3_600_000).toISOString();
  const cond = projectFilter ? "AND (project_path = ? OR project_path IS NULL)" : "";
  const params = projectFilter ? [projectFilter] : [];
  const rows = db
    .prepare(
      `SELECT project_path FROM items
        WHERE status = 'answered' AND answered_by = 'human'
          AND delivered_at IS NULL AND dead = 0 AND answered_at < ? ${cond}`,
    )
    .all(cutoff, ...params) as Array<{ project_path: string | null }>;
  return rows.filter((r) => !r.project_path || !archived.has(r.project_path)).length;
}

// --- Entscheidungs-Log (PRD F12) -------------------------------------------
// Entscheidungen mit Provenienz: decision-Items + menschlich beantwortete
// Fragen. Supersede-Kette über parent_id (Kind ersetzt Elter); Default zeigt
// nur den aktiven Stand — genau das Merkmal, das kein MD-File abbilden kann.

export interface DecisionEntry {
  id: string;
  type: string;
  status: string;
  title: string;
  answer: string | null;
  projectPath: string | null;
  anchorFile: string | null;
  anchorLine: number | null;
  gitSha: string | null;
  gitBranch: string | null;
  createdAt: string;
  // Provenienz der Kette: welches Item dieses ersetzt bzw. davon ersetzt wurde.
  replacesId: string | null;
  supersededById: string | null;
  // U2: gespeicherter, aber noch nicht zugestellter Entwurf (answer gesetzt,
  // status weder 'answered' noch 'done') — im Log "noch nicht zugestellt".
  draft: boolean;
  // U2: aus dem Default-Log genommen ('archived'-Tag), nur unter all=1 sichtbar.
  archived: boolean;
}

export function decisionsView(
  store: Store,
  opts: { project?: string; all?: boolean } = {},
): DecisionEntry[] {
  const db = store.rawDb();
  // Beantwortete Vorschläge/Blocker SIND Entscheidungen (Lücke 1, Review
  // 09.07.; live getroffen am 10.07.: PO fand seine gespeicherte
  // Vorschlags-Antwort nicht im Log). 'done' zählt wie 'answered' (PO 12.07.,
  // i-e2fcaaa932): als erledigt geschlossene Items mit Antwort sind getroffene
  // Entscheidungen — vorher erschienen sie fälschlich als Entwurf.
  // Dritte Klausel (U2): Entwürfe — answer gesetzt, aber weder zugestellt noch
  // abgeschlossen. Sie erscheinen als "noch nicht zugestellt" im Log, damit
  // heute begonnene, aber nicht abgeschickte Antworten sichtbar bleiben.
  const conds = [
    `(type = 'decision'
      OR (type IN ('question', 'proposal', 'blocker') AND status IN ('answered', 'done') AND answer IS NOT NULL)
      OR (type IN ('question', 'proposal', 'blocker') AND status NOT IN ('answered', 'done') AND answer IS NOT NULL AND answer != ''))`,
  ];
  const params: unknown[] = [];
  if (opts.project) {
    conds.push("(project_path = ? OR project_path IS NULL)");
    params.push(normalizeProjectPath(opts.project));
  }
  const rows = db
    .prepare(
      `SELECT uuid, type, status, title, answer, project_path, anchor_file,
              anchor_line, git_sha, git_branch, created_at, parent_id, tags
       FROM items WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC LIMIT 500`,
    )
    .all(...params) as Array<{
    uuid: string;
    type: string;
    status: string;
    title: string;
    answer: string | null;
    project_path: string | null;
    anchor_file: string | null;
    anchor_line: number | null;
    git_sha: string | null;
    git_branch: string | null;
    created_at: string;
    parent_id: string | null;
    tags: string;
  }>;

  // Supersede gilt auch über Typgrenzen: JEDES Item mit parent_id ersetzt
  // seinen Elter — deshalb eine eigene, schmale Query statt Wiederverwendung.
  const children = db
    .prepare("SELECT uuid, parent_id FROM items WHERE parent_id IS NOT NULL")
    .all() as Array<{ uuid: string; parent_id: string }>;
  const supersededBy = new Map(children.map((c) => [c.parent_id, c.uuid]));

  const entries: DecisionEntry[] = rows.map((r) => {
    const tags = safeTags(r.tags);
    return {
      id: r.uuid,
      type: r.type,
      status: r.status,
      title: r.title,
      answer: r.answer,
      projectPath: r.project_path,
      anchorFile: r.anchor_file,
      anchorLine: r.anchor_line,
      gitSha: r.git_sha,
      gitBranch: r.git_branch,
      createdAt: r.created_at,
      replacesId: r.parent_id,
      supersededById: supersededBy.get(r.uuid) ?? null,
      draft: r.type !== "decision" && r.status !== "answered" && r.status !== "done" && !!r.answer,
      archived: tags.includes("archived"),
    };
  });
  // Default: nur aktueller Stand — ersetzte, verworfene und archivierte
  // Entscheidungen bleiben unter all=1 sichtbar (mit Markierung in der UI).
  if (opts.all) return entries;
  return entries.filter((e) => e.supersededById === null && e.status !== "rejected" && !e.archived);
}

// Tags sind JSON in der Spalte; defensiv parsen, kein Wurf bei Altdaten.
function safeTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

// --- Report / Projekt-Tagebuch --------------------------------------------
// Tagebuchformat über die Zeitachse: je Tag und Projekt die Sessions (mit
// erstem User-Prompt als Thema), gefallene Entscheidungen und neue Items.
// Reine SQL-Ableitung wie portfolioView — kein LLM, keine Persistenz.
// date(...,'localtime') gruppiert nach lokalem Kalendertag, nicht UTC.

export interface ReportSession {
  sessionId: string;
  turns: number;
  firstAt: string;
  lastAt: string;
  firstPrompt: string | null;
}

export interface ReportDayProject {
  projectPath: string;
  sessions: ReportSession[];
  decisions: Array<{ id: string; title: string; answer: string | null }>;
  newItems: Array<{ id: string; type: string; title: string; status: string }>;
}

export interface ReportDay {
  date: string;
  projects: ReportDayProject[];
}

export function reportView(
  store: Store,
  opts: { project?: string; days?: number; now?: number } = {},
): ReportDay[] {
  const db = store.rawDb();
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const projectFilter = opts.project ? normalizeProjectPath(opts.project) : null;
  const pCond = projectFilter ? "AND project_path = ?" : "";
  const pParams = projectFilter ? [projectFilter] : [];

  const sessions = db
    .prepare(
      `SELECT date(timestamp, 'localtime') AS day, project_path, session_id,
              COUNT(*) AS turns, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
       FROM turns WHERE timestamp >= ? AND is_sidechain = 0 ${pCond}
       GROUP BY day, project_path, session_id ORDER BY day, first_at`,
    )
    .all(cutoff, ...pParams) as Array<{
    day: string;
    project_path: string;
    session_id: string;
    turns: number;
    first_at: string;
    last_at: string;
  }>;

  // Erster User-Prompt je Session als "Thema" (gekürzt auf 240 Zeichen).
  const prompts = db
    .prepare(
      `SELECT t.session_id, substr(t.content, 1, 240) AS text
       FROM turns t JOIN (
         SELECT session_id, MIN(timestamp) AS mt FROM turns
         WHERE role = 'user' AND timestamp >= ? GROUP BY session_id
       ) m ON m.session_id = t.session_id AND m.mt = t.timestamp
       WHERE t.role = 'user'`,
    )
    .all(cutoff) as Array<{ session_id: string; text: string }>;
  const promptBySession = new Map(prompts.map((p) => [p.session_id, p.text]));

  const itemRows = db
    .prepare(
      `SELECT uuid, type, status, title, answer, project_path,
              date(created_at, 'localtime') AS day
       FROM items WHERE created_at >= ? ${pCond} ORDER BY created_at`,
    )
    .all(cutoff, ...pParams) as Array<{
    uuid: string;
    type: string;
    status: string;
    title: string;
    answer: string | null;
    project_path: string | null;
    day: string;
  }>;

  const byDay = new Map<string, Map<string, ReportDayProject>>();
  const bucket = (day: string, project: string): ReportDayProject => {
    const dayMap = byDay.get(day) ?? new Map<string, ReportDayProject>();
    byDay.set(day, dayMap);
    const b = dayMap.get(project) ?? { projectPath: project, sessions: [], decisions: [], newItems: [] };
    dayMap.set(project, b);
    return b;
  };

  for (const s of sessions) {
    const firstPrompt = promptBySession.get(s.session_id) ?? null;
    // Assist-Rauschfilter (Paket 0): interne Spawn-Sessions (Bestandsdaten)
    // nicht ins Tagebuch aufnehmen — kein Bucket, damit reine Rausch-Tage
    // gar nicht erst erscheinen.
    if (isInternalSession(firstPrompt, s.turns)) continue;
    bucket(s.day, s.project_path).sessions.push({
      sessionId: s.session_id,
      turns: s.turns,
      firstAt: s.first_at,
      lastAt: s.last_at,
      firstPrompt,
    });
  }
  for (const it of itemRows) {
    const b = bucket(it.day, it.project_path ?? "");
    if (it.type === "decision" || (it.type === "question" && it.status === "answered")) {
      b.decisions.push({ id: it.uuid, title: it.title, answer: it.answer });
    } else {
      b.newItems.push({ id: it.uuid, type: it.type, title: it.title, status: it.status });
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, projects]) => ({ date, projects: [...projects.values()] }));
}

// "Jetzt dran" (KONZEPT §9.1): max. 5, Dringlichkeit vor Datum, jede Zeile
// mit Warum. Reihenfolge: Blocker → urgent → high → das NEUESTE zuerst.
// created_at DESC (U1, PO-Befund 10.07.): ASC füllte die 5 Plätze mit den
// ältesten Items — heute Eingetroffenes erschien nie. Alt-Last wird stattdessen
// über olderOpenCount() als "+N ältere offene" ehrlich sichtbar gemacht.
function deriveNextActions(store: Store, now: number, projectFilter: string | null): NextAction[] {
  const db = store.rawDb();
  const cond = projectFilter ? "AND (project_path = ? OR project_path IS NULL)" : "";
  const params = projectFilter ? [projectFilter] : [];
  const rows = db
    .prepare(
      `SELECT uuid, type, priority, title, project_path, created_at FROM items
       WHERE status IN ${OPEN} ${cond}
       ORDER BY (type = 'blocker') DESC, (priority = 'urgent') DESC,
                (priority = 'high') DESC, created_at DESC
       LIMIT ?`,
    )
    .all(...params, MAX_NEXT_ACTIONS) as OpenItemRow[];
  return rows.map((r) => {
    const age = daysAgo(r.created_at, now);
    const ageText = age === 0 ? "heute" : age === 1 ? "seit gestern" : `seit ${age} Tagen`;
    if (r.type === "blocker") {
      return {
        kind: "blocker" as const,
        title: r.title,
        why: `Blocker ${ageText} offen — ein Agent kommt ohne dich nicht weiter`,
        itemId: r.uuid,
        projectPath: r.project_path ?? undefined,
      };
    }
    if (r.priority === "urgent") {
      return {
        kind: "urgent" as const,
        title: r.title,
        why: `Als dringend markiert, ${ageText} unbeantwortet`,
        itemId: r.uuid,
        projectPath: r.project_path ?? undefined,
      };
    }
    return {
      kind: "question" as const,
      title: r.title,
      why: `Offen ${ageText} — sonst fragt Claude in der nächsten Session erneut`,
      itemId: r.uuid,
      projectPath: r.project_path ?? undefined,
    };
  });
}
