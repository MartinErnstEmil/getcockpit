import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useScope } from "@/lib/useScope";
import { inPeriod } from "@/lib/scope";
import { useScopedStatus } from "@/lib/useScopedData";
import { useSessions, useSessionMarkers, useSessionTurns } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { linkifyPathsVsc } from "@/lib/linkify";
import { cn, shortName, dayMonth, ageText } from "@/lib/utils";
import type { SessionMarker, SessionSummary, SessionTurn } from "@/api/types";

// /sessions — Verlauf (Phase 5, Raw-Ansicht): Session-Liste, Klick öffnet das
// Gespräch chronologisch zum Nachlesen. Dateipfade öffnen in VS Code.
export default function SessionsPage() {
  const [params] = useSearchParams();
  const session = params.get("session");
  if (session) return <RawView sessionId={session} />;
  return <SessionList />;
}

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

function SessionList() {
  const { scope } = useScope();
  const [params, setParams] = useSearchParams();
  const { status, keep } = useScopedStatus(scope);
  const q = useSessions(scope);
  const [grouped, setGrouped] = useState(false);

  const sessions = useMemo(() => {
    const base = (q.data?.sessions ?? []).filter(
      (s) => keep(s.projectPath) && inPeriod({ ...s, status: "", type: "", source: "", updatedAt: s.lastAt }, scope),
    );
    if (!grouped) return base; // Server liefert bereits "nach Zeit" (lastAt absteigend)
    return [...base].sort(
      (a, b) => a.projectPath.localeCompare(b.projectPath) || (a.lastAt < b.lastAt ? 1 : -1),
    );
  }, [q.data?.sessions, keep, scope, grouped]);

  if (q.error || status.error) {
    return <div className="p-5"><ErrorBox error={q.error ?? status.error} onRetry={() => { void q.refetch(); void status.refetch(); }} /></div>;
  }
  if (q.isLoading || status.isLoading) return <EmptyState title="Lädt…" />;

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 flex flex-wrap items-center gap-2 text-[15px] font-semibold">
        Verlauf
        <span className="text-xs font-normal text-ink-2">{sessions.length} Sessions · Klick öffnet das Gespräch zum Nachlesen</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs font-normal text-ink-2">
          Sortieren:
          <select value={grouped ? "project" : "time"} onChange={(e) => setGrouped(e.target.value === "project")} className="ds-field !w-auto !py-1.5 text-sm">
            <option value="time">nach Zeit</option>
            <option value="project">nach Projekt</option>
          </select>
        </label>
      </h2>
      {sessions.length === 0 ? (
        <p className="italic text-ink-2">Keine Sessions in dieser Auswahl — Auswahl im Kopf weiten oder „Alle" wählen.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => <SessionRow key={s.sessionId} s={s} onOpen={() => {
            const p = new URLSearchParams(params);
            p.set("session", s.sessionId);
            setParams(p);
          }} />)}
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, onOpen }: { s: SessionSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="ds-card cursor-pointer px-4 py-3 text-left hover:bg-surface-container">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[11px] text-ink-2">{shortName(s.projectPath)}</span>
        <span className="text-sm">{dayMonth(s.firstAt)} {hhmm(s.firstAt)}–{hhmm(s.lastAt)}</span>
        <span className="text-xs text-ink-2">{s.turns} Wortmeldungen</span>
        <span className="ml-auto text-[11px] text-ink-2">{ageText(s.lastAt)}</span>
      </div>
      {s.firstPrompt && <div className="mt-1 line-clamp-2 text-xs text-ink-2">„{s.firstPrompt}"</div>}
    </button>
  );
}

// Verlauf B: Turns und Meilensteine zu EINER chronologischen Spur mergen.
type TimelineEntry =
  | { kind: "turn"; at: string; turn: SessionTurn }
  | { kind: "marker"; at: string; marker: SessionMarker };

function buildTimeline(turns: SessionTurn[], markers: SessionMarker[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...turns.map((t): TimelineEntry => ({ kind: "turn", at: t.timestamp, turn: t })),
    ...markers.map((m): TimelineEntry => ({ kind: "marker", at: m.at, marker: m })),
  ];
  // Stabil nach Zeit; Marker eines Zeitpunkts nach dem Turn zeigen (Wirkung folgt
  // der Ursache), daher turn vor marker bei Gleichstand.
  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === "turn" ? -1 : 1;
  });
}

