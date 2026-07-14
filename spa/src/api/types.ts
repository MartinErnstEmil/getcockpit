// Spiegel der Server-Shapes (views.ts / store.ts). Nur die Felder, die die SPA
// nutzt; bewusst kein generierter Client (KISS).

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
  // Git-Modus je Projekt (Migration v4): manual | advisory | auto.
  gitMode: string;
  // Synthetische Global-Zeile (Auflage P1): keine echte Projektkarte.
  global?: boolean;
}

export interface NextAction {
  kind: "blocker" | "urgent" | "question" | "doctor";
  title: string;
  why: string;
  itemId?: string;
  projectPath?: string;
}

export interface DoctorCheck {
  ok: boolean;
  label: string;
  fix: string;
}

// CLAUDE.md-Budget-Quellen-Check (Spiegel von claudemd.ts BudgetCheckResult).
export interface BudgetCheckResult {
  checkedAt: string;
  found: boolean;
  value: number | null;
  unit: "chars" | "tokens" | null;
  sourceUrl: string | null;
  note: string;
}

export interface ProjectAdmin {
  projectPath: string;
  captureEnabled: boolean;
  archived: boolean;
  // Git-Modi (Migration v4): manual | advisory | auto. Default advisory.
  gitMode: string;
  lastActivity: string | null;
  turns: number;
  openItems: number;
}

// Git-Modi je Projekt — Allowlist gespiegelt aus store.ts GIT_MODES.
export const GIT_MODES = ["manual", "advisory", "auto"] as const;

export interface StatusResponse {
  projects: ProjectStatus[];
  nextActions: NextAction[];
  firstRun: { turns: number; projects: number } | null;
  // Archivierte Projektpfade (Paket 5): SPA blendet deren Items/Badges aus.
  archivedProjects: string[];
  doctor: DoctorCheck[];
  // disableAllHooks in der settings.json: Hooks registriert, aber wirkungslos
  // — die UI zeigt dann ein Warnbanner (keine Aufzeichnung, keine Zustellung).
  hooksDisabled: boolean;
  // Phase 2: welche Onboarding-Hinweise dauerhaft ausgeblendet sind.
  dismissedHints: string[];
  // U1: "Heute"-Band und verdeckte Alt-Last der Übersicht.
  today: { sessions: number; decisions: number; newItems: number; delivered: number };
  olderOpen: number;
  // Zustell-Transparenz: beantwortete Antworten, seit >2 h nicht abgeholt.
  undeliveredAnswers: number;
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
  // Zustell-Quittung (Zustell-Transparenz): Weg + Session + Zeitpunkt der ersten
  // Abholung. Nur an zugestellten Items, null wenn kein Protokoll-Event vorliegt.
  delivery?: DeliveryInfo | null;
  // Projektspezifische laufende Nummer (#1 = ältestes Item des Projekts).
  projectSeq?: number;
}

export interface DeliveryInfo {
  at: string;
  sessionId: string | null;
  // "briefing" | "prompt" | "mcp"
  via: string;
}

// Ergebnis des Zustell-Selbsttests (Zustell-Transparenz): Kette bewiesen oder
// nicht, mit Dauer und Klartext-Grund im Fehlerfall.
export interface SelftestResult {
  ok: boolean;
  ms: number;
  reason?: string;
}

// Update-Verfügbarkeit (GET /api/update): fail-open, latest=null wenn offline.
export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

// KI-Gesundheit (GET /api/ai-health): Diagnose bei Briefing/Assist-Timeout.
export interface AiHealth {
  claudeInstalled: boolean;
  claudeVersion: string | null;
  runningSessions: number;
  staleSessions: number;
  staleThresholdHours: number;
}

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
  replacesId: string | null;
  supersededById: string | null;
  // U2: Entwurf (gespeichert, nicht zugestellt) bzw. archiviert (aus dem
  // Default-Log genommen, nur unter „auch ersetzte zeigen“ sichtbar).
  draft: boolean;
  archived: boolean;
}

