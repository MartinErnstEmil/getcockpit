import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { cn, shortName, ageText, timeText } from "@/lib/utils";
import DeliveryState from "@/components/DeliveryState";
import { useT } from "@/lib/i18n";
import { useScope } from "@/lib/useScope";
import { ASSISTS, RECOMMENDED_ASSIST, type AssistKind, type Item } from "@/api/types";
import { logAssistEvent } from "@/api/queries";
import { fileHref, linkifyPaths } from "@/lib/linkify";
import {
  getRemark,
  isSelected,
  parseOptionLine,
  selectSingleDraft,
  setRemark,
  toggleMultiDraft,
} from "@/lib/options";
import { abVariant, parseTriage, type Triage } from "@/lib/triage";
import { ApiError } from "@/api/client";

const TYPE_LABEL: Record<string, string> = {
  blocker: "BLOCKER",
  question: "FRAGE",
  proposal: "VORSCHLAG",
  decision: "ENTSCHEIDUNG",
  result: "ERGEBNIS",
  fyi: "INFO",
};

// Status sofort scanbar (Kern-Beschwerde: "sind die schon erledigt?").
export const STATUS_LABEL: Record<string, string> = {
  new: "neu",
  in_progress: "in Arbeit",
  answered: "beantwortet",
  postponed: "später",
  done: "erledigt",
  rejected: "verworfen",
};

// Triage-Ergebnisse überleben Auf-/Zuklappen und Kartenwechsel (Session-
// Lebensdauer): pro Item nur EIN automatischer Haiku-Call.
const triageCache = new Map<string, { triage: Triage | null; raw?: string; error?: string }>();
const abLogged = new Set<string>();

