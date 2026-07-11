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
  lastActivity: string | null;
  turns: number;
  openItems: number;
}

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
  today: { sessions: number; decisions: number; newItems: number };
  olderOpen: number;
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
  projectSeq?: number;
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
