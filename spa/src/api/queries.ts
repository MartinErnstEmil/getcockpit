import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "./client";
import type {
  AssistKind,
  BudgetCheckResult,
  ComposerApplyResult,
  ConfigEntry,
  DecisionComment,
  DecisionEntry,
  FileView,
  GitRefreshResult,
  GitStateRow,
  Item,
  ProjectAdmin,
  ReportDay,
  SessionMarker,
  SessionSummary,
  SessionTurn,
  SnippetMeta,
  StatusBrief,
  StatusResponse,
  TurnHit,
} from "./types";
import { getExpertLevel, getLocale } from "@/lib/prefs";
import type { Scope } from "@/lib/scope";

// EIN /api/status-Call speist Kacheln, Projektkarten, "Jetzt dran", doctor und
// dismissedHints (PLAN-PRD §2). Bei Einzelauswahl filtert der Server (?project=),
// sonst laden wir den vollen Status und filtern im Client ("aktive"/"alle").
function statusPath(scope: Scope): string {
  return scope.mode === "single"
    ? `/api/status?project=${encodeURIComponent(scope.project)}`
    : "/api/status";
}

export function useStatus(scope: Scope) {
  return useQuery({
    queryKey: ["status", scope.mode === "single" ? scope.project : "all"],
    queryFn: () => apiFetch<StatusResponse>(statusPath(scope)),
  });
}

// /api/items mit Komma-Status (Auflage T3): Kachel, Sidebar-Badge und Liste
// speisen sich aus DEMSELBEN geladenen Set. Wir laden offen + später (der
// "Später"-Filter ist eine eigene Achse), damit der 200er-Cap nicht auf
// erledigte/beantwortete Items verschwendet wird.
const ITEM_STATUS = "new,in_progress,postponed";
function itemsPath(scope: Scope): string {
  const project = scope.mode === "single" ? `&project=${encodeURIComponent(scope.project)}` : "";
  return `/api/items?status=${ITEM_STATUS}${project}`;
}

export function useItems(scope: Scope) {
  return useQuery({
    queryKey: ["items", scope.mode === "single" ? scope.project : "all"],
    queryFn: () => apiFetch<{ items: Item[] }>(itemsPath(scope)),
  });
}

// Erledigt-Nachschau (Sekundär-Filter): eigener, nur bei Bedarf geladener Satz —
// die 200er-Kappe der Hauptliste bleibt für Offenes reserviert.
export function useDoneItems(scope: Scope, enabled: boolean) {
  const project = scope.mode === "single" ? `&project=${encodeURIComponent(scope.project)}` : "";
  return useQuery({
    queryKey: ["items-done", scope.mode === "single" ? scope.project : "all"],
    enabled,
    queryFn: () => apiFetch<{ items: Item[] }>(`/api/items?status=done${project}`),
  });
}

// Einzelnes Item für den Deep-Link (?item=): muss unabhängig von Auswahl,
// Status und 200er-Cap aufgehen — die Liste allein reicht dafür nicht.
export function useItem(id: string | null) {
  return useQuery({
    queryKey: ["item", id],
    enabled: id !== null && id !== "",
    retry: false,
    queryFn: () => apiFetch<{ item: Item }>(`/api/item?id=${encodeURIComponent(id ?? "")}`),
  });
}

export function useDecisions(scope: Scope, all: boolean) {
  return useQuery({
    queryKey: ["decisions", scope.mode === "single" ? scope.project : "all", all],
    queryFn: () => {
      const params: string[] = [];
      if (all) params.push("all=1");
      if (scope.mode === "single") params.push(`project=${encodeURIComponent(scope.project)}`);
      return apiFetch<{ decisions: DecisionEntry[] }>(
        `/api/decisions${params.length ? `?${params.join("&")}` : ""}`,
      );
    },
  });
}

// U2: Kommentare einer Entscheidung (append-only). Nur bei aufgeklappter Karte.
export function useDecisionComments(id: string | null) {
  return useQuery({
    queryKey: ["decision-comments", id],
    enabled: id !== null && id !== "",
    queryFn: () => apiFetch<{ comments: DecisionComment[] }>(`/api/decision-comments?id=${encodeURIComponent(id ?? "")}`),
  });
}

// U2: Entscheidung kommentieren / archivieren / revidieren. Nach dem Schreiben
// Log + Einzel-Item invalidieren, damit Kette und Markierungen sofort stimmen.
function useDecisionMutation<V, R>(path: string, extra?: (id: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V & { id: string }) => apiPost<R>(path, v),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["decisions"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
      void qc.invalidateQueries({ queryKey: ["item"] });
      extra?.((v as { id: string }).id);
    },
  });
}