// Inbox-Item-Karte (PLAN-PRD §6.3): Kopfzeile immer sichtbar, Klick klappt EINE
// Karte inline auf (kein Modal). Beim Öffnen läuft automatisch der triage-Assist
// (Haiku): Erklärung + abgeleitete Antwortart (Ja/Nein-Buttons bzw. vorformulierte
// Optionen). Übernahme bleibt explizit — Buttons füllen das Antwortfeld.
export default function ItemCard({
  item,
  open,
  focused,
  showPrio = true,
  showType = false,
  draft,
  onDraft,
  onToggle,
  onAnswer,
  onSaveDraft,
  savingDraft,
  answering,
  onStatus,
  runAssist,
  assistBusy,
}: {
  item: Item;
  open: boolean;
  focused: boolean;
  // false, wenn die Ansicht den "dringend"-Chip unterdrückt (>50 % der
  // sichtbaren Karten dringend — der Chip trennt dann nichts mehr).
  showPrio?: boolean;
  // Typ-Chip nur, wo der Inhalt heterogen ist (Log-Tab): in den
  // Handlungs-Anzeigen ist er redundantes Rauschen (PO-Entscheid 09.07.).
  showType?: boolean;
  draft: string;
  onDraft: (v: string) => void;
  onToggle: () => void;
  // Zustellen (Paket A): macht das Item answered, Zustell-Staffel greift.
  onAnswer: () => void | Promise<void>;
  // Speichern (Paket A): persistiert den Entwurf serverseitig, ohne zuzustellen.
  onSaveDraft: () => void | Promise<void>;
  savingDraft: boolean;
  answering: boolean;
  onStatus: (status: string, label: string) => void;
  runAssist: (id: string, kind: AssistKind) => Promise<{ text: string }>;
  assistBusy: boolean;
}) {
  const { setScope } = useScope();
  const t = useT();
  const [assistOut, setAssistOut] = useState<{ kind: AssistKind; text?: string; error?: string } | null>(null);
  const [assistKind, setAssistKind] = useState<AssistKind | null>(null);
  const [triageState, setTriageState] = useState<"idle" | "loading" | "done" | "error">(
    triageCache.has(item.id) ? "done" : "idle",
  );
  const taRef = useRef<HTMLTextAreaElement>(null);
  // A/B (SWOT vs. Pro/Contra): deterministisch je Item; die Variante wird als
  // empfohlener Button hervorgehoben, Nutzung über assist_ab/assist_adopt gemessen.
  const variant = abVariant(item.id);
  const reco: AssistKind = item.type === "decision" || item.type === "proposal"
    ? variant
    : (RECOMMENDED_ASSIST[item.type] ?? "explain");
  const prioChip = item.priority === "urgent" || item.priority === "high";
  const needsAnswer = item.type === "question" || item.type === "proposal" || item.type === "blocker" || item.type === "decision";
  // Remark-Modus (PO 11.07.): Karten OHNE Entscheidungsbedarf (Info/Ergebnis)
  // tragen keine Entscheidungs-Sprache — das Eingabefeld heißt "Bemerkung",
  // Entscheidungs-Assists (pro-contra/swot/alternativen) entfallen, und das
  // (i)-Panel erklärt Bemerkung statt Entscheidung. Zustellen bleibt: eine
  // Bemerkung erreicht die nächste Session, landet aber NIE im Entscheidungs-
  // Log (decisionsView filtert auf question/proposal/blocker/decision).
  const remarkMode = !needsAnswer;
  const assists = remarkMode ? ASSISTS.filter((a) => a.kind === "explain") : ASSISTS;

  // Antwort-Flow v2 (Paket A): ein Entwurf ist eine gespeicherte, aber noch
  // nicht zugestellte Antwort — answer gesetzt, Status noch nicht 'answered'.
  const hasServerDraft = !!item.answer && item.status !== "answered";
  const [draftSaved, setDraftSaved] = useState(hasServerDraft);
  const [copied, setCopied] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // Nach dem Zustellen zeigt die Karte die Antwort read-only (↳); bis dahin
  // steuern [Zustellen]/[Kopieren] den weiteren Weg, sobald ein Entwurf steht.
  const showDeliver = draftSaved || hasServerDraft;

  // Serverseitig gesicherten Entwurf beim Öffnen ins Antwortfeld holen, wenn
  // lokal (sessionStorage) keiner vorliegt — so überlebt er Reload/Gerätewechsel.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open || seededRef.current) return;
    seededRef.current = true;
    if (!draft && hasServerDraft && item.answer) onDraft(item.answer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard kann in manchen Kontexten blockiert sein — still bleiben,
      // der Text steht weiter im Antwortfeld zum manuellen Kopieren.
    }
  }

  async function onSave() {
    await onSaveDraft();
    setDraftSaved(true);
  }

  useEffect(() => {
    if (!open) return;
    if (!abLogged.has(item.id)) {
      abLogged.add(item.id);
      logAssistEvent("assist_ab", { itemId: item.id, variant });
    }
    // Erfolgreiche Triage wird pro Session gecacht; ein Fehler (Timeout,
    // 429) wird beim nächsten Öffnen erneut versucht.
    if (!needsAnswer || triageState === "loading") return;
    const prev = triageCache.get(item.id);
    if (prev && !prev.error) return;
    setTriageState("loading");
    runAssist(item.id, "triage")
      .then((r) => {
        triageCache.set(item.id, { triage: parseTriage(r.text), raw: r.text });
        setTriageState("done");
      })
      .catch((e) => {
        triageCache.set(item.id, {
          triage: null,
          error: e instanceof ApiError && e.status === 429
            ? "KI gerade ausgelastet — unten manuell 'erklären' drücken."
            : `Claude nicht erreichbar (${e instanceof Error ? e.message : String(e)}). Was du tun kannst: Claude Code installieren/einloggen, dann klappt es von selbst — \`cockpit doctor\` prüft es. Alles andere funktioniert weiter.`,
        });
        setTriageState("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  function adoptText(text: string, kind: string) {
    onDraft(draft ? `${draft}\n\n${text}` : text);
    taRef.current?.focus();
    logAssistEvent("assist_adopt", { itemId: item.id, variant, kind });
  }

  async function onAssist(kind: AssistKind) {
    setAssistKind(kind);
    setAssistOut(null);
    try {
      const r = await runAssist(item.id, kind);
      setAssistOut({ kind, text: r.text });
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 429
        ? `${e.message} — KI gerade ausgelastet, in einer Minute nochmal.`
        : `Claude nicht erreichbar (${e instanceof Error ? e.message : String(e)}). Claude Code installieren/einloggen, dann klappt es — \`cockpit doctor\` prüft es.`;
      setAssistOut({ kind, error: msg });
    } finally {
      setAssistKind(null);
    }
  }

  const cached = triageCache.get(item.id);

  // Linker Farbstreifen als redundanter Kanal (nie der einzige Träger —
  // der Status steht zusätzlich als Text-Chip vorn): Blocker rot, in Arbeit
  // Akzent, sonst neutral.
  const stripe =
    item.type === "blocker" && (item.status === "new" || item.status === "in_progress")
      ? "border-l-crit"
      : item.status === "in_progress"
        ? "border-l-accent"
        : "border-l-line";

  return (
    <div className={cn("ds-card border-l-4", stripe, focused && "outline outline-2 -outline-offset-2 outline-accent")}>
      <div className="flex cursor-pointer flex-wrap items-baseline gap-2 px-4 py-3" onClick={onToggle}>
        {/* Status nur, wenn er etwas sagt: "neu" ist der Normalfall und wäre
            auf jeder Karte reines Rauschen (PO-Entscheid 09.07.). */}
        {item.status !== "new" && (
          <Chip
            className={cn(
              "normal-case tracking-normal",
              item.status === "in_progress" && "border border-accent bg-transparent text-accent-text",
              item.status === "answered" && "bg-transparent text-ok",
              (item.status === "done" || item.status === "postponed") && "bg-transparent text-ink-2",
            )}
          >
            {STATUS_LABEL[item.status] ?? item.status}
          </Chip>
        )}
        {/* BLOCKER immer als Text (Bedeutung nie über Farbe allein — der rote
            Streifen ist nur der Zweitkanal); andere Typen nur im Log. */}
        {(showType || item.type === "blocker") && (
          <Chip className={cn(item.type === "blocker" && "bg-crit/15 text-crit")}>{TYPE_LABEL[item.type] ?? item.type.toUpperCase()}</Chip>
        )}
        {showPrio && prioChip && <Chip className="bg-warn/25 text-ink">dringend</Chip>}
        {/* Referenz-Token: IMMER sichtbar (auch in Einzelauswahl) — Karten ohne
            Projektnamen waren die Kern-Beschwerde. #Nr = projektlokale Sequenz.
            Klick = Projektfilter (Einzelauswahl), ohne die Karte aufzuklappen. */}
        {item.projectPath ? (
          <button
            type="button"
            title={`Nur ${shortName(item.projectPath)} anzeigen`}
            onClick={(e) => {
              e.stopPropagation();
              setScope("single", item.projectPath!);
            }}
            className="shrink-0"
          >
            <Chip className="cursor-pointer font-mono normal-case tracking-normal hover:bg-accent/20 hover:text-accent-text">
              {shortName(item.projectPath)}
              {item.projectSeq != null && <> #{item.projectSeq}</>}
            </Chip>
          </button>
        ) : (
          <Chip className="font-mono normal-case tracking-normal">
            {shortName(item.projectPath)}
            {item.projectSeq != null && <> #{item.projectSeq}</>}
          </Chip>
        )}
        <span className="text-sm font-semibold">{item.title}</span>
        <span className="ml-auto shrink-0 text-right">
          <span className="block font-mono text-xs tabular-nums text-ink-2">{timeText(item.createdAt)}</span>
          <span className="block text-[11px] text-ink-2">{ageText(item.createdAt)}</span>
        </span>
      </div>

      {open && (
        <div className="space-y-3 px-4 pb-4">
          {item.body && <BodyWithOptions body={item.body} project={item.projectPath} draft={draft} onDraft={onDraft} />}
          {(item.anchor || item.gitSha) && (
            <div className="font-mono text-xs text-ink-2">
              {item.anchor && (
                <Link to={fileHref(item.anchor.file, item.anchor.line, item.projectPath)} className="text-accent underline decoration-dotted">
                  {item.anchor.file}{item.anchor.line != null ? `:${item.anchor.line}` : ""}
                </Link>
              )}
              {item.gitSha && <> · {item.gitSha.slice(0, 7)}</>}
            </div>
          )}
          {/* Zugestellte Antwort read-only; ein Entwurf (answer gesetzt, noch
              nicht 'answered') steht dagegen editierbar im Antwortfeld unten. */}
          {item.answer && item.status === "answered" && (
            <div className="bg-hl px-3 py-2 text-sm text-on-primary-container">↳ {item.answer}</div>
          )}
          {/* Zustell-Quittung direkt unter der Antwort: wartet/zugestellt. */}
          <DeliveryState
            status={item.status}
            answeredAt={item.answeredAt}
            deliveredAt={item.deliveredAt}
            delivery={item.delivery}
            answerText={item.answer}
          />

          {/* KI-Modul (PO 11.07.): Einordnung (Auto-Triage) UND die Assist-
              Buttons in EINEM Block. Buttons sitzen in der Kopfzeile neben dem
              Label; Triage-Text und angeforderte Assist-Ergebnisse erscheinen
              darunter — alle KI-Hilfen an einer Stelle, vor dem Antwortfeld. */}
          <div className="border border-line bg-panel px-4 py-3 text-sm leading-relaxed">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="ds-tag uppercase tracking-wide">KI · Einordnung</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {assists.map((a) => (
                  <button
                    key={a.kind}
                    type="button"
                    disabled={assistBusy}
                    onClick={() => void onAssist(a.kind)}
                    className={cn(
                      "border px-2.5 py-1 text-xs transition-colors disabled:opacity-40",
                      a.kind === reco
                        ? "border-accent bg-accent/10 text-accent-text"
                        : "border-outline text-ink-2 hover:bg-surface-container",
                    )}
                  >
                    {assistKind === a.kind ? `${a.label} …` : a.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Auto-Triage nur, wenn eine Antwort gefragt ist (Haiku, ein Call/Item). */}
            {needsAnswer &&
              (triageState === "loading" ? (
                <div className="italic text-ink-2">Haiku ordnet das Item ein …</div>
              ) : cached?.error ? (
                <div className="text-ink-2">{cached.error}</div>
              ) : cached?.triage ? (
                <>
                  <div className="whitespace-pre-wrap text-ink-2">{cached.triage.explanation}</div>
                  {cached.triage.options.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {cached.triage.options.map((o) => (
                        <button
                          key={o.label}
                          type="button"
                          title={o.text}
                          onClick={() => adoptText(o.text, `triage-${cached.triage!.answerType}`)}
                          className="ds-btn-ghost border border-accent/40 !px-3"
                        >
                          {o.label}
                        </button>
                      ))}
                      <span className="self-center text-xs text-ink-2">Klick füllt das Antwortfeld — Senden bleibt bei dir.</span>
                    </div>
                  )}
                </>
              ) : cached?.raw ? (
                <div className="whitespace-pre-wrap text-ink-2">{cached.raw}</div>
              ) : null)}

            {/* Angefordertes Assist-Ergebnis (erklären/pro-contra/…) im selben Modul. */}
            {assistOut && (
              <div className="mt-2.5 border-t border-line pt-2.5">
                <span className="ds-tag mb-1.5 uppercase tracking-wide">
                  {assistOut.error ? "KI · Fehler" : "KI · Vorschlag"}
                </span>
                <div className="whitespace-pre-wrap text-ink-2">{assistOut.error ?? assistOut.text}</div>
                <div className="mt-2 flex gap-2">
                  {assistOut.text && (
                    <button type="button" className="ds-btn-ghost !px-2" onClick={() => adoptText(assistOut.text!, assistOut.kind)}>
                      {remarkMode ? "In Bemerkung übernehmen" : "In Antwort übernehmen"}
                    </button>
                  )}
                  <button type="button" className="ds-btn-ghost !px-2 !text-ink-2" onClick={() => setAssistOut(null)}>Schließen</button>
                </div>
              </div>
            )}
          </div>

          <div className="border-l-4 border-accent bg-panel px-4 py-3">
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-accent-text">{remarkMode ? "Bemerkung" : "Deine Entscheidung"}</label>
              {/* (i) statt der drei Info-Chips (PO 10.07.): die Chips sahen
                  aktionabel aus, waren aber nur Info. Ausklappbarer Klartext. */}
              <button
                type="button"
                onClick={() => setInfoOpen((v) => !v)}
                aria-expanded={infoOpen}
                aria-label="Was beim Speichern und Zustellen passiert"
                className="shrink-0 text-ink-2 hover:text-accent-text"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>
            {infoOpen && (
              <div className="mb-2 border border-line bg-surface-container px-3 py-2 text-xs leading-relaxed text-ink-2">
                {remarkMode ? (
                  <>
                    <p><strong>Speichern</strong> legt deine Bemerkung ab. Sie bleibt erhalten (auch nach Reload) und wird noch nicht weitergegeben.</p>
                    <p className="mt-1.5"><strong>Zustellen</strong> gibt die Bemerkung an die nächste Claude-Session in diesem Projekt weiter — als Kontext, nicht als Entscheidung; im Entscheidungs-Log erscheint sie nicht.</p>
                  </>
                ) : (
                  <>
                    <p><strong>Speichern</strong> legt deine Antwort als Entwurf ab. Der Entwurf bleibt erhalten (auch nach Reload), zählt aber noch nicht als Entscheidung und wird nicht zugestellt.</p>
                    <p className="mt-1.5"><strong>Zustellen</strong> macht die Antwort verbindlich: Sie ist sofort durchsuchbar, die nächste Claude-Session in diesem Projekt bekommt sie automatisch als Kontext, und sie erscheint dauerhaft im Entscheidungs-Log — damit nachvollziehbar bleibt, was wann entschieden wurde.</p>
                    <p className="mt-1.5">{t("delivery.ways")}</p>
                  </>
                )}
              </div>
            )}
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (draft.trim()) void onSave();
                }
              }}
              placeholder={remarkMode ? "Bemerkung…" : "Antwort…"}
              className="ds-field min-h-[56px] resize-y"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={savingDraft || !draft.trim()}
                onClick={() => void onSave()}
                className={cn(showDeliver ? "ds-btn-ghost border border-line" : "ds-btn-primary")}
              >
                {savingDraft ? "Speichert…" : draftSaved ? "Erneut speichern" : "Speichern"}
              </button>
              {showDeliver && (
                <>
                  <button
                    type="button"
                    disabled={answering || !draft.trim()}
                    onClick={() => void onAnswer()}
                    className="ds-btn-primary"
                  >
                    {answering ? "Stellt zu…" : "Zustellen"}
                  </button>
                  <button type="button" onClick={() => void onCopy()} className="ds-btn-ghost border border-line">
                    {copied ? "Kopiert!" : "Kopieren"}
                  </button>
                </>
              )}
              <span className="text-xs text-ink-2"><kbd className="border border-line px-1 font-mono text-[11px]">Strg+Enter</kbd> speichert</span>
            </div>
          </div>

          {/* Sekundär: bewusste Ausstiege OHNE Antwort — abgesetzt vom
              Primärfluss (Speichern → Zustellen), damit die Ebene klar ist. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <span className="text-xs text-ink-2">{remarkMode ? "Ohne Bemerkung:" : "Ohne zu antworten:"}</span>
            <button type="button" onClick={() => onStatus("postponed", "Auf später gelegt")} className="ds-btn-ghost">
              Später (p) — zurückstellen, kommt wieder
            </button>
            <button type="button" onClick={() => onStatus("done", "Erledigt")} className="ds-btn-ghost">
              {remarkMode ? "Erledigt (e) — Karte schließen" : "Erledigt (e) — ohne Antwort schließen"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Body-Renderer: "( ) …"/"[ ] …"-Zeilen werden zu klickbaren Optionen
// (Einfach- bzw. Mehrfachauswahl), alles andere bleibt linkifizierter Text.
// Klick füllt NUR das Antwortfeld — Senden bleibt beim Menschen.
function BodyWithOptions({
  body,
  project,
  draft,
  onDraft,
}: {
  body: string;
  project?: string;
  draft: string;
  onDraft: (v: string) => void;
}) {
  const lines = body.split("\n");
  // Alle ( )-Texte der Karte: die Einfachauswahl ersetzt genau diese Zeilen
  // im Antwortfeld und lässt [ ]-Häkchen und Freitext stehen.
  const singleTexts = lines
    .map(parseOptionLine)
    .filter((o): o is { kind: "single"; text: string } => o?.kind === "single")
    .map((o) => o.text);
  // Aufgeklappte Options-Bemerkungsfelder (Paket A), nach Zeilenindex.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (i: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const nodes: React.ReactNode[] = [];
  let buf: string[] = [];
  let hasOptions = false;
  const flush = (key: number) => {
    if (!buf.length) return;
    nodes.push(
      <span key={`t${key}`} className="whitespace-pre-wrap">
        {linkifyPaths(buf.join("\n") + "\n", project)}
      </span>,
    );
    buf = [];
  };
  lines.forEach((line, i) => {
    const opt = parseOptionLine(line);
    if (!opt) {
      buf.push(line);
      return;
    }
    hasOptions = true;
    flush(i);
    const selected = isSelected(draft, opt);
    const isExp = expanded.has(i);
    const remark = getRemark(draft, opt.text);
    nodes.push(
      <div key={`o${i}`} className="my-0.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={selected}
            onClick={() =>
              onDraft(
                opt.kind === "single"
                  ? selectSingleDraft(draft, opt.text, singleTexts)
                  : toggleMultiDraft(draft, opt.text),
              )
            }
            className={cn(
              "block w-fit max-w-full border px-3 py-1.5 text-left text-sm transition-colors",
              selected
                ? "border-accent bg-accent/10 font-semibold text-accent-text"
                : "border-line text-ink-2 hover:bg-surface-container",
            )}
          >
            <span className="mr-1.5">{opt.kind === "single" ? (selected ? "◉" : "○") : selected ? "☑" : "☐"}</span>
            {opt.text}
          </button>
          {/* Chevron: Bemerkungsfeld zu dieser Option auf-/zuklappen. */}
          <button
            type="button"
            onClick={() => toggleExpanded(i)}
            aria-expanded={isExp}
            aria-label="Bemerkung zu dieser Option"
            className="shrink-0 text-ink-2 hover:text-accent-text"
          >
            {isExp ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {remark && !isExp && <span className="truncate text-xs italic text-ink-2">Bemerkung: {remark}</span>}
        </div>
        {isExp && (
          <div className="ml-4 mt-1">
            {selected ? (
              <input
                type="text"
                value={remark}
                onChange={(e) => onDraft(setRemark(draft, opt.text, e.target.value))}
                placeholder="Bemerkung zu dieser Option…"
                className="ds-field !py-1 text-sm"
              />
            ) : (
              <span className="text-xs italic text-ink-2">Option zuerst auswählen, dann ist eine Bemerkung möglich.</span>
            )}
          </div>
        )}
      </div>,
    );
  });
  flush(lines.length);
  return (
    <div>
      <div className="max-w-[74ch] text-sm leading-relaxed text-ink-2">{nodes}</div>
      {hasOptions && (
        <div className="mt-1 text-xs text-ink-2">Klick füllt das Antwortfeld — Senden bleibt bei dir.</div>
      )}
    </div>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("shrink-0 rounded-full bg-secondary-container px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-2", className)}>
      {children}
    </span>
  );
}
