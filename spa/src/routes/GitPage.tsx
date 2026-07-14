import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Copy, RefreshCw, Sparkles } from "lucide-react";
import { useGitStates, useGitRefresh, useGitLog, useGitGraph, useGitAssist } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import GitGraph from "@/components/GitGraph";
import { ageText, cn, shortName } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { gitAdvisoryVisible } from "@/lib/gitmode";
import { deriveGitActions, type GitAction } from "@/lib/gitactions";
import { parseTriage } from "@/lib/triage";
import type { GitStateRow } from "@/api/types";

// /git — Git-Transparenz. Zwei Subtabs: "Übersicht" (Karten je Projekt aus dem
// Cache, live aktualisierbar) und "Graph" (Commit-Graph eines Projekts).
// GRUNDSATZ (D10, unangetastet): Cockpit ZEIGT und EMPFIEHLT — es führt selbst
// nie git-Kommandos aus, die den Stand ändern. Handeln passiert per kopiertem
// Kommando oder über die eigene Claude-Session ("An meine Session übergeben").
export default function GitPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "graph" ? "graph" : "overview";
  const setTab = (t: "overview" | "graph") => {
    const p = new URLSearchParams(params);
    if (t === "graph") p.set("tab", "graph");
    else p.delete("tab");
    setParams(p);
  };

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 text-[15px] font-semibold">Git</h2>
      <div className="mb-4 flex gap-1 border-b border-line text-sm">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>Übersicht</TabButton>
        <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>Graph</TabButton>
      </div>
      {tab === "overview" ? <GitOverview /> : <GitGraphView />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 py-1.5",
        active ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

// --- Übersicht ---------------------------------------------------------------

function GitOverview() {
  const q = useGitStates();
  if (q.error) return <div className="py-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  const states = q.data?.states ?? [];
  return (
    <>
      <p className="mb-4 max-w-[80ch] text-sm text-ink-2">
        Stand aller erfassten Repos — aus dem Cache der letzten Session, je Karte live aktualisierbar.
        Cockpit zeigt und empfiehlt nur; festhalten (committen) und hochladen (pushen) bleibt bei dir
        bzw. deinen Sessions.
      </p>
      {states.length === 0 ? (
        <EmptyState title="Noch kein Git-Stand erfasst" hint="Der Stand entsteht automatisch mit der nächsten Claude-Code-Session in einem Git-Repo (Stop-Hook)." />
      ) : (
        <div className="space-y-2">
          {states.map((s) => <GitCard key={s.projectPath} s={s} />)}
        </div>
      )}
    </>
  );
}

// Kleiner Kopier-Button mit "Kopiert!"-Rückmeldung (mehrfach genutzt).
function CopyChip({ text, label, icon }: { text: string; label: string; icon?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
          () => {}, // Zwischenablage blockiert (Fokus/Policy) — kein Crash, nur kein Feedback.
        );
      }}
      className="ds-btn-ghost flex items-center gap-1 border border-line text-xs"
    >
      {icon}
      {copied ? "Kopiert!" : label}
    </button>
  );
}