export function useAddDecisionComment() {
  const qc = useQueryClient();
  return useDecisionMutation<{ text: string }, { comments: DecisionComment[] }>(
    "/api/decision-comment",
    (id) => void qc.invalidateQueries({ queryKey: ["decision-comments", id] }),
  );
}

export function useArchiveDecision() {
  return useDecisionMutation<{ archived: boolean }, { item: Item }>("/api/decision-archive");
}

export function useReviseDecision() {
  return useDecisionMutation<{ title: string; answer: string }, { item: Item }>("/api/decision-revise");
}

export function searchTurns(query: string, scope: Scope): Promise<{ hits: TurnHit[] }> {
  const extra = scope.mode === "single" ? `&project=${encodeURIComponent(scope.project)}` : "";
  return apiFetch<{ hits: TurnHit[] }>(`/api/search?q=${encodeURIComponent(query)}${extra}`);
}

// Nach jeder Statusänderung Query-Invalidierung statt optimistischem Update
// (PLAN-PRD §5) — SQLite-Refetch ist billig.
function useInvalidateAfterChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["status"] });
    void qc.invalidateQueries({ queryKey: ["items"] });
    void qc.invalidateQueries({ queryKey: ["items-done"] });
    // Auch die Einzel-Item-Query (Deep-Link-Karte): sonst zeigt die
    // angepinnte Karte nach dem Antworten stalen Stand ohne Rückmeldung.
    void qc.invalidateQueries({ queryKey: ["item"] });
    void qc.invalidateQueries({ queryKey: ["decisions"] });
  };
}

export function useAnswer() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (v: { id: string; answer: string }) =>
      apiPost<{ item: Item }>("/api/answer", v),
    onSuccess: invalidate,
  });
}

// Entwurf serverseitig sichern (Paket A, Antwort-Flow v2): persistiert die
// Antwort, ohne sie zuzustellen. Danach invalidieren, damit item.answer den
// gesicherten Entwurf trägt (Karte kann ihn beim nächsten Öffnen vorbefüllen).
export function useSaveDraft() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (v: { id: string; answer: string }) =>
      apiPost<{ item: Item }>("/api/draft", v),
    onSuccess: invalidate,
  });
}

// erledigt / später / rückgängig -> /api/update (ein kanonischer Pfad, §5).
export function useUpdateStatus() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      apiPost<{ item: Item }>("/api/update", v),
    onSuccess: invalidate,
  });
}

export function useAssist() {
  return useMutation({
    // persona = Expertenlevel, lang = Oberflächensprache (U3) aus den
    // Einstellungen — Haiku antwortet in passender Tonlage UND Sprache.
    mutationFn: (v: { id: string; kind: AssistKind }) =>
      apiPost<{ text: string }>("/api/assist", { ...v, persona: getExpertLevel(), lang: getLocale() }),
  });
}

// Report/Tagebuch: je Einzelauswahl serverseitig gefiltert, sonst voll geladen
// und im Client per keep() auf die Auswahl reduziert (wie useItems).
export function useReport(scope: Scope, days: number) {
  const project = scope.mode === "single" ? scope.project : "";
  return useQuery({
    queryKey: ["report", project, days],
    queryFn: () =>
      apiFetch<{ days: ReportDay[] }>(
        `/api/report?days=${days}${project ? `&project=${encodeURIComponent(project)}` : ""}`,
      ),
  });
}

