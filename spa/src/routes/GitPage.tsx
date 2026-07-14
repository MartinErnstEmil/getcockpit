import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Copy, RefreshCw, Rocket, Sparkles } from "lucide-react";
import { useGitStates, useGitRefresh, useGitLog, useGitGraph, useGitAssist, useShip, useCiStatus, useCiAssist } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import GitGraph from "@/components/GitGraph";
import { ageText, cn, errText, shortName } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { gitAdvisoryVisible } from "@/lib/gitmode";
import { deriveGitActions, type GitAction } from "@/lib/gitactions";
import { deriveShipPlan, type DeployTarget, type ReadinessGate } from "@/lib/shipplan";
import { parseTriage } from "@/lib/triage";
import type { GitStateRow, CiState, CiStatus } from "@/api/types";

// /git — Git-Transparenz. Zwei Subtabs: "Übersicht" (Karten je Projekt aus dem
// Cache, live aktualisierbar) und "Graph" (Commit-Graph eines Projekts).
// GRUNDSATZ (D10, unangetastet): Cockpit ZEIGT und EMPFIEHLT — es führt selbst
// nie git-Kommandos aus, die den Stand ändern. Handeln passiert per kopiertem
// Kommando oder über die eigene Claude-Session ("An meine Session übergeben").
type GitTab = "overview" | "graph" | "live";

export default function GitPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: GitTab = raw === "graph" || raw === "live" ? raw : "overview";
  const setTab = (t: GitTab) => {
    const p = new URLSearchParams(params);
    if (t === "overview") p.delete("tab");
    else p.set("tab", t);
    setParams(p);
  };

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 text-[15px] font-semibold">Git</h2>
      <div className="mb-4 flex gap-1 border-b border-line text-sm">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>Übersicht</TabButton>
        <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>Graph</TabButton>
        <TabButton active={tab === "live"} onClick={() => setTab("live")}>Live</TabButton>
      </div>
      {tab === "overview" && <GitOverview />}
      {tab === "graph" && <GitGraphView />}
      {tab === "live" && <ShipView />}
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

// Exaktes Kommando als mono-Chip + Kopier-Button (mehrfach: Git-Actionables,
// Deploy-Ziel, Startklar-Gate).
function CommandChip({ command }: { command: string }) {
  return (
    <>
      <code className="rounded bg-ground px-1.5 py-0.5 font-mono text-[11px]">{command}</code>
      <CopyChip text={command} label="Kommando kopieren" icon={<Copy className="h-3 w-3" />} />
    </>
  );
}

