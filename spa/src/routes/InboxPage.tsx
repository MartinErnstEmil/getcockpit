import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { useScope } from "@/lib/useScope";
import { scopeToParams, isActionable, isInboxOpen, isLog, isPostponed } from "@/lib/scope";
import { useScopedStatus, useScopedItems } from "@/lib/useScopedData";
import { useAnswer, useSaveDraft, useUpdateStatus, useAssist, useItem, useDoneItems } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import ItemCard, { STATUS_LABEL } from "@/components/ItemCard";
import Toast, { type ToastState } from "@/components/Toast";
import { cn, shortName } from "@/lib/utils";
import type { Item } from "@/api/types";

const PRIO: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

// Default-Sortierung "Dringlichkeit": Blocker zuerst, dann Priorität, dann
// älteste zuerst (Bestand).
function sortUrgency(a: Item, b: Item): number {
  const ab = (a.type === "blocker" ? 0 : 1) - (b.type === "blocker" ? 0 : 1);
  if (ab) return ab;
  const pr = (PRIO[a.priority] ?? 2) - (PRIO[b.priority] ?? 2);
  if (pr) return pr;
  return a.createdAt < b.createdAt ? -1 : 1;
}

type SortKey = "urgency" | "newest" | "oldest" | "seq";

function sorter(key: SortKey): (a: Item, b: Item) => number {
  switch (key) {
    case "newest":
      return (a, b) => (a.createdAt > b.createdAt ? -1 : 1);
    case "oldest":
      return (a, b) => (a.createdAt < b.createdAt ? -1 : 1);
    case "seq":
      // Sequenz ist projektlokal — sortiert gruppiert nach Projekt, darin 1-2-3.
      return (a, b) => {
        const pp = (a.projectPath ?? "").localeCompare(b.projectPath ?? "");
        if (pp) return pp;
        return (a.projectSeq ?? 0) - (b.projectSeq ?? 0);
      };
    default:
      return sortUrgency;
  }
}

// Die vier Anzeigen (PO-Entscheid 09.07., Auflage-T3-Änderung): Default zeigt
// nur Handlungspflichtiges; Log ist der ruhige Ablagestrom; Später/Erledigt
// sind Sekundär-Nachschau (keine gleichrangigen Chips).
const CHIPS = [
  { key: "waiting", label: "Wartet auf dich" },
  { key: "blocker", label: "Blocker" },
  { key: "proposal", label: "Vorschläge" },
  { key: "log", label: "Log" },
] as const;

type Lens = "waiting" | "blocker" | "proposal" | "log" | "later" | "done" | "open";

const EMPTY_TEXT: Record<Lens, string> = {
  waiting: "Nichts wartet auf dich — alle Fragen, Blocker und Vorschläge sind beantwortet.",
  blocker: "Keine Blocker. Gut so.",
  proposal: "Keine offenen Vorschläge.",
  log: "Noch nichts protokolliert — Ergebnisse und Notizen der Agenten erscheinen hier.",
  later: "Nichts zurückgestellt.",
  done: "Nichts erledigt.",
  open: "Inbox leer — Fragen erscheinen hier, sobald Agenten welche stellen.",
};

function parseLens(raw: string | null): Lens {
  return raw === "blocker" || raw === "proposal" || raw === "log" || raw === "later" || raw === "done" || raw === "open"
    ? raw
    : "waiting";
}