function GitCard({ s }: { s: GitStateRow }) {
  const t = useT();
  // Die per-Karte-Mutation hält Ergebnis/Ladezustand/Fehler selbst — kein
  // gespiegelter useState nötig (react-query ist die Quelle der Wahrheit).
  const refresh = useGitRefresh();
  const [expanded, setExpanded] = useState(false);

  const live = refresh.data ?? null;
  const refreshing = refresh.isPending;
  const rowError = refresh.error ? (refresh.error instanceof Error ? refresh.error.message : String(refresh.error)) : null;
  const doRefresh = () => refresh.mutate({ project: s.projectPath });

  // Beim ersten Aufklappen automatisch live lesen — die Handlungsempfehlungen
  // brauchen ahead/behind (nur im Live-Refresh), sonst blieben sie halbblind.
  useEffect(() => {
    if (expanded && !refresh.data && !refresh.isPending) doRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const ab = live?.aheadBehind; // {ahead,behind} | null | undefined
  const snap = live?.lastSnapshot;
  const advisory = gitAdvisoryVisible(s.gitMode);
  const actions = advisory
    ? deriveGitActions({
        branch: s.branch,
        dirtyFiles: s.dirtyFiles,
        aheadBehind: ab,
        snapshotUnmerged: snap?.unmerged,
      })
    : [];

  return (
    <div className="ds-card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1 font-semibold hover:text-accent-text">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {shortName(s.projectPath)}
        </button>
        <span className="font-mono text-xs text-ink-2">{s.branch ?? "?"}</span>
        {/* Terminologie (Review C3): "festhalten" statt "gesichert" — committen ist
            ein lokaler Akt, kein Backup. Das Wort "gesichert" ist verboten. */}
        <span className={s.dirtyFiles > 0 ? "text-warn" : "text-ink-2"}>
          {s.dirtyFiles > 0 ? `${s.dirtyFiles} nicht festgehalten` : "alles festgehalten"}
        </span>
        <Link to="/settings" className="ds-tag hover:underline" title={t("git.modeChip.tip")}>
          {t(`settings.git.mode.${s.gitMode}`)}
        </Link>
        {s.gitMode === "auto" && snap && (
          <span className="text-xs text-ink-2" title={snap.ref}>letzte Auto-Sicherung: {ageText(snap.at)}</span>
        )}
        {ab !== undefined && (
          <span className="font-mono text-xs text-ink-2" title="nur lokal (↑) / hinter dem Remote (↓)">
            {ab === null ? "kein Remote" : `↑${ab.ahead} ↓${ab.behind}`}
          </span>
        )}
        <span className="ml-auto text-xs text-ink-2" title="Alter des Cache-Stands">Stand: {ageText(s.updatedAt)}</span>
        <button
          type="button"
          disabled={refreshing}
          onClick={doRefresh}
          className="ds-btn-ghost flex items-center gap-1 border border-line"
          title="Live vom Repo lesen (inkl. Vorsprung/Rückstand zum Remote)"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Liest…" : "Aktualisieren"}
        </button>
      </div>

      {/* Zwei jüngste Commits als Kurzform bleiben immer sichtbar. */}
      {s.recentCommits.length > 0 && !expanded && (
        <div className="mt-1.5 font-mono text-xs text-ink-2">
          {s.recentCommits.slice(0, 2).map((c) => (
            <div key={c.sha}>{c.sha.slice(0, 7)} {c.subject}</div>
          ))}
        </div>
      )}

      {advisory && actions.length > 0 && <GitActions actions={actions} project={s.projectPath} />}

      {expanded && <ExpandedLog project={s.projectPath} />}

      {rowError && (
        <div className="mt-2 border-l-4 border-crit bg-panel px-3 py-1.5 text-xs text-ink-2">{rowError}</div>
      )}
    </div>
  );
}

// Handlungsempfehlungen + Wege (Slice 1). Jede Karte: Klartext, das exakte
// Kommando zum Kopieren (falls sicher) und "An meine Session übergeben" — der
// disziplin-treue Weg. Plus EIN "Was jetzt?" (Haiku) je Projekt (Slice 3).
function GitActions({ actions, project }: { actions: GitAction[]; project: string }) {
  return (
    <div className="mt-2 space-y-1.5">
      {actions.map((a) => (
        <div
          key={a.kind}
          className={cn(
            "border-l-4 bg-panel px-3 py-1.5 text-xs text-ink-2",
            a.severity === "warn" ? "border-warn" : "border-line",
          )}
        >
          <div className="font-semibold text-ink">{a.title}</div>
          <div className="mt-0.5">{a.detail}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {a.command && (
              <>
                <code className="rounded bg-ground px-1.5 py-0.5 font-mono text-[11px]">{a.command}</code>
                <CopyChip text={a.command} label="Kommando kopieren" icon={<Copy className="h-3 w-3" />} />
              </>
            )}
            <CopyChip text={a.sessionPrompt} label="An meine Session übergeben" />
          </div>
        </div>
      ))}
      <GitAssist project={project} />
    </div>
  );
}

// Slice 3: Haiku-"Was jetzt?" — erklärt den Zustand und schlägt Wege vor.
// Flüchtig, nicht persistiert. Rendert über den triage-JSON-Vertrag; bei
// unparsebarer Ausgabe zeigen wir den Rohtext als einfache Erklärung.
function GitAssist({ project }: { project: string }) {
  // Ergebnis/Fehler kommen direkt aus der Mutation (react-query resettet beide
  // beim nächsten mutate) — kein gespiegelter useState nötig.
  const assist = useGitAssist();
  const out = assist.data ?? null;
  const error = assist.error ? (assist.error instanceof Error ? assist.error.message : String(assist.error)) : null;
  const run = () => assist.mutate({ project });

  const triage = out ? parseTriage(out.text) : null;
  return (
    <div className="pt-0.5">
      <button
        type="button"
        onClick={run}
        disabled={assist.isPending}
        className="ds-btn-ghost flex items-center gap-1 border border-line text-xs"
        title="Haiku erklärt deinen Git-Zustand und schlägt Wege vor (nichts wird gespeichert)"
      >
        <Sparkles className={cn("h-3.5 w-3.5", assist.isPending && "animate-pulse")} />
        {assist.isPending ? "Denkt nach…" : "Was jetzt?"}
      </button>
      {error && <div className="mt-1.5 border-l-4 border-crit bg-panel px-3 py-1.5 text-xs text-ink-2">{error}</div>}
      {out && (
        <div className="mt-1.5 border-l-4 border-accent bg-panel px-3 py-2 text-xs text-ink-2">
          <div className="whitespace-pre-wrap">{triage ? triage.explanation : out.text}</div>
          {triage && triage.options.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {triage.options.map((o, i) => (
                <li key={i}><span className="font-semibold text-ink">{o.label}:</span> {o.text}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Aufgeklappte Karte (Slice 1/2): volle Branch-Historie, live geladen.
function ExpandedLog({ project }: { project: string }) {
  const q = useGitLog(project, true);
  if (q.isLoading) return <div className="mt-2 text-xs text-ink-2">Historie lädt…</div>;
  if (q.error) return <div className="mt-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  const commits = q.data?.commits ?? [];
  if (commits.length === 0) return <div className="mt-2 text-xs text-ink-2">Keine Commits.</div>;
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="mb-1 text-[11px] uppercase text-ink-2">Alle Commits (neueste zuerst)</div>
      <div className="max-h-[320px] space-y-0.5 overflow-y-auto font-mono text-xs">
        {commits.map((c) => (
          <div key={c.sha} className="flex gap-2">
            <span className="shrink-0 text-ink-2">{c.sha.slice(0, 7)}</span>
            <span className="truncate text-ink">{c.subject}</span>
            <span className="ml-auto shrink-0 text-ink-2" title={c.at}>{ageText(c.at)}</span>
          </div>
        ))}
      </div>
      {q.data?.hasMore && (
        <div className="mt-1 text-[11px] text-ink-2">Nur die letzten {commits.length} — ältere über die Suche.</div>
      )}
    </div>
  );
}

// --- Graph -------------------------------------------------------------------

function GitGraphView() {
  const q = useGitStates();
  const [project, setProject] = useState<string>("");
  const [snapshots, setSnapshots] = useState(false);
  const [limit, setLimit] = useState(200);

  // Erstes Projekt vorwählen, sobald die Liste da ist.
  const states = q.data?.states ?? [];
  useEffect(() => {
    if (!project && states.length > 0) setProject(states[0]!.projectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.length]);

  if (q.error) return <div className="py-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  if (states.length === 0) return <EmptyState title="Noch kein Git-Stand erfasst" />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="ds-field !w-auto !py-1.5"
        >
          {states.map((s) => (
            <option key={s.projectPath} value={s.projectPath}>{shortName(s.projectPath)}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
          Auto-Sicherungen einblenden
        </label>
      </div>
      {project && <GraphBody project={project} snapshots={snapshots} limit={limit} onMore={() => setLimit((l) => l + 200)} />}
    </div>
  );
}

function GraphBody({ project, snapshots, limit, onMore }: { project: string; snapshots: boolean; limit: number; onMore: () => void }) {
  const q = useGitGraph(project, { snapshots, limit });
  if (q.isLoading) return <EmptyState title="Graph lädt…" />;
  if (q.error) return <div className="py-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  const commits = q.data?.commits ?? [];
  if (commits.length === 0) return <EmptyState title="Keine Commits in diesem Projekt." />;
  return (
    <div className="ds-card p-3">
      <GitGraph commits={commits} />
      {q.data?.limitHit && (
        <button type="button" onClick={onMore} className="ds-btn-ghost mt-2 border border-line text-xs">
          Mehr laden (älter)
        </button>
      )}
    </div>
  );
}