export function useConfig(scope: Scope) {
  const project = scope.mode === "single" ? scope.project : "";
  return useQuery({
    queryKey: ["config", project],
    queryFn: () =>
      apiFetch<{ entries: ConfigEntry[] }>(
        `/api/config${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      ),
  });
}

// Config-Baukasten (U6): Snippet-Katalog + Apply. Apply mit dryRun=true liefert
// nur die Vorschau (kein Schreiben); ein echtes Apply invalidiert Config+Status.
export function useSnippets() {
  return useQuery({
    queryKey: ["composer-snippets"],
    queryFn: () => apiFetch<{ snippets: SnippetMeta[] }>("/api/composer/snippets"),
  });
}

export function useComposerApply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { project?: string; snippetIds: string[]; dryRun?: boolean }) =>
      apiPost<ComposerApplyResult>("/api/composer/apply", v),
    onSuccess: (r) => {
      if (r.written) {
        void qc.invalidateQueries({ queryKey: ["config"] });
        void qc.invalidateQueries({ queryKey: ["status"] });
      }
    },
  });
}

export function useFile(path: string | null, project?: string | null) {
  return useQuery({
    queryKey: ["file", path, project ?? ""],
    enabled: path !== null && path !== "",
    queryFn: () =>
      apiFetch<FileView>(
        `/api/file?path=${encodeURIComponent(path ?? "")}${project ? `&project=${encodeURIComponent(project)}` : ""}`,
      ),
  });
}

// Datei-Editor: eine im Viewer angezeigte Datei überschreiben. `path` ist der
// aufgelöste Absolutpfad aus dem Read (kein toleranter Fallback beim Schreiben).
export function useWriteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { path: string; content: string }) =>
      apiPost<{ file: string }>("/api/file-write", v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["file"] });
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}

// Verlauf: Session-Liste + Raw-Turns einer Session (Phase 5).
export function useSessions(scope: Scope) {
  const project = scope.mode === "single" ? scope.project : "";
  return useQuery({
    queryKey: ["sessions", project],
    queryFn: () =>
      apiFetch<{ sessions: SessionSummary[] }>(
        `/api/sessions${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      ),
  });
}

export function useSessionTurns(sessionId: string | null) {
  return useQuery({
    queryKey: ["turns", sessionId],
    enabled: sessionId !== null && sessionId !== "",
    queryFn: () =>
      apiFetch<{ turns: SessionTurn[] }>(`/api/turns?session=${encodeURIComponent(sessionId ?? "")}`),
  });
}

// Verlauf B (Meilensteine): Ereignisse dieser Session zum Einweben in die Turns.
export function useSessionMarkers(sessionId: string | null) {
  return useQuery({
    queryKey: ["session-markers", sessionId],
    enabled: sessionId !== null && sessionId !== "",
    queryFn: () =>
      apiFetch<{ markers: SessionMarker[] }>(
        `/api/session-markers?session=${encodeURIComponent(sessionId ?? "")}`,
      ),
  });
}

// Banner-Klickpfad: disableAllHooks aus der settings.json entfernen.
export function useEnableHooks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ changed: boolean }>("/api/hooks-enable", {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });
}

// Projekte-Verwaltung (Paket 5): Liste aller Projekte inkl. archivierter.
export function useProjects() {
  return useQuery({
    queryKey: ["projects-admin"],
    queryFn: () => apiFetch<{ projects: ProjectAdmin[] }>("/api/projects"),
  });
}

// Capture-/Archiv-Toggle bzw. Löschen ändern Auswahl, Kacheln, Badges und
// Listen — daher status/items/decisions mit-invalidieren.
function useProjectMutation<V>(path: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (v: V) => apiPost<{ projects: ProjectAdmin[] }>(path, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects-admin"] });
      invalidate();
    },
  });
}

export function useSetCapture() {
  return useProjectMutation<{ project: string; enabled: boolean }>("/api/project-capture");
}

export function useSetArchived() {
  return useProjectMutation<{ project: string; archived: boolean }>("/api/project-archive");
}

export function useSetGitMode() {
  return useProjectMutation<{ project: string; mode: string }>("/api/project-gitmode");
}

export function useDeleteProject() {
  return useProjectMutation<{ project: string; confirm: boolean }>("/api/project-delete");
}

// CLAUDE.md-Budget-Quellen-Check (Nachtrag 10.07.): Websearch-LLM prüft die
// Anthropic-Doku. Ehrlich: findet er nichts, bleibt found=false + Heuristik.
export function useClaudeMdCheck() {
  return useMutation({
    mutationFn: () => apiPost<BudgetCheckResult>("/api/claudemd-check", {}),
  });
}

// Projekt-Briefing (LLM auf Knopfdruck; degradiert serverseitig auf Rohdaten).
export function useBrief() {
  return useMutation({
    mutationFn: (v: { project: string }) => apiPost<StatusBrief>("/api/brief", v),
  });
}

// A/B-Telemetrie der Karten-Assists (fire-and-forget; Fehler nur in die Konsole,
// Messung darf die Bedienung nie stören).
export function logAssistEvent(
  eventType: "assist_ab" | "assist_adopt",
  payload: { itemId: string; variant?: string; kind?: string },
): void {
  apiPost("/api/events", { eventType, payload }).catch((e) => console.warn("assist-event", e));
}

// --- Git-Tab (Transparenz) ---------------------------------------------------

export function useGitStates() {
  return useQuery({
    queryKey: ["git-states"],
    queryFn: () => apiFetch<{ states: GitStateRow[] }>("/api/git"),
  });
}

// Live-Refresh EINES Projekts (~1 s): aktualisiert den Cache und liefert
// ahead/behind zum lokal bekannten Remote-Stand mit.
export function useGitRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { project: string }) => apiPost<GitRefreshResult>("/api/git-refresh", v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["git-states"] }),
  });
}
