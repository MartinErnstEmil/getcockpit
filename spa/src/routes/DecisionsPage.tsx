import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fileHref, linkifyPaths } from "@/lib/linkify";
import { useScope } from "@/lib/useScope";
import { useScopedStatus } from "@/lib/useScopedData";
import { scopeToParams, type Scope } from "@/lib/scope";
import {
  useAddDecisionComment,
  useArchiveDecision,
  useDecisionComments,
  useDecisions,
  useItem,
  useReviseDecision,
} from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import DeliveryState from "@/components/DeliveryState";
import { shortName, dayMonth } from "@/lib/utils";
import type { DecisionEntry } from "@/api/types";

// /decisions — Entscheidungs-Log (U2). Default zeigt nur den aktuellen Stand;
// „auch ersetzte/archivierte zeigen" (?all=1) blendet die volle Kette ein.
// Karten sind aufklappbar (Body, Kette, Kommentare) und lassen sich revidieren,
// kommentieren und archivieren. Entwürfe erscheinen als eigener, verlinkter Typ.
export default function DecisionsPage() {
  const { scope } = useScope();
  const [params, setParams] = useSearchParams();
  const all = params.get("all") === "1";
  const { keep, notArchived } = useScopedStatus(scope);
  const q = useDecisions(scope, all);

  const toggleAll = (v: boolean) => {
    const p = new URLSearchParams(params);
    if (v) p.set("all", "1");
    else p.delete("all");
    setParams(p, { replace: true });
  };

  // Archivierte Projekte (Paket 5) fallen auch aus dem Entscheidungs-Log.
  const list = (q.data?.decisions ?? []).filter((d) => keep(d.projectPath) && notArchived(d.projectPath));

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 flex items-center gap-3 text-[15px] font-semibold">
        Entscheidungen
        <span className="text-xs font-normal text-ink-2">{list.length} in Auswahl</span>
        <label className="flex items-center gap-1.5 text-xs font-normal text-ink-2" title="Standard zeigt nur den aktuellen Stand; angehakt erscheinen auch ersetzte, verworfene und archivierte Entscheidungen">
          <input type="checkbox" checked={all} onChange={(e) => toggleAll(e.target.checked)} />
          auch ersetzte/archivierte zeigen
        </label>
      </h2>

      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <EmptyState title="Lädt…" />
      ) : list.length === 0 ? (
        <p className="italic text-ink-2">
          Noch keine Entscheidungen — sie entstehen automatisch, wenn du Fragen beantwortest.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((d) => (
            <DecisionCard key={d.id} entry={d} scope={scope} />
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionCard({ entry, scope }: { entry: DecisionEntry; scope: Scope }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const openInInbox = (id: string) => {
    const p = scopeToParams(scope);
    p.set("item", id);
    navigate({ pathname: "/inbox", search: p.toString() });
  };

  // Entwurf: keine Entscheidung, nur ein gespeicherter, nicht zugestellter Stand
  // — als eigene Zeile markiert, Klick führt zur zugehörigen Inbox-Karte.
  if (entry.draft) {
    return (
      <div className="ds-card px-4 py-3">
        <div className="text-xs text-ink-2">
          {dayMonth(entry.createdAt)}
          {entry.projectPath && <> · {shortName(entry.projectPath)}</>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="ds-tag bg-warn/20 text-ink">Entwurf — noch nicht zugestellt</span>
          <button type="button" onClick={() => openInInbox(entry.id)} className="text-left text-sm text-accent underline decoration-dotted">
            {entry.title}
          </button>
        </div>
        {entry.answer && <div className="mt-0.5 truncate text-xs text-ink-2">↳ {entry.answer}</div>}
      </div>
    );
  }

  return (
    <div className="ds-card">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-4 py-3 text-left">
        <span className="mt-0.5 shrink-0 text-ink-2">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className="text-xs text-ink-2">
            {dayMonth(entry.createdAt)}
            {entry.projectPath && <> · {shortName(entry.projectPath)}</>}
            {entry.gitSha && <> · <span className="font-mono">{entry.gitSha.slice(0, 7)}</span></>}
            {entry.archived && <> · <span className="text-warn">archiviert</span></>}
            {entry.supersededById && <> · <span className="text-crit">ersetzt</span></>}
          </span>
          <span className="block text-sm font-semibold">{entry.title}</span>
          {entry.answer && <span className="block truncate text-xs text-ink-2">↳ {entry.answer}</span>}
        </span>
      </button>
      {open && <DecisionDetail entry={entry} onOpenInInbox={openInInbox} />}
    </div>
  );
}

function DecisionDetail({ entry, onOpenInInbox }: { entry: DecisionEntry; onOpenInInbox: (id: string) => void }) {
  const itemQ = useItem(entry.id);
  const item = itemQ.data?.item;
  const archive = useArchiveDecision();
  const revise = useReviseDecision();
  const [revising, setRevising] = useState(false);
  const [rTitle, setRTitle] = useState(entry.title);
  const [rAnswer, setRAnswer] = useState(entry.answer ?? "");

  return (
    <div className="space-y-3 border-t border-line px-4 py-3">
      {item?.body && (
        <div className="max-w-[74ch] whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
          {linkifyPaths(item.body, entry.projectPath)}
        </div>
      )}
      {entry.answer && <div className="bg-hl px-3 py-2 text-sm text-on-primary-container">↳ {entry.answer}</div>}
      {/* Zustell-Quittung: für beantwortete Entscheidungen dieselbe Zeile wie
          in der Inbox — hier entsteht das Vertrauen "meine Antwort kam an". */}
      {item && <DeliveryState item={item} />}
      {entry.anchorFile && (
        <div className="font-mono text-xs">
          <Link to={fileHref(entry.anchorFile, entry.anchorLine ?? undefined, entry.projectPath)} className="text-accent underline decoration-dotted">
            {entry.anchorFile}{entry.anchorLine != null ? `:${entry.anchorLine}` : ""}
          </Link>
        </div>
      )}
      {(entry.replacesId || entry.supersededById) && (
        <div className="flex flex-wrap gap-x-4 text-xs text-ink-2">
          {entry.replacesId && (
            <button type="button" onClick={() => onOpenInInbox(entry.replacesId!)} className="text-accent underline decoration-dotted">
              ersetzt eine frühere Entscheidung
            </button>
          )}
          {entry.supersededById && (
            <button type="button" onClick={() => onOpenInInbox(entry.supersededById!)} className="text-crit underline decoration-dotted">
              wurde ersetzt — aktuelle Entscheidung öffnen
            </button>
          )}
        </div>
      )}

      <DecisionComments id={entry.id} />

      {revising ? (
        <div className="space-y-2 border-l-4 border-accent bg-panel px-3 py-3">
          <label className="block text-xs font-semibold uppercase tracking-wider text-accent-text">Revidierte Entscheidung</label>
          <input value={rTitle} onChange={(e) => setRTitle(e.target.value)} placeholder="Titel…" className="ds-field text-sm" />
          <textarea value={rAnswer} onChange={(e) => setRAnswer(e.target.value)} placeholder="Begründung / neuer Stand…" className="ds-field min-h-[56px] resize-y text-sm" />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={revise.isPending || !rTitle.trim() || !rAnswer.trim()}
              onClick={() => revise.mutate({ id: entry.id, title: rTitle, answer: rAnswer }, { onSuccess: () => setRevising(false) })}
              className="ds-btn-primary"
            >
              {revise.isPending ? "Speichert…" : "Als neue Entscheidung speichern"}
            </button>
            <button type="button" onClick={() => setRevising(false)} className="ds-btn-ghost border border-line">Abbrechen</button>
          </div>
          {revise.isError && <p className="text-xs text-crit">Konnte nicht gespeichert werden — erneut versuchen.</p>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <button type="button" onClick={() => { setRTitle(entry.title); setRAnswer(entry.answer ?? ""); setRevising(true); }} className="ds-btn-ghost border border-line">
            Revidieren
          </button>
          <button
            type="button"
            disabled={archive.isPending}
            onClick={() => archive.mutate({ id: entry.id, archived: !entry.archived })}
            className="ds-btn-ghost border border-line"
          >
            {entry.archived ? "Wiederherstellen" : "Archivieren"}
          </button>
        </div>
      )}
    </div>
  );
}

// Kommentar-Faden einer Entscheidung: alle vier Zustände (laden/Fehler/leer/
// Erfolg) explizit, Eingabe darunter.
function DecisionComments({ id }: { id: string }) {
  const q = useDecisionComments(id);
  const add = useAddDecisionComment();
  const [text, setText] = useState("");
  const comments = q.data?.comments ?? [];

  const submit = () => {
    if (!text.trim()) return;
    add.mutate({ id, text }, { onSuccess: () => setText("") });
  };

  return (
    <div className="border border-line bg-panel px-3 py-2.5">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-2">Kommentare</div>
      {q.isLoading ? (
        <p className="text-xs italic text-ink-2">Lädt…</p>
      ) : q.error ? (
        <p className="text-xs text-crit">Kommentare konnten nicht geladen werden.</p>
      ) : comments.length === 0 ? (
        <p className="text-xs italic text-ink-2">Noch keine Kommentare.</p>
      ) : (
        <ul className="space-y-1.5">
          {comments.map((c, i) => (
            <li key={i} className="text-sm">
              <span className="whitespace-pre-wrap">{c.text}</span>
              <span className="ml-2 text-[11px] text-ink-2">{dayMonth(c.at)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Kommentar hinzufügen…"
          className="ds-field !py-1 text-sm"
        />
        <button type="button" disabled={add.isPending || !text.trim()} onClick={submit} className="ds-btn-ghost border border-line shrink-0">
          {add.isPending ? "…" : "Senden"}
        </button>
      </div>
    </div>
  );
}
