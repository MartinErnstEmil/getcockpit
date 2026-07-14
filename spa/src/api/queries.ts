import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "./client";
import type {
  AiHealth,
  AssistKind,
  BudgetCheckResult,
  ComposerApplyResult,
  ConfigDetail,
  ConfigEntry,
  ConfigSnapshotDiff,
  DecisionComment,
  DecisionEntry,
  EnvAssistResponse,
  EnvHistoryEntry,
  EnvProjectView,
  EnvSpecMeta,
  FileView,
  GitGraphResponse,
  GitLogResponse,
  CiStatus,
  GitRefreshResult,
  GitStateRow,
  ShipSignals,
  Item,
  ProjectAdmin,
  ReportDay,
  SessionMarker,
  SelftestResult,
  SessionSummary,
  SessionTurn,
  SnippetMeta,
  StatusBrief,
  StatusResponse,
  TurnHit,
  UpdateInfo,
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

// "Erneut senden" (Zustellung v2): eine tote/unbestätigte Antwort zurück in die
// Outbox — löscht nie die Antwort, nur der Mensch löst das aus.
export function useResendAnswer() {
  const invalidate = useInvalidateAfterChange();
  return useMutation({
    mutationFn: (v: { id: string }) => apiPost<{ item: Item }>("/api/answer-resend", v),
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

// Detail einer Config-Datei (uncommitted-Diff + Snapshot-Historie), LAZY beim
// Aufklappen einer Zeile geholt. `file` ist der Absolutpfad aus der ConfigEntry.
export function useConfigDetail(file: string | null) {
  return useQuery({
    queryKey: ["config-detail", file],
    enabled: file !== null,
    queryFn: () => apiFetch<ConfigDetail>(`/api/config-detail?file=${encodeURIComponent(file ?? "")}`),
  });
}

// Ein einzelner Snapshot mit Inhalt + Vorgänger (für die Diff-Anzeige).
export function useConfigSnapshot(id: number | null) {
  return useQuery({
    queryKey: ["config-snapshot", id],
    enabled: id !== null,
    queryFn: () => apiFetch<ConfigSnapshotDiff>(`/api/config-snapshot?id=${id ?? 0}`),
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

// --- Env-Tab -----------------------------------------------------------------
// Wie useConfig: bei Einzelauswahl serverseitig gefiltert, sonst alle Projekte.
// SICHERHEIT: die Antwort trägt nie einen Wert (nur Namen + gesetzt/leer).
export function useEnv(scope: Scope) {
  const project = scope.mode === "single" ? scope.project : "";
  return useQuery({
    queryKey: ["env", project],
    queryFn: () =>
      apiFetch<{ projects: EnvProjectView[] }>(
        `/api/env${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      ),
  });
}

// Änderungs-Protokoll (Audit, ohne Werte) — erst bei aufgeklappter Historie.
export function useEnvHistory(project: string, key: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["env-history", project, key ?? ""],
    enabled,
    queryFn: () =>
      apiFetch<{ history: EnvHistoryEntry[] }>(
        `/api/env-history?project=${encodeURIComponent(project)}${key ? `&key=${encodeURIComponent(key)}` : ""}`,
      ),
  });
}

// Wert write-only in die echte .env schreiben. Nach Erfolg env + Historie neu
// laden (der Wert selbst kehrt nie zurück — nur present/hasValue ändern sich).
export function useWriteEnvVar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { project: string; key: string; value: string }) =>
      apiPost<{ file: string; created: boolean; backup: string | null }>("/api/env-write", v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["env"] });
      void qc.invalidateQueries({ queryKey: ["env-history"] });
    },
  });
}

// Nicht-geheime Metadaten (warum/wie/was + Link) speichern.
export function useSaveEnvSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { project: string; key: string; why?: string; how?: string; what?: string; link?: string; source?: string }) =>
      apiPost<{ spec: EnvSpecMeta }>("/api/env-spec", v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["env"] });
      void qc.invalidateQueries({ queryKey: ["env-history"] });
    },
  });
}

// Ein-Klick-Fix: .env (+ Backups) in die .gitignore aufnehmen.
export function useEnvGitignore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { project: string }) => apiPost<{ added: string[]; file: string }>("/api/env-gitignore", v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["env"] }),
  });
}

// Haiku-"Anforderungen": Scan + optional genannter Dienst -> annotierte Variablen
// (roher JSON-Text; die Seite parst ihn defensiv). persona/lang wie useAssist.
export function useEnvAssist() {
  return useMutation({
    mutationFn: (v: { project: string; service?: string }) =>
      apiPost<EnvAssistResponse>("/api/env-assist", { ...v, persona: getExpertLevel(), lang: getLocale() }),
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

// Update-Verfügbarkeit (nicht-blockierend, fail-open). 1 h frisch — der Stand
// ändert sich nicht minütlich; kein Retry (offline ist ein gültiges Ergebnis).
export function useUpdate() {
  return useQuery({
    queryKey: ["update"],
    queryFn: () => apiFetch<UpdateInfo>("/api/update"),
    staleTime: 60 * 60 * 1000,
    retry: false,
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

// Zustell-Selbsttest (Zustell-Transparenz): beweist die Kette Hook -> Claim ->
// Injektion auf dieser Maschine, isoliert gegen eine Temp-DB.
export function useDeliverySelftest() {
  return useMutation({
    mutationFn: () => apiPost<SelftestResult>("/api/delivery-selftest", {}),
  });
}

// Projekt-Briefing (LLM auf Knopfdruck; degradiert serverseitig auf Rohdaten).
export function useBrief() {
  return useMutation({
    mutationFn: (v: { project: string }) => apiPost<StatusBrief>("/api/brief", v),
  });
}

// KI-Gesundheit: Diagnose bei Timeout (nur laden, wenn der Panel sichtbar ist).
export function useAiHealth(enabled: boolean) {
  return useQuery({
    queryKey: ["ai-health"],
    enabled,
    queryFn: () => apiFetch<AiHealth>("/api/ai-health"),
  });
}

// Alte (>= 18 h laufende) claude-Sitzungen beenden (nutzer-bestätigt).
export function useTerminateStale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ terminated: number }>("/api/ai-terminate-stale", { confirm: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ai-health"] }),
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

// Slice 2: volle Branch-Historie EINES Projekts, erst bei aufgeklappter Karte
// geladen (enabled). Live, eigenes Server-Budget.
export function useGitLog(project: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["git-log", project],
    enabled: enabled && project !== null && project !== "",
    queryFn: () =>
      apiFetch<GitLogResponse>(`/api/git-log?project=${encodeURIComponent(project ?? "")}&limit=100`),
  });
}

// Slice 2: Commit-Graph EINES Projekts (Graph-Subtab). snapshots blendet die
// refs/cockpit-Auto-Sicherungen ein; limit steuert das (nicht paginierte) Fenster.
export function useGitGraph(project: string | null, opts: { snapshots: boolean; limit: number }) {
  return useQuery({
    queryKey: ["git-graph", project, opts.snapshots, opts.limit],
    enabled: project !== null && project !== "",
    queryFn: () =>
      apiFetch<GitGraphResponse>(
        `/api/git-graph?project=${encodeURIComponent(project ?? "")}&limit=${opts.limit}${opts.snapshots ? "&snapshots=1" : ""}`,
      ),
  });
}

// Slice 3: Haiku-"Was jetzt?" zum Git-Zustand (flüchtig, nicht persistiert).
// persona/lang wie bei useAssist aus den Einstellungen.
export function useGitAssist() {
  return useMutation({
    mutationFn: (v: { project: string }) =>
      apiPost<{ text: string }>("/api/git-assist", { ...v, persona: getExpertLevel(), lang: getLocale() }),
  });
}

// Ship-Tab ("Live") Slice 1: lokale Deploy-/Gate-Signale EINES Projekts, erst
// bei aufgeklappter Karte geladen. Kein Netz serverseitig — nur Datei-Checks.
export function useShip(project: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["ship", project],
    enabled: enabled && project !== null && project !== "",
    queryFn: () => apiFetch<ShipSignals>(`/api/ship?project=${encodeURIComponent(project ?? "")}`),
  });
}

// Slice 2: Live-CI-Status via gh — NUR auf ausdrücklichen Klick (Mutation, nie
// Poll), da es ins Netz geht und den gh-Login des Nutzers nutzt.
export function useCiStatus() {
  return useMutation({
    mutationFn: (v: { project: string }) => apiPost<CiStatus>("/api/ci-status", v),
  });
}

// Slice 3: Haiku übersetzt einen roten Lauf; persona/lang aus den Einstellungen.
export function useCiAssist() {
  return useMutation({
    mutationFn: (v: { project: string; runId: number; workflowName?: string }) =>
      apiPost<{ text: string }>("/api/ci-assist", { ...v, persona: getExpertLevel(), lang: getLocale() }),
  });
}