// /inbox — Inbox nach Dringlichkeit (PLAN-PRD §6.3). Chips sind eine getrennte,
// aufhebbare Achse neben der Header-Projektauswahl (Auflage P7).
export default function InboxPage() {
  const { scope } = useScope();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { status, keep } = useScopedStatus(scope);
  const { items, inScopeItems, hiddenByPeriod } = useScopedItems(scope, keep);

  const lens = parseLens(params.get("filter"));
  // Default "Neueste zuerst" (PO-Entscheid 09.07.) — Dringlichkeit ist Option.
  const sortKey: SortKey =
    params.get("sort") === "urgency" || params.get("sort") === "oldest" || params.get("sort") === "seq"
      ? (params.get("sort") as SortKey)
      : "newest";
  const deepItem = params.get("item");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [toast, setToast] = useState<ToastState | null>(null);
  // Entwürfe (Auswahl-Klicks + Bemerkungen) überleben Seitenwechsel und
  // Reload (Bug 10.07.: Eingaben flogen beim Kartenwechsel raus).
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("cockpit-drafts") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    sessionStorage.setItem("cockpit-drafts", JSON.stringify(drafts));
  }, [drafts]);
  const [answeredLocal, setAnsweredLocal] = useState<Array<{ id: string; title: string; answer: string; projectPath?: string }>>([]);
  const undoRef = useRef<{ id: string; prevStatus: string; at: number } | null>(null);

  const answer = useAnswer();
  const saveDraft = useSaveDraft();
  const updateStatus = useUpdateStatus();
  const assist = useAssist();

  // Erledigt-Nachschau lädt nur bei Bedarf (eigener Satz, eigene Kappe).
  const doneQ = useDoneItems(scope, lens === "done");
  const doneItems = useMemo(
    () => (doneQ.data?.items ?? []).filter((i) => keep(i.projectPath)),
    [doneQ.data?.items, keep],
  );

  // Chip-Counts: immer die volle Prädikat-Zahl innerhalb der Header-Auswahl,
  // unabhängig vom aktiven Chip. Alle aus DEMSELBEN Set (T3).
  const counts = useMemo(
    () => ({
      waiting: inScopeItems.filter(isActionable).length,
      blocker: inScopeItems.filter((i) => isActionable(i) && i.type === "blocker").length,
      proposal: inScopeItems.filter((i) => isActionable(i) && i.type === "proposal").length,
      log: inScopeItems.filter(isLog).length,
      later: inScopeItems.filter(isPostponed).length,
    }),
    [inScopeItems],
  );

  const lensItems = useMemo(() => {
    switch (lens) {
      case "blocker":
        return inScopeItems.filter((i) => isActionable(i) && i.type === "blocker");
      case "proposal":
        return inScopeItems.filter((i) => isActionable(i) && i.type === "proposal");
      case "log":
        return inScopeItems.filter(isLog);
      case "later":
        return inScopeItems.filter(isPostponed);
      case "done":
        return doneItems;
      case "open":
        // transiente Ansicht der Overview-Kachel "Inbox offen" (alle offenen).
        return inScopeItems.filter(isInboxOpen);
      default:
        return inScopeItems.filter(isActionable);
    }
  }, [lens, inScopeItems, doneItems]);

  // Suche: client-seitig über die geladene Anzeige (Titel, Text, Projektname,
  // #Nummer) — wirkt UND-verknüpft zu Chip und Header-Auswahl.
  const norm = q.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!norm) return lensItems;
    return lensItems.filter((i) => {
      if (i.title.toLowerCase().includes(norm)) return true;
      if ((i.body ?? "").toLowerCase().includes(norm)) return true;
      if (shortName(i.projectPath).toLowerCase().includes(norm)) return true;
      if (i.projectSeq != null && (`#${i.projectSeq}` === norm || String(i.projectSeq) === norm)) return true;
      return false;
    });
  }, [lensItems, norm]);

  // Direktlink ?item=: unabhängig von Auswahl/Status/Kappe über /api/item
  // auflösen und als angepinnte Karte oben zeigen (Auflage P5-Fix).
  const deepQ = useItem(deepItem);
  const deep = deepQ.data?.item ?? null;
  const deepMiss = !!deepItem && deepQ.isError;
  const deepRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!deep) return;
    setFlash(true);
    deepRef.current?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [deep, deep?.id]);

  const list = useMemo(() => {
    const base = deep ? searched.filter((i) => i.id !== deep.id) : searched;
    return [...base].sort(sorter(sortKey));
  }, [searched, sortKey, deep]);

  // "dringend"-Chip unterdrücken, wenn er nichts mehr trennt: >50 % der
  // sichtbaren Karten dringend (Untergrenze 4, sonst greift die Regel zu früh).
  const prioCount = list.filter((i) => i.priority === "urgent" || i.priority === "high").length;
  const showPrio = !(list.length >= 4 && prioCount / list.length > 0.5);

  function setFilter(f: string | null) {
    const p = new URLSearchParams(params);
    if (!f || f === "waiting") p.delete("filter");
    else p.set("filter", f);
    setParams(p, { replace: true });
  }

  function setSort(s: string) {
    const p = new URLSearchParams(params);
    if (s === "newest") p.delete("sort");
    else p.set("sort", s);
    setParams(p, { replace: true });
  }

  // "Zur vollen Inbox": Direktlink schließen und in der Anzeige landen, in der
  // die Karte normal wohnt; liegt sie außerhalb der Auswahl, auf "Alle" weiten.
  function closeDeep() {
    const p = new URLSearchParams(params);
    p.delete("item");
    if (deep) {
      if (isLog(deep)) p.set("filter", "log");
      else if (deep.status === "postponed") p.set("filter", "later");
      else if (deep.status === "done") p.set("filter", "done");
      else p.delete("filter");
      if (!keep(deep.projectPath)) p.set("scope", "all");
    }
    setParams(p, { replace: true });
  }

  function onChipKey(ev: React.KeyboardEvent) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const idx = CHIPS.findIndex((c) => c.key === lens);
    const step = ev.key === "ArrowRight" ? 1 : CHIPS.length - 1;
    setFilter(CHIPS[(Math.max(idx, 0) + step) % CHIPS.length]!.key);
  }

  function showToast(text: string, undo?: () => void) {
    setToast({ text, undoLabel: undo ? "Rückgängig (u)" : undefined, onUndo: undo, key: Date.now() });
  }

  async function doAnswer(item: Item) {
    const text = (drafts[item.id] ?? "").trim();
    if (!text) return;
    await answer.mutateAsync({ id: item.id, answer: text });
    setAnsweredLocal((prev) => [{ id: item.id, title: item.title, answer: text, projectPath: item.projectPath }, ...prev]);
    // Entwurf nach erfolgreicher Antwort aufräumen (sessionStorage).
    setDrafts((d) => {
      const { [item.id]: _gone, ...rest } = d;
      return rest;
    });
    setOpenId(null);
    // Beantwortete Deep-Link-Karte schließen — sonst bleibt sie offen mit
    // altem Stand stehen und es gibt keine sichtbare Rückmeldung.
    if (deepItem && item.id === deep?.id) {
      const p = new URLSearchParams(params);
      p.delete("item");
      setParams(p, { replace: true });
    }
    showToast("Zugestellt — Karte verlässt die Inbox. Geht an die nächste Session, nachlesbar unter Entscheidungen.");
  }

  // Speichern (Paket A): Entwurf serverseitig sichern, ohne zuzustellen. Der
  // lokale sessionStorage-Entwurf bleibt, damit das Feld weiter gefüllt ist.
  async function doSaveDraft(item: Item) {
    const text = (drafts[item.id] ?? "").trim();
    if (!text) return;
    await saveDraft.mutateAsync({ id: item.id, answer: text });
    showToast("Entwurf gespeichert — noch nicht zugestellt. Mit Zustellen wird er verbindlich.");
  }

  async function doStatus(id: string, status: string, label: string) {
    const prev = inScopeItems.find((i) => i.id === id)?.status ?? deep?.status ?? "new";
    await updateStatus.mutateAsync({ id, status });
    undoRef.current = { id, prevStatus: prev, at: Date.now() };
    showToast(label, doUndo);
  }

  function doUndo() {
    const b = undoRef.current;
    if (!b || Date.now() - b.at > 5000) return showToast("Nichts rückgängig zu machen (5-s-Fenster).");
    undoRef.current = null;
    void updateStatus.mutateAsync({ id: b.id, status: b.prevStatus }).then(() => showToast("Rückgängig gemacht."));
  }

  async function runAssist(id: string, kind: Parameters<typeof assist.mutateAsync>[0]["kind"]) {
    return assist.mutateAsync({ id, kind });
  }

  // Tastatur (PLAN-PRD §6.3): j/k wählen, o/Enter öffnen, r antworten, e/p, u, Esc.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (typing) {
        if (ev.key === "Escape") (el as HTMLElement).blur();
        return;
      }
      const cur = list[focusIdx];
      if (ev.key === "j" || ev.key === "k") {
        ev.preventDefault();
        setFocusIdx((i) => (ev.key === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1)));
      } else if ((ev.key === "o" || ev.key === "Enter") && cur) {
        ev.preventDefault();
        setOpenId((o) => (o === cur.id ? null : cur.id));
      } else if (ev.key === "r" && cur) {
        ev.preventDefault();
        setOpenId(cur.id);
      } else if (ev.key === "e" && cur) {
        ev.preventDefault();
        void doStatus(cur.id, "done", "Erledigt");
      } else if (ev.key === "p" && cur) {
        ev.preventDefault();
        void doStatus(cur.id, "postponed", "Auf später gelegt");
      } else if (ev.key === "u") {
        ev.preventDefault();
        doUndo();
      } else if (ev.key === "Escape") {
        setOpenId(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (status.error || items.error) {
    return <div className="p-5"><ErrorBox error={status.error ?? items.error} onRetry={() => { void status.refetch(); void items.refetch(); }} /></div>;
  }
  if (status.isLoading || items.isLoading || (lens === "done" && doneQ.isLoading)) {
    return <EmptyState title="Lädt…" />;
  }

  // Typ-Chips nur, wo der Inhalt gemischt ist — in den Handlungs-Anzeigen sind
  // sie redundant (PO-Entscheid 09.07.).
  const showType = lens === "log" || lens === "open";

  const cardProps = (item: Item, i: number) => ({
    item,
    open: openId === item.id,
    focused: focusIdx === i,
    showPrio,
    showType,
    draft: drafts[item.id] ?? "",
    onDraft: (v: string) => setDrafts((d) => ({ ...d, [item.id]: v })),
    onToggle: () => { setOpenId((o) => (o === item.id ? null : item.id)); setFocusIdx(i); },
    onAnswer: () => doAnswer(item),
    onSaveDraft: () => doSaveDraft(item),
    savingDraft: saveDraft.isPending,
    answering: answer.isPending,
    onStatus: (status: string, label: string) => doStatus(item.id, status, label),
    runAssist,
    assistBusy: assist.isPending,
  });

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 flex flex-wrap items-center gap-2 text-[15px] font-semibold">
        Inbox
        {(items.data?.items.length ?? 0) >= 200 && (
          <span className="ds-tag" title="Der Server liefert maximal 200 Items — ältere sind über Suche/Entscheidungen erreichbar.">200+ — neueste 200 geladen</span>
        )}
        {!showPrio && (
          <span className="ml-auto text-xs font-normal text-ink-2">Priorität ausgeblendet — fast alles ist als dringend markiert.</span>
        )}
      </h2>

      {/* Chip-Zeile: vier Anzeigen, genau eine aktiv (Content-Switcher, eckig). */}
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" onKeyDown={onChipKey}>
        {CHIPS.map((c) => {
          const active = lens === c.key;
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(c.key)}
              className={cn(
                "border px-3 py-1.5 text-sm transition-colors",
                active
                  ? "border-accent bg-accent/10 font-semibold text-accent-text"
                  : "border-line text-ink-2 hover:bg-surface-container",
              )}
            >
              {c.label} · <span className="tabular-nums">{counts[c.key]}</span>
            </button>
          );
        })}
      </div>

      {/* Kontroll-Zeile: Suche + Sortierung + Sekundär (Später/Erledigt). */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-[22rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-2" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="In der Inbox suchen …"
            aria-label="In der Inbox suchen"
            className="ds-field !pl-8"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          Sortieren:
          <select value={sortKey} onChange={(e) => setSort(e.target.value)} className="ds-field !w-auto !py-1.5 text-sm">
            <option value="newest">Neueste zuerst</option>
            <option value="urgency">Dringlichkeit</option>
            <option value="oldest">Älteste zuerst</option>
            <option value="seq">Nummer</option>
          </select>
        </label>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setFilter(lens === "later" ? null : "later")}
            className={cn("underline decoration-dotted", lens === "later" ? "font-semibold text-accent-text" : "text-ink-2 hover:text-ink")}
          >
            Später · <span className="tabular-nums">{counts.later}</span>
          </button>
          <button
            type="button"
            onClick={() => setFilter(lens === "done" ? null : "done")}
            className={cn("underline decoration-dotted", lens === "done" ? "font-semibold text-accent-text" : "text-ink-2 hover:text-ink")}
          >
            Erledigt{doneQ.data ? <> · <span className="tabular-nums">{doneItems.length}</span></> : null}
          </button>
        </div>
      </div>

      {hiddenByPeriod > 0 && lens !== "done" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span>
            Zeitraum „{scope.days} Tage": {hiddenByPeriod} ältere {hiddenByPeriod === 1 ? "Karte" : "Karten"} ausgeblendet.
          </span>
          <button
            type="button"
            className="text-accent underline"
            onClick={() => { const p = new URLSearchParams(params); p.set("scope", "all"); p.delete("project"); setParams(p, { replace: true }); }}
          >
            Alle anzeigen
          </button>
        </div>
      )}

      {lens === "done" && (
        <div className="mb-3 text-xs italic text-ink-2">erledigt — nur zur Nachschau</div>
      )}
      {lens === "later" && (
        <div className="mb-3 text-xs italic text-ink-2">zurückgestellt — aus allen Anzeigen ausgeblendet, bis du sie wieder aktiv setzt</div>
      )}
      {lens === "open" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span>Alle offenen Karten (auch nicht Handlungspflichtiges).</span>
          <button type="button" className="text-accent underline" onClick={() => setFilter(null)}>Zu „Wartet auf dich"</button>
        </div>
      )}

      {/* Direktlink: die EINE Zielkarte, vor-aufgeklappt, über der Liste. */}
      {deep && (
        <div ref={deepRef} className={cn("mb-4 transition-colors duration-700", flash && "bg-hl")}>
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
            <span>Direkt geöffnet</span>
            <span className="font-mono">
              {shortName(deep.projectPath)}
              {deep.projectSeq != null && <> #{deep.projectSeq}</>}
            </span>
            <span>· Status: {STATUS_LABEL[deep.status] ?? deep.status}</span>
            {!keep(deep.projectPath) && <span>· aus einer anderen Auswahl</span>}
            {deep.status === "postponed" && (
              <button type="button" className="text-accent underline" onClick={() => void doStatus(deep.id, "new", "Wieder aktiv gesetzt")}>
                Wieder aktiv setzen
              </button>
            )}
            <button type="button" className="text-accent underline" onClick={closeDeep}>Zur vollen Inbox</button>
          </div>
          <ItemCard
            item={deep}
            open
            focused
            showPrio
            showType
            draft={drafts[deep.id] ?? ""}
            onDraft={(v) => setDrafts((d) => ({ ...d, [deep.id]: v }))}
            onToggle={closeDeep}
            onAnswer={() => doAnswer(deep)}
            onSaveDraft={() => doSaveDraft(deep)}
            savingDraft={saveDraft.isPending}
            answering={answer.isPending}
            onStatus={(status, label) => doStatus(deep.id, status, label)}
            runAssist={runAssist}
            assistBusy={assist.isPending}
          />
        </div>
      )}

      {deepMiss && (
        <div className="mb-4 border-l-4 border-accent bg-panel px-4 py-3 text-sm text-ink-2">
          Dieses Item ist nicht (mehr) auffindbar — evtl. schon beantwortet, erledigt oder entfernt.{" "}
          <button type="button" className="text-accent underline" onClick={() => navigate({ pathname: "/decisions", search: scopeToParams(scope).toString() })}>In Entscheidungen ansehen</button>
          {" · "}
          <button type="button" className="text-accent underline" onClick={() => navigate({ pathname: "/search", search: scopeToParams(scope).toString() })}>In der Suche öffnen</button>
        </div>
      )}

      {answeredLocal.map((a) => (
        <div key={a.id} className="ds-card mb-2 px-4 py-3">
          <div className="text-sm font-semibold">{a.title}{a.projectPath && <span className="ml-2 text-xs font-normal text-ink-2">[{shortName(a.projectPath)}]</span>}</div>
          <div className="mt-1.5 bg-hl px-3 py-2 text-sm text-on-primary-container">↳ {a.answer}</div>
          <div className="mt-1 text-xs text-ink-2">
            zugestellt an die nächste Session ·{" "}
            <button type="button" className="text-accent underline" onClick={() => navigate({ pathname: "/decisions", search: scopeToParams(scope).toString() })}>in Entscheidungen ansehen</button>
          </div>
        </div>
      ))}

      {list.length === 0 && answeredLocal.length === 0 && !deep ? (
        norm ? (
          <p className="italic text-ink-2">
            Keine Karte passt zu „{q.trim()}" in dieser Ansicht.{" "}
            <button type="button" className="not-italic text-accent underline" onClick={() => setQ("")}>Suche leeren</button>
          </p>
        ) : (
          <div className="text-ink-2">
            <p className="italic">{EMPTY_TEXT[lens]}</p>
            {scope.mode !== "all" && (
              <p className="mt-2 flex flex-wrap gap-3 text-sm">
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => { const p = new URLSearchParams(params); p.set("scope", "all"); p.delete("project"); setParams(p, { replace: true }); }}
                >
                  Alle Projekte zeigen
                </button>
                {lens !== "waiting" && (
                  <button type="button" className="text-accent underline" onClick={() => setFilter(null)}>Zu „Wartet auf dich"</button>
                )}
              </p>
            )}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((item, i) => (
            <ItemCard key={item.id} {...cardProps(item, i)} />
          ))}
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-4 border-t border-line pt-3 text-xs text-ink-2">
        {[["j / k", "Karten"], ["o", "öffnen"], ["r", "antworten"], ["Strg+Enter", "speichern"], ["e", "erledigt"], ["p", "später"], ["u", "rückgängig"], ["Esc", "zurück"]].map(([k, l]) => (
          <span key={k}><kbd className="rounded border border-line px-1 font-mono text-[11px]">{k}</kbd> {l}</span>
        ))}
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
