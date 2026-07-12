import { useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { useGitStates, useGitRefresh } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { ageText, shortName } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { AheadBehind } from "@/api/types";

// /git — Git-Transparenz (PO 11.07.): eine Zeile je Projekt aus dem
// git_state-Cache (Stop-Hook füllt ihn nach jeder Session), gezielt live
// aktualisierbar. Stufe "advisory" des Git-Konzepts: Cockpit ZEIGT und
// EMPFIEHLT — es führt selbst nie git-Kommandos aus, die den Stand ändern.
export default function GitPage() {
  const t = useT();
  const q = useGitStates();
  const refresh = useGitRefresh();
  // ahead/behind ist ein Live-Wert (kommt nur vom Refresh, nie aus dem Cache).
  const [live, setLive] = useState<Record<string, AheadBehind | null>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ project: string; message: string } | null>(null);

  if (q.error) return <div className="p-5"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  const states = q.data?.states ?? [];

  function doRefresh(project: string) {
    setRefreshing(project);
    setRowError(null);
    refresh.mutate(
      { project },
      {
        onSuccess: (r) => setLive((m) => ({ ...m, [project]: r.aheadBehind })),
        onError: (e) => setRowError({ project, message: e instanceof Error ? e.message : String(e) }),
        onSettled: () => setRefreshing(null),
      },
    );
  }

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-1 text-[15px] font-semibold">Git</h2>
      <p className="mb-4 max-w-[80ch] text-sm text-ink-2">
        Stand aller erfassten Repos — aus dem Cache der letzten Session, je Zeile live aktualisierbar.
        Cockpit zeigt und empfiehlt nur; committen und pushen bleibt bei dir bzw. deinen Sessions.
      </p>
      {states.length === 0 ? (
        <EmptyState title="Noch kein Git-Stand erfasst" hint="Der Stand entsteht automatisch mit der nächsten Claude-Code-Session in einem Git-Repo (Stop-Hook)." />
      ) : (
        <div className="space-y-2">
          {states.map((s) => {
            const ab = live[s.projectPath];
            const hints: string[] = [];
            if (s.dirtyFiles > 0) hints.push(`${s.dirtyFiles} ungesicherte ${s.dirtyFiles === 1 ? "Datei" : "Dateien"} — Commit fällig?`);
            if (ab && ab.ahead > 0) hints.push(`${ab.ahead} Commit${ab.ahead === 1 ? "" : "s"} nicht gepusht`);
            if (ab && ab.behind > 0) hints.push(`${ab.behind} hinter dem Remote — pull/rebase prüfen`);
            return (
              <div key={s.projectPath} className="ds-card px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                  <span className="font-semibold">{shortName(s.projectPath)}</span>
                  <span className="font-mono text-xs text-ink-2">{s.branch ?? "?"}</span>
                  <span className={s.dirtyFiles > 0 ? "text-warn" : "text-ink-2"}>
                    {s.dirtyFiles > 0 ? `${s.dirtyFiles} ungesichert` : "sauber"}
                  </span>
                  {/* Modus-Chip: nur Anzeige; geschaltet wird in den Settings.
                      Für mode='auto' füllt G4 hier zusätzlich "letzter Snapshot". */}
                  <Link to="/settings" className="ds-tag hover:underline" title={t("git.modeChip.tip")}>
                    {t(`settings.git.mode.${s.gitMode}`)}
                  </Link>
                  {ab !== undefined && (
                    <span className="font-mono text-xs text-ink-2">
                      {ab === null ? "kein Upstream" : `↑${ab.ahead} ↓${ab.behind}`}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-ink-2" title="Alter des Cache-Stands">Stand: {ageText(s.updatedAt)}</span>
                  <button
                    type="button"
                    disabled={refreshing === s.projectPath}
                    onClick={() => doRefresh(s.projectPath)}
                    className="ds-btn-ghost flex items-center gap-1 border border-line"
                    title="Live vom Repo lesen (inkl. Vorsprung/Rückstand zum Remote)"
                  >
                    <RefreshCw className={refreshing === s.projectPath ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                    {refreshing === s.projectPath ? "Liest…" : "Aktualisieren"}
                  </button>
                </div>
                {s.recentCommits.length > 0 && (
                  <div className="mt-1.5 font-mono text-xs text-ink-2">
                    {s.recentCommits.slice(0, 2).map((c) => (
                      <div key={c.sha}>{c.sha.slice(0, 7)} {c.subject}</div>
                    ))}
                  </div>
                )}
                {hints.length > 0 && (
                  <div className="mt-2 border-l-4 border-warn bg-panel px-3 py-1.5 text-xs text-ink-2">
                    {hints.join(" · ")}
                  </div>
                )}
                {rowError?.project === s.projectPath && (
                  <div className="mt-2 border-l-4 border-crit bg-panel px-3 py-1.5 text-xs text-ink-2">{rowError.message}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