function RawView({ sessionId }: { sessionId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = useSessionTurns(sessionId);
  const markersQ = useSessionMarkers(sessionId);

  if (q.error) return <div className="p-5"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  const turns = q.data?.turns ?? [];
  const markers = markersQ.data?.markers ?? [];
  const project = turns[0]?.projectPath ?? null;
  const timeline = buildTimeline(turns, markers);

  const back = () => {
    const p = new URLSearchParams(params);
    p.delete("session");
    setParams(p);
  };

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 flex flex-wrap items-baseline gap-2 text-[15px] font-semibold">
        <button type="button" onClick={back} className="text-accent underline">← Verlauf</button>
        {project && <span className="font-mono text-xs font-normal text-ink-2">{shortName(project)}</span>}
        {turns.length > 0 && (
          <span className="text-xs font-normal text-ink-2">
            {dayMonth(turns[0]!.timestamp)} {hhmm(turns[0]!.timestamp)}–{hhmm(turns[turns.length - 1]!.timestamp)} · {turns.length} Wortmeldungen{markers.length > 0 ? ` · ${markers.length} Meilensteine` : ""} · Dateipfade öffnen in VS Code
          </span>
        )}
      </h2>
      {turns.length === 0 ? (
        <p className="italic text-ink-2">Session nicht gefunden oder ohne erfasste Wortmeldungen.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {timeline.map((e) =>
            e.kind === "turn" ? (
              <div key={e.turn.uuid} className={cn("border-l-[3px] py-1.5 pl-3", e.turn.role === "user" ? "border-accent" : "border-line")}>
                <div className="text-xs text-ink-2">
                  <span className={cn("font-semibold", e.turn.role === "user" && "text-accent-text")}>{e.turn.role === "user" ? "Du" : "Claude"}</span>
                  {" · "}{hhmm(e.turn.timestamp)}
                  {e.turn.isSidechain && <span className="ml-1.5 rounded-full bg-secondary-container px-1.5 text-[10px] uppercase">Subagent</span>}
                </div>
                <pre className="mt-0.5 max-w-[90ch] whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                  {linkifyPathsVsc(e.turn.content, project)}
                  {e.turn.truncated && <span className="italic text-ink-2"> … [gekürzt — Volltext über die Suche]</span>}
                </pre>
              </div>
            ) : (
              <MarkerRow key={`m-${e.marker.kind}-${e.marker.itemId ?? e.marker.sha}-${e.at}`} marker={e.marker} onOpen={navigate} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// Meilenstein-Zeile im Gesprächsverlauf (Verlauf B): Entscheidung/Frage sind
// klickbar (springen in Entscheidungen bzw. öffnen die Karte), Commits sind
// informativ (kein Git-Detail-Tab vorhanden).
function MarkerRow({ marker, onOpen }: { marker: SessionMarker; onOpen: (to: string) => void }) {
  const base = "my-0.5 flex items-center gap-2 border-l-[3px] border-ok/50 bg-panel py-1 pl-3 text-xs";
  if (marker.kind === "commit") {
    return (
      <div className={cn(base, "border-line")}>
        <span className="font-semibold text-ink-2">⌥ Commit</span>
        <span className="text-ink-2">{marker.title}</span>
        {marker.sha && <span className="font-mono text-ink-2">{marker.sha.slice(0, 7)}</span>}
        {marker.branch && <span className="text-ink-2">Branch {marker.branch}</span>}
        <span className="ml-auto font-mono text-ink-2">{hhmm(marker.at)}</span>
      </div>
    );
  }
  const isDecision = marker.kind === "decision";
  const label = isDecision ? "✓ Entscheidung festgehalten" : "＋ Neue Frage/Vorschlag abgelegt";
  const to = isDecision ? "/decisions" : `/inbox?item=${encodeURIComponent(marker.itemId ?? "")}`;
  return (
    <button type="button" onClick={() => onOpen(to)} className={cn(base, "w-full text-left hover:bg-surface-container")}>
      <span className="font-semibold text-ok">{label}:</span>
      <span className="truncate text-ink-2">{marker.title}</span>
      <span className="ml-auto shrink-0 font-mono text-ink-2">{hhmm(marker.at)}</span>
    </button>
  );
}