export interface DecisionComment {
  text: string;
  at: string;
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

// Assist-Kinds hardcodet (PLAN-PRD §3): kein /api/meta. Der typ-passende ist
// als "empfohlen" markiert. "triage" ist der automatische Karten-Assist
// (Erklärung + Antwortoptionen als JSON) und taucht nicht als Button auf.
export type AssistKind = "explain" | "pros-cons" | "alternatives" | "swot" | "triage";

export const ASSISTS: Array<{ kind: AssistKind; label: string }> = [
  { kind: "explain", label: "erklären" },
  { kind: "pros-cons", label: "pro-contra" },
  { kind: "alternatives", label: "alternativen" },
  { kind: "swot", label: "swot" },
];

// Empfehlung je Item-Typ (Onepager RECO).
export const RECOMMENDED_ASSIST: Record<string, AssistKind> = {
  decision: "pros-cons",
  question: "explain",
  proposal: "alternatives",
};

// --- Report / Tagebuch (Spiegel von views.ts reportView) --------------------

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

// --- Verlauf (Spiegel von store.ts SessionSummary/SessionTurn) ---------------

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

// Verlauf B (Meilensteine): Ereignisse, die während der Session entstanden.
export interface SessionMarker {
  kind: "decision" | "item" | "commit";
  at: string;
  title: string;
  itemId?: string;
  itemType?: string;
  sha?: string;
  branch?: string | null;
}

// --- Projekt-Briefing (Spiegel von statusbrief.ts) ---------------------------

export interface StatusBrief {
  project: string;
  sinceDays: number;
  report: string;
  mode: "llm" | "raw";
  degradedBecause?: string;
}

// --- Gedächtnis & Regeln (Spiegel von config.ts) ----------------------------

export interface ConfigDiff {
  added: string[];
  removed: string[];
  untracked: boolean;
}

export interface ConfigEntry {
  label: string;
  projectPath: string | null;
  file: string;
  exists: boolean;
  chars: number;
  budget: number;
  remaining: number;
  diff: ConfigDiff | null;
}

export interface FileView {
  file: string;
  content: string;
  truncated: boolean;
}

// --- Config-Baukasten (Spiegel von composer.ts) -----------------------------

export interface SnippetMeta {
  id: string;
  file: string;
  title: string;
  description?: string;
  target: string;
  section: string;
  priority: number;
  mode: "write" | "copy";
  tags: string[];
  conflicts: string[];
  body: string;
}

export interface ComposerApplyResult {
  target: string;
  written: boolean;
  existingChars: number;
  newChars: number;
  newContent: string;
  modifiedSections: string[];
  appendedSections: string[];
  missing: string[];
  copyOnly: SnippetMeta[];
}

// --- Env-Tab (Spiegel von env.ts / store.ts) --------------------------------
// SICHERHEIT: der Server liefert NIE einen Wert — nur Namen + gesetzt/leer und
// die nicht-geheimen Metadaten. Werte werden write-only in die echte .env
// geschrieben, nie in der DB gehalten.

export interface EnvSpecMeta {
  why: string;
  how: string;
  what: string;
  serviceLink: string;
  source: string;
}

export interface EnvVarView {
  key: string;
  present: boolean; // Schlüssel steht in der .env auf der Platte
  hasValue: boolean; // present UND nicht-leerer Wert
  inExample: boolean;
  spec: EnvSpecMeta | null;
}

export interface EnvProjectView {
  projectPath: string; // '' = global
  label: string;
  envFile: string;
  envExists: boolean;
  exampleExists: boolean;
  gitignore: { isRepo: boolean; ignored: boolean };
  vars: EnvVarView[];
}

export interface EnvHistoryEntry {
  id: number;
  projectPath: string;
  keyName: string;
  change: string; // value_set | value_set_new | spec_edited | ...
  detail: string;
  at: string;
}

// Antwort von /api/env-assist: roher Haiku-Text (JSON-Array) + die gescannten
// Namen. Die SPA parst das Array defensiv (parseEnvAssist).
export interface EnvAssistResponse {
  text: string;
  detectedKeys: string[];
}

export interface EnvRequirement {
  key: string;
  why: string;
  how: string;
  what: string;
  link: string;
}

// --- Git-Tab (Transparenz) ---------------------------------------------------

export interface GitStateRow {
  projectPath: string;
  headSha: string | null;
  branch: string | null;
  dirtyFiles: number;
  lastCommitAt: string | null;
  recentCommits: Array<{ sha: string; at: string; subject: string }>;
  // Git-Modus je Projekt (Anzeige-Chip; geschaltet wird nur in den Settings).
  gitMode: string;
  updatedAt: string;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface GitRefreshResult {
  state: GitStateRow | null;
  // null = kein Upstream konfiguriert (z. B. lokales Repo ohne Remote).
  aheadBehind: AheadBehind | null;
  // Jüngster Auto-Snapshot (nur bei mode='auto' relevant); null = noch keiner.
  // unmerged = enthält Arbeit, die nicht in HEAD steckt (merge-base-Prüfung).
  lastSnapshot: { ref: string; at: string; unmerged: boolean } | null;
}

// Git-Tab Slice 2: flache Branch-Historie (aufklappbare Karte).
export interface GitLogEntry {
  sha: string;
  at: string;
  subject: string;
}
export interface GitLogResponse {
  commits: GitLogEntry[];
  // true, wenn die Seite voll war (== limit) und es vermutlich ältere Commits gibt.
  hasMore: boolean;
}

// Git-Tab Slice 2: Commit-Graph über die echten Refs (+ optional Snapshots).
export interface GitGraphCommit {
  sha: string;
  parents: string[];
  at: string;
  subject: string;
  refs: string[];
}
export interface GitGraphResponse {
  commits: GitGraphCommit[];
  // limit erreicht -> es gibt vermutlich ältere Commits außerhalb des Fensters.
  limitHit: boolean;
}

// Ship-Tab Slice 1: Roh-Signale aus dem Repo-Wurzel (Spiegel von shipinfo.ts).
// Die Klassifikation in Ziel/Gate/Kommando passiert rein in lib/shipplan.ts.
export interface ShipSignals {
  files: string[];
  npmScripts: string[];
  deployWorkflow: boolean;
}

// Ship-Tab Slice 2/3: Live-CI-Status (Spiegel von ciinfo.ts CiStatus).
export type CiState =
  | "no-gh"
  | "no-auth"
  | "no-remote"
  | "non-github"
  | "unpushed"
  | "no-run"
  | "running"
  | "passed"
  | "failed";
export interface CiStatus {
  state: CiState;
  headSha: string;
  workflowName?: string;
  url?: string;
  runId?: number;
  host?: string;
}
