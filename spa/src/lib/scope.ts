// Projektauswahl ("Auswahl", nie "Scope" in der UI — Auflage P3) und die
// gemeinsamen Prädikat-Funktionen (Auflagen T3/P1/P2). REINE Funktionen ohne
// React/DOM-Bezug: dieselbe Definition speist Kachel, Sidebar-Badge und
// Listen-Filter, und der fokussierte Vitest (§10A) importiert sie direkt.

export type ScopeMode = "active" | "all" | "single";

// Zeitperiode der Ansicht "Aktiv": Default 7 Tage — gezeigt wird nur, woran
// gerade gearbeitet wird (Session offen oder Aktivität in den letzten N Tagen).
// "Alle" hebt die Zeitgrenze auf.
export const DEFAULT_ACTIVE_DAYS = 7;
export const ACTIVE_DAYS_CHOICES = [7, 14, 30, 90] as const;

export interface Scope {
  mode: ScopeMode;
  project: string;
  days: number;
}

// Minimal-Shape aus /api/status.projects, den die Auswahl-Logik braucht.
export interface ScopeProject {
  projectPath: string;
  lastActivity: string;
  activeSession: boolean;
}

// Item-Minimal-Shape für die Listen-Filter.
export interface ScopeItem {
  projectPath?: string | null;
  status: string;
  type: string;
  source: string;
  updatedAt?: string;
}

// Auswahl aus den URL-Suchparametern lesen. `single` ohne `project` fällt auf
// `active` zurück (PLAN-PRD §4). Default (kein Param) = active mit 7 Tagen.
export function parseScope(search: URLSearchParams): Scope {
  const daysRaw = Number(search.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 365
    ? Math.floor(daysRaw)
    : DEFAULT_ACTIVE_DAYS;
  const mode = search.get("scope");
  if (mode === "all") return { mode: "all", project: "", days };
  if (mode === "single") {
    const project = search.get("project") ?? "";
    return project ? { mode: "single", project, days } : { mode: "active", project: "", days };
  }
  return { mode: "active", project: "", days };
}

// Auswahl in Suchparameter zurückschreiben (active mit Default-Periode ist
// weglassbar — saubere URLs für den häufigsten Fall).
export function scopeToParams(scope: Scope): URLSearchParams {
  const p = new URLSearchParams();
  if (scope.mode !== "active") p.set("scope", scope.mode);
  if (scope.mode === "single" && scope.project) p.set("project", scope.project);
  if (scope.days !== DEFAULT_ACTIVE_DAYS) p.set("days", String(scope.days));
  return p;
}

// Globale Items haben keinen Projektpfad ("" oder null/undefined).
export function isGlobal(projectPath: string | null | undefined): boolean {
  return projectPath === "" || projectPath === null || projectPath === undefined;
}

// "aktiv" = Session läuft gerade ODER letzte Aktivität innerhalb der gewählten
// Zeitperiode (Default 7 Tage). Bewusst REIN zeitbasiert: die alte Regel
// "offene Items halten ein Projekt aktiv" hat die Ansicht mit uralten Fragen
// geflutet — Altes ist über "Alle" weiterhin erreichbar.
export function buildActiveSet(
  projects: ScopeProject[],
  days: number = DEFAULT_ACTIVE_DAYS,
  now: number = Date.now(),
): Set<string> {
  const cutoff = now - days * 86_400_000;
  const set = new Set<string>();
  for (const p of projects) {
    const last = Date.parse(p.lastActivity);
    if (p.activeSession || (Number.isFinite(last) && last >= cutoff)) set.add(p.projectPath);
  }
  return set;
}

// Ist ein Projektpfad in der aktuellen Auswahl?
// Globale Items (ohne Projektzuordnung) erscheinen NUR in "Alle" (PO-Entscheid
// 11.07., ändert Auflage P1): in "Aktiv" und Einzelprojekt fluteten uralte
// globale cola-Items die Ansicht und ließen den Filter kaputt wirken
// ("cuando gewählt, trotzdem fremde Items"). `active` erst nach geladenem Status.
export function inScope(
  scope: Scope,
  projectPath: string | null | undefined,
  activeSet: Set<string>,
): boolean {
  if (scope.mode === "all") return true;
  if (isGlobal(projectPath)) return false;
  if (scope.mode === "single") return projectPath === scope.project;
  return activeSet.has(projectPath as string);
}

// Zeitgrenze auch für KARTEN, nicht nur Projekte (User-Befund 09.07.: "7 Tage"
// zeigte trotzdem alles — aktive Projekte brachten ihre Uralt-Karten mit, und
// globale Items sind immer in der Auswahl). In "Aktiv" zählt ein Item nur,
// wenn seine letzte Aktivität (updatedAt) innerhalb der Periode liegt;
// "Alle"/Einzelauswahl heben die Zeitgrenze auf.
export function inPeriod(item: ScopeItem, scope: Scope, now: number = Date.now()): boolean {
  if (scope.mode !== "active") return true;
  const t = Date.parse(item.updatedAt ?? "");
  return Number.isFinite(t) && t >= now - scope.days * 86_400_000;
}

// --- Gemeinsame Prädikate (Kachel == Badge == Liste, Auflagen T3/P1/P2) ------

const OPEN_STATUSES = new Set(["new", "in_progress"]);

// "Inbox offen" = status IN (new, in_progress). postponed ist ausgeblendet
// (eigener "Später"-Filter) — behebt den Alt-Widerspruch webpage.ts:387 vs
// views.ts:76 (PLAN-PRD §4).
export function isInboxOpen(item: ScopeItem): boolean {
  return OPEN_STATUSES.has(item.status);
}

// "Handlungspflichtig" = das Modell wartet auf eine menschliche Reaktion:
// Frage/Blocker/Vorschlag/Task von Claude, offen. Alles andere (Ergebnis,
// Info, Memory, protokollierte Entscheidungen, Human-Items) ist Log.
// PO-Entscheide 09.07.: T3-Änderung + "Tasks zählen als handlungspflichtig"
// (Antwort auf i-16a80d3516).
const ACTIONABLE_TYPES = new Set(["question", "blocker", "proposal", "task"]);

export function isActionable(item: ScopeItem): boolean {
  return (
    item.source === "claude" &&
    ACTIONABLE_TYPES.has(item.type) &&
    OPEN_STATUSES.has(item.status)
  );
}

// "Log" = offen, aber nicht handlungspflichtig: Ergebnis/Info/Memory/
// protokollierte Entscheidung sowie selbst notierte (source=human) Items.
// Disjunkt zu isActionable; done/postponed sind in keiner Anzeige.
const LOG_TYPES = new Set(["result", "fyi", "memory", "decision"]);

export function isLog(item: ScopeItem): boolean {
  return (
    OPEN_STATUSES.has(item.status) &&
    (LOG_TYPES.has(item.type) || item.source === "human")
  );
}

// "Blocker" = type='blocker' und offen.
export function isBlocker(item: ScopeItem): boolean {
  return item.type === "blocker" && OPEN_STATUSES.has(item.status);
}

// "Später" = postponed (eigener Filter, aus der Inbox ausgeblendet).
export function isPostponed(item: ScopeItem): boolean {
  return item.status === "postponed";
}
