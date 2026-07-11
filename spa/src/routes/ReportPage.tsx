import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useScope } from "@/lib/useScope";
import { useScopedStatus } from "@/lib/useScopedData";
import { useReport } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { shortName } from "@/lib/utils";
import type { ReportDay, ReportDayProject } from "@/api/types";

const TYPE_LABEL: Record<string, string> = {
  blocker: "Blocker",
  question: "Frage",
  proposal: "Vorschlag",
  result: "Ergebnis",
  fyi: "Info",
};

function weekday(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

// /report — Projekt-Tagebuch (Diary): je Tag eine Spalte mit Sessions (Thema =
// erster User-Prompt), Entscheidungen und neuen Items. Horizontal über die
// Zeitachse scrollbar (Scrollbar unten), neueste Tage rechts; beim Laden wird
// ans rechte Ende gescrollt. Onboarding-tauglich: der Verlauf erzählt, was
// wann geliefert und entschieden wurde.
export default function ReportPage() {
  const { scope } = useScope();
  const { status, keep } = useScopedStatus(scope);
  const q = useReport(scope, Math.max(scope.days, 30));
  const scroller = useRef<HTMLDivElement>(null);

  const days: ReportDay[] = (q.data?.days ?? [])
    .map((d) => ({ ...d, projects: d.projects.filter((p) => keep(p.projectPath) || p.projectPath === "") }))
    .filter((d) => d.projects.length > 0);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [q.data]);

  if (q.error || status.error) {
    return <div className="p-5"><ErrorBox error={q.error ?? status.error} onRetry={() => void q.refetch()} /></div>;
  }
  if (q.isLoading || status.isLoading) return <EmptyState title="Lädt…" />;
  if (days.length === 0) {
    return <EmptyState title="Report" hint="Noch keine Aktivität im Zeitraum — Sessions erscheinen hier automatisch." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-5 py-5">
      <h2 className="mb-3 text-[15px] font-semibold">
        Report
        <span className="ml-2 text-xs font-normal text-ink-2">
          Tagebuch der letzten {Math.max(scope.days, 30)} Tage · Sessions, Entscheidungen, neue Items · horizontal scrollen
        </span>
      </h2>
      <div ref={scroller} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-2">
        <div className="flex h-full items-stretch gap-3">
          {days.map((d) => (
            <div key={d.date} className="flex w-[300px] shrink-0 flex-col border border-line bg-panel">
              <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
                {weekday(d.date)}
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
                {d.projects.map((p) => <DayProject key={p.projectPath || "global"} p={p} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DayProject({ p }: { p: ReportDayProject }) {
  const { search } = useLocation();
  // Session-Block springt in die gefilterte Raw-Ansicht des Verlaufs
  // (PO 09.07.) — Auswahl-Query bleibt erhalten.
  const sessionHref = (sessionId: string) => {
    const sp = new URLSearchParams(search);
    sp.set("session", sessionId);
    return { pathname: "/sessions", search: sp.toString() };
  };
  return (
    <div>
      <div className="text-sm font-semibold">{shortName(p.projectPath)}</div>
      {p.sessions.map((s) => (
        <Link
          key={s.sessionId}
          to={sessionHref(s.sessionId)}
          className="mt-1 block border-l-2 border-line pl-2 text-xs text-ink-2 hover:border-accent hover:text-ink"
          title="Gespräch im Verlauf nachlesen"
        >
          <div>
            {s.firstAt.slice(11, 16)}–{s.lastAt.slice(11, 16)} · {s.turns} Turns
          </div>
          {s.firstPrompt && <div className="mt-0.5 line-clamp-3">„{s.firstPrompt}"</div>}
        </Link>
      ))}
      {p.decisions.map((dec) => (
        <div key={dec.id} className="mt-1 border-l-2 border-ok pl-2 text-xs">
          <span className="font-semibold text-ok">✓ Entscheidung:</span> {dec.title}
          {dec.answer && <div className="text-ink-2">↳ {dec.answer}</div>}
        </div>
      ))}
      {p.newItems.map((it) => (
        <div key={it.id} className="mt-1 border-l-2 border-warn/60 pl-2 text-xs text-ink-2">
          {TYPE_LABEL[it.type] ?? it.type}: {it.title}
        </div>
      ))}
    </div>
  );
}