// Gemeinsame Ausgabe eines Assist-Laufs (Git wie CI): Fehler-Box bzw.
// Erklärung + Handlungsoptionen aus dem triage-Vertrag. Ein Codepfad für beide.
function TriageOutput({ out, error }: { out: { text: string } | null; error: string | null }) {
  const triage = useMemo(() => (out ? parseTriage(out.text) : null), [out]);
  return (
    <>
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
    </>
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
  const rowError = errText(refresh.error);
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
            {a.command && <CommandChip command={a.command} />}
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
  return (
    <div className="pt-0.5">
      <button
        type="button"
        onClick={() => assist.mutate({ project })}
        disabled={assist.isPending}
        className="ds-btn-ghost flex items-center gap-1 border border-line text-xs"
        title="Haiku erklärt deinen Git-Zustand und schlägt Wege vor (nichts wird gespeichert)"
      >
        <Sparkles className={cn("h-3.5 w-3.5", assist.isPending && "animate-pulse")} />
        {assist.isPending ? "Denkt nach…" : "Was jetzt?"}
      </button>
      <TriageOutput out={assist.data ?? null} error={errText(assist.error)} />
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

// --- Live (Ship) -------------------------------------------------------------
// Slice 1: lokal, kein Netz, keine Ausführung. Erkennt je Projekt den Weg ins
// Netz (Deploy-Ziel) und das Test/Build-Gate und reicht das Handeln an die
// eigene Session weiter. Der Live-Status (läuft/gestoppt) kommt in Slice 2 (CI).

function ShipView() {
  // Projektliste bewusst aus dem git_state-Cache (useGitStates): der Weg ins
  // Netz setzt ein Git-Repo voraus, und "Live" wohnt im Git-Tab. Nicht-Git-
  // Projekte tauchen hier absichtlich nicht auf.
  const q = useGitStates();
  if (q.error) return <div className="py-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  const states = q.data?.states ?? [];
  return (
    <>
      <p className="mb-4 max-w-[80ch] text-sm text-ink-2">
        Der Weg deiner Projekte ins Netz. Cockpit erkennt, wie ein Projekt live geht, und bereitet
        den nächsten Schritt vor — ausgeführt wird nichts hier; das übernimmst du bzw. deine Session.
      </p>
      {states.length === 0 ? (
        <EmptyState title="Noch keine Projekte erfasst" />
      ) : (
        <div className="space-y-2">
          {states.map((s) => <ShipCard key={s.projectPath} s={s} />)}
        </div>
      )}
    </>
  );
}

function ShipCard({ s }: { s: GitStateRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ds-card px-4 py-3">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2 text-left text-sm">
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Rocket className="h-3.5 w-3.5 shrink-0 text-ink-2" />
        <span className="font-semibold">{shortName(s.projectPath)}</span>
        <span className="ml-auto text-xs text-ink-2">{expanded ? "" : "aufklappen für den Weg ins Netz"}</span>
      </button>
      {expanded && <ShipBody project={s.projectPath} />}
    </div>
  );
}

function ShipBody({ project }: { project: string }) {
  const q = useShip(project, true);
  const plan = useMemo(() => (q.data ? deriveShipPlan(q.data) : null), [q.data]);
  if (q.isLoading) return <div className="mt-2 text-xs text-ink-2">Prüft…</div>;
  if (q.error) return <div className="mt-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (!plan) return null;
  return (
    <div className="mt-2 space-y-3 border-t border-line pt-2">
      <CiBand project={project} />
      <section>
        <div className="mb-1 text-[11px] uppercase text-ink-2">Weg ins Netz (live gehen)</div>
        {plan.targets.length === 0 ? (
          <p className="text-xs text-ink-2">
            Für dieses Projekt ist noch kein Weg ins Netz erkennbar — sobald du eins einrichtest
            (z. B. Vercel, Netlify, Fly.io), erscheint es hier.
          </p>
        ) : (
          <div className="space-y-1.5">{plan.targets.map((t) => <TargetRow key={t.name} t={t} />)}</div>
        )}
      </section>
      <section>
        <div className="mb-1 text-[11px] uppercase text-ink-2">Startklar? (Test / Build)</div>
        <GateRow gate={plan.gate} />
      </section>
    </div>
  );
}

function TargetRow({ t }: { t: DeployTarget }) {
  return (
    <div className="border-l-4 border-line bg-panel px-3 py-1.5 text-xs text-ink-2">
      <div className="font-semibold text-ink">Ziel erkannt: {t.name}</div>
      <div className="mt-0.5">{t.note}</div>
      {t.pushToDeploy && (
        <div className="mt-0.5 text-ink">Wenn es beim Hochladen automatisch live geht, genügt oft: einfach hochladen (push).</div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {/* Hand-to-session ist die Primäraktion (respektiert deploy-discipline). */}
        <CopyChip text={t.sessionPrompt} label="An meine Session übergeben" />
        {t.command && <CommandChip command={t.command} />}
      </div>
    </div>
  );
}

function GateRow({ gate }: { gate: ReadinessGate }) {
  return (
    <div className="border-l-4 border-line bg-panel px-3 py-1.5 text-xs text-ink-2">
      <div>
        {gate.command
          ? "Prüf vor dem Live-Gehen, ob alles grün ist:"
          : "Ich konnte kein Test/Build-Gate erkennen — lass es deine Session prüfen:"}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {gate.command && <CommandChip command={gate.command} />}
        <CopyChip text={gate.sessionPrompt} label="An meine Session übergeben" />
      </div>
    </div>
  );
}

// Klartext je CI-Zustand (Review: beruhigen, kein Schuld-Ton; "gestoppt" statt
// "fehlgeschlagen"). tone steuert nur die Rahmenfarbe.
const CI_VIEW: Record<CiState, { tone: "ok" | "crit" | "warn" | "info"; title: string; detail: (s: CiStatus) => string }> = {
  "no-gh": { tone: "info", title: "Live-Status nicht verfügbar", detail: () => "Dafür brauche ich das GitHub-Werkzeug gh. Installier es und logge dich mit „gh auth login“ ein." },
  "no-auth": { tone: "info", title: "Noch nicht bei GitHub eingeloggt", detail: () => "Logge dich einmal mit „gh auth login“ ein, dann sehe ich deinen Prüf-Status." },
  "no-remote": { tone: "info", title: "Kein Remote", detail: () => "Dieses Projekt hat kein origin-Remote — es gibt nichts zu prüfen." },
  "non-github": { tone: "info", title: "Läuft nicht über GitHub", detail: (s) => `Dein Remote liegt bei ${s.host ?? "einem anderen Host"}, nicht GitHub — den Prüf-Status kann ich hier nicht lesen.` },
  unpushed: { tone: "warn", title: "Noch nicht hochgeladen", detail: () => "Dein letzter Commit ist noch nicht hochgeladen — die Prüfung hat ihn noch nicht gesehen. Erst hochladen (push)." },
  "no-run": { tone: "info", title: "Keine Prüfung für diesen Stand", detail: () => "Für deinen aktuellen Commit ist keine Prüfung gelaufen (vielleicht deckt dein Workflow diesen Branch nicht ab)." },
  running: { tone: "warn", title: "Wird gerade geprüft …", detail: (s) => `Die Prüfung läuft${s.workflowName ? ` (${s.workflowName})` : ""}. Gleich nochmal nachsehen.` },
  passed: { tone: "ok", title: "Startfreigabe — die letzte Prüfung ist grün", detail: (s) => `${s.workflowName ? `${s.workflowName}: ` : ""}Startklar zum Live-Gehen.` },
  // Zuerst beruhigen (Review S1): die laufende Seite ist unberührt.
  failed: { tone: "crit", title: "Prüfung gestoppt", detail: () => "Deine laufende Seite ist davon unberührt — sie läuft weiter mit der letzten funktionierenden Version. Es wurde nur die neue Auslieferung angehalten. Das ist ein Schutz, kein Schaden." },
};

const TONE_STYLE: Record<"ok" | "crit" | "warn" | "info", { border: string; text: string }> = {
  ok: { border: "border-ok", text: "text-ok" },
  crit: { border: "border-crit", text: "text-crit" },
  warn: { border: "border-warn", text: "text-ink" },
  info: { border: "border-line", text: "text-ink" },
};

// CI-Band: fragt NUR auf Klick live bei GitHub nach (nutzt das gh-Login).
function CiBand({ project }: { project: string }) {
  const ci = useCiStatus();
  const status = ci.data;
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase text-ink-2">
        Läuft meine letzte Auslieferung?
        <button
          type="button"
          onClick={() => ci.mutate({ project })}
          disabled={ci.isPending}
          className="ds-btn-ghost border border-line text-xs normal-case"
        >
          {ci.isPending ? "Prüft…" : status ? "Neu prüfen" : "Live prüfen (fragt GitHub)"}
        </button>
      </div>
      {ci.error && <ErrorBox error={ci.error} />}
      {!status && !ci.isPending && !ci.error && (
        <p className="text-xs text-ink-2">Fragt live bei GitHub nach — nur auf Klick, mit deinem gh-Login.</p>
      )}
      {status && <CiResult project={project} status={status} />}
    </section>
  );
}

function CiResult({ project, status }: { project: string; status: CiStatus }) {
  const v = CI_VIEW[status.state];
  const style = TONE_STYLE[v.tone];
  return (
    <div className={cn("border-l-4 bg-panel px-3 py-1.5 text-xs text-ink-2", style.border)}>
      <div className={cn("font-semibold", style.text)}>{v.title}</div>
      <div className="mt-0.5">{v.detail(status)}</div>
      {status.url && (
        <a href={status.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-accent-text underline">
          Prüfung im Browser ansehen
        </a>
      )}
      {status.state === "failed" && status.runId && <CiAssist project={project} status={status} />}
    </div>
  );
}

// Slice 3: Haiku übersetzt den roten Lauf (flüchtig). Spiegelt GitAssist.
function CiAssist({ project, status }: { project: string; status: CiStatus }) {
  const assist = useCiAssist();
  const run = () => {
    if (status.runId) assist.mutate({ project, runId: status.runId, workflowName: status.workflowName });
  };
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={run}
        disabled={assist.isPending}
        className="ds-btn-ghost flex items-center gap-1 border border-line text-xs"
        title="Haiku erklärt den roten Lauf in Klartext (nichts wird gespeichert)"
      >
        <Sparkles className={cn("h-3.5 w-3.5", assist.isPending && "animate-pulse")} />
        {assist.isPending ? "Liest den Log…" : "Woran liegt's?"}
      </button>
      <TriageOutput out={assist.data ?? null} error={errText(assist.error)} />
    </div>
  );
}
