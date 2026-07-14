import { useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff, HelpCircle } from "lucide-react";
import { useScope } from "@/lib/useScope";
import {
  useEnv,
  useEnvAssist,
  useEnvGitignore,
  useEnvHistory,
  useSaveEnvSpec,
  useWriteEnvVar,
} from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { shortName } from "@/lib/utils";
import type { EnvProjectView, EnvRequirement, EnvVarView } from "@/api/types";

// /env — Umgebungsvariablen je Projekt (+ global) verwalten. SICHERHEIT: die
// Werte verlassen die Platte nie Richtung Browser (nur Namen + gesetzt/leer);
// Eingaben sind write-only. Ansicht ist ein STEPPER: EIN Projekt zur Zeit,
// vor/zurück statt endlosem Scrollen (PO 14.07.).
export default function EnvPage() {
  const { scope } = useScope();
  const q = useEnv(scope);
  const [rawIdx, setIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  if (q.error) return <div className="p-5"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;

  const projects = q.data?.projects ?? [];
  // Auswahlwechsel (Scope) kann die Liste verkürzen — Index beim Rendern
  // einklammern (kein Effekt/Extra-Render nötig); die Blätter-Knöpfe rechnen
  // vom geklammerten Wert weiter, damit er nach dem Schrumpfen nicht driftet.
  const idx = Math.min(rawIdx, Math.max(0, projects.length - 1));
  const current = projects[idx];
  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">
          Env
          <span className="ml-2 text-xs font-normal text-ink-2">.env je Projekt · Secrets bleiben auf der Platte · gitignore</span>
        </h2>
        <button
          type="button"
          onClick={() => setHelpOpen((v) => !v)}
          className="ds-btn-ghost ml-auto inline-flex items-center gap-1 border border-line !px-3 text-xs"
        >
          <HelpCircle className="h-3.5 w-3.5" /> {helpOpen ? "Hilfe schließen" : "Was ist das?"}
        </button>
      </div>

      {helpOpen && <EnvHelp />}

      {projects.length === 0 ? (
        <p className="italic text-ink-2">Keine Projekte in dieser Auswahl.</p>
      ) : (
        <>
          <Stepper idx={idx} total={projects.length} label={current ? (current.projectPath ? shortName(current.projectPath) : "Global") : ""} onPrev={() => setIdx(Math.max(0, idx - 1))} onNext={() => setIdx(Math.min(projects.length - 1, idx + 1))} />
          {current && <ProjectPanel key={current.projectPath} project={current} />}
        </>
      )}
    </div>
  );
}

// --- Hilfe-Sektion (warum/wie/was ist env?) ---------------------------------
function EnvHelp() {
  return (
    <div className="ds-card mb-4 px-4 py-3 text-sm leading-relaxed">
      <p className="mb-2">
        <strong>Was ist eine Umgebungsvariable?</strong> Ein benannter Wert (z. B. <code className="font-mono text-xs">STRIPE_SECRET_KEY</code>),
        den dein Code zur Laufzeit aus der Umgebung liest — statt ihn fest im Quelltext zu verdrahten. Sie stehen in einer
        Datei namens <code className="font-mono text-xs">.env</code> im Projektordner.
      </p>
      <p className="mb-2">
        <strong>Warum nicht in den Code?</strong> Zugangsschlüssel und Passwörter gehören nie in den Quelltext und nie in Git —
        sonst landen sie in der Historie und lassen sich kaum wieder entfernen. Deshalb liegt <code className="font-mono text-xs">.env</code> lokal
        und wird per <code className="font-mono text-xs">.gitignore</code> von Git ausgeschlossen.
      </p>
      <p className="mb-2">
        <strong>Wie fülle ich sie?</strong> Cockpit zeigt dir je Variable den festen Namen (<code className="font-mono text-xs">KEY=</code>) und ein
        Eingabefeld. Was du einfügst, schreibt Cockpit direkt in die echte <code className="font-mono text-xs">.env</code> — der Wert wird
        <em> nie</em> in Cockpit gespeichert oder im Browser angezeigt. Zu jeder Variable kannst du <em>warum/wie/was</em> und einen
        Service-Link hinterlegen; die lässt sich auch von Haiku vorschlagen.
      </p>
      <p className="text-ink-2">
        Jede Änderung wird protokolliert (nur der Name, nie der Wert), und vor dem Überschreiben legt Cockpit eine
        timestamped Sicherung neben der Datei an (<code className="font-mono text-xs">.env-backups/</code>, ebenfalls gitignored).
      </p>
    </div>
  );
}

// --- Stepper (ein Projekt zur Zeit) -----------------------------------------
function Stepper({ idx, total, label, onPrev, onNext }: { idx: number; total: number; label: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <button type="button" onClick={onPrev} disabled={idx === 0} className="ds-btn-ghost border border-line inline-flex items-center gap-1 !px-3 text-xs disabled:opacity-40" aria-label="Vorheriges Projekt">
        <ChevronLeft className="h-4 w-4" /> Zurück
      </button>
      <div className="flex-1 text-center">
        <span className="text-sm font-semibold">{label || "—"}</span>
        <span className="ml-2 text-xs tabular-nums text-ink-2">{idx + 1} / {total}</span>
      </div>
      <button type="button" onClick={onNext} disabled={idx >= total - 1} className="ds-btn-ghost border border-line inline-flex items-center gap-1 !px-3 text-xs disabled:opacity-40" aria-label="Nächstes Projekt">
        Weiter <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// --- Ein Projekt (.env-Panel) ------------------------------------------------
function ProjectPanel({ project }: { project: EnvProjectView }) {
  const missing = project.vars.filter((v) => !v.present).length;
  return (
    <div className="ds-card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold">{project.projectPath ? shortName(project.projectPath) : "Global"}</span>
        <span className="font-mono text-xs text-ink-2">{project.envFile}</span>
        {project.envExists ? <span className="ds-tag bg-ok/15 text-ok">.env vorhanden</span> : <span className="ds-tag">keine .env</span>}
        {missing > 0 && <span className="ds-tag bg-warn/15 text-warn">{missing} fehlend</span>}
      </div>

      <GitignoreRow project={project} />
      <ScanPanel project={project} />

      <div className="mt-3 flex flex-col gap-1.5">
        {project.vars.length === 0 ? (
          <p className="italic text-ink-2">Noch keine Variablen bekannt. Scanne das Projekt oder frag Haiku nach den Variablen eines Dienstes (oben).</p>
        ) : (
          project.vars.map((v) => <VarRow key={v.key} project={project.projectPath} v={v} />)
        )}
      </div>
    </div>
  );
}

// --- gitignore-Status + Ein-Klick-Fix ---------------------------------------
function GitignoreRow({ project }: { project: EnvProjectView }) {
  const fix = useEnvGitignore();
  const gi = project.gitignore;
  if (!gi.isRepo) return <div className="mt-2 text-xs text-ink-2">kein Git-Repo — .gitignore nicht relevant</div>;
  if (gi.ignored) return <div className="mt-2 text-xs text-ok">.env ist von Git ausgeschlossen (gitignored) — gut so.</div>;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border border-crit/40 bg-crit/5 px-3 py-2 text-xs">
      <span className="font-semibold text-crit">.env ist NICHT von Git ausgeschlossen — Secrets könnten committet werden!</span>
      <button type="button" disabled={fix.isPending} onClick={() => fix.mutate({ project: project.projectPath })} className="ds-btn-primary ml-auto !py-1 !px-3">
        {fix.isPending ? "Ergänzt…" : ".env in .gitignore aufnehmen"}
      </button>
      {fix.isError && <span className="w-full text-crit">{errMsg(fix.error)} — erneut versuchen.</span>}
    </div>
  );
}

// --- Haiku-Scan + Ad-hoc-Dienst ---------------------------------------------
function ScanPanel({ project }: { project: EnvProjectView }) {
  const assist = useEnvAssist();
  const saveSpec = useSaveEnvSpec();
  const [service, setService] = useState("");
  const [reqs, setReqs] = useState<EnvRequirement[] | null>(null);
  const [rawFallback, setRawFallback] = useState<string | null>(null);

  const run = (withService: boolean) => {
    setReqs(null);
    setRawFallback(null);
    assist.mutate(
      { project: project.projectPath, service: withService ? service.trim() : undefined },
      {
        onSuccess: (r) => {
          const parsed = parseEnvAssist(r.text);
          if (parsed) setReqs(parsed);
          else setRawFallback(r.text);
        },
      },
    );
  };

  return (
    <div className="mt-3 border border-line bg-ground px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={assist.isPending} onClick={() => run(false)} className="ds-btn-ghost border border-line !px-3 text-xs">
          {assist.isPending ? "Haiku denkt…" : "Mit Haiku scannen"}
        </button>
        <span className="text-xs text-ink-2">oder Variablen für einen Dienst:</span>
        <input value={service} onChange={(e) => setService(e.target.value)} placeholder="z. B. Stripe, Supabase…" className="ds-field !w-44 !py-1 text-sm" />
        <button type="button" disabled={assist.isPending || !service.trim()} onClick={() => run(true)} className="ds-btn-ghost border border-line !px-3 text-xs disabled:opacity-40">
          vorschlagen
        </button>
      </div>
      {assist.isError && <p className="mt-2 text-xs text-crit">{errMsg(assist.error)}</p>}
      {rawFallback && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap border border-line bg-panel p-2 text-xs text-ink-2">{rawFallback}</pre>
      )}
      {reqs && reqs.length === 0 && <p className="mt-2 text-xs text-ink-2">Haiku hat keine Variablen vorgeschlagen.</p>}
      {reqs && reqs.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {reqs.map((r) => (
            <div key={r.key} className="flex flex-wrap items-start gap-2 border border-line bg-panel px-3 py-2 text-xs">
              <span className="font-mono font-semibold">{r.key}</span>
              <span className="min-w-0 flex-1 text-ink-2">
                {r.why && <span className="block"><strong>Warum:</strong> {r.why}</span>}
                {r.how && <span className="block"><strong>Wie:</strong> {r.how}</span>}
                {r.what && <span className="block"><strong>Was:</strong> {r.what}</span>}
                {r.link && <a href={safeHref(r.link)} target="_blank" rel="noreferrer noopener" className="block text-accent underline decoration-dotted">{r.link}</a>}
              </span>
              <button
                type="button"
                disabled={saveSpec.isPending}
                onClick={() => saveSpec.mutate({ project: project.projectPath, key: r.key, why: r.why, how: r.how, what: r.what, link: r.link, source: service.trim() ? "ad-hoc" : "scanned" })}
                className="ds-btn-ghost border border-line shrink-0 !px-3"
              >
                Übernehmen
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Eine Variable (fester Name + maskiertes Wertfeld + Metadaten) ----------
function VarRow({ project, v }: { project: string; v: EnvVarView }) {
  const write = useWriteEnvVar();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showHist, setShowHist] = useState(false);

  const save = () => {
    if (!value) return;
    write.mutate({ project, key: v.key, value }, { onSuccess: () => setValue("") });
  };

  return (
    <div className="border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{v.key}=</span>
        <StatusTag v={v} />
        <div className="ml-auto flex items-center gap-1">
          <input
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder={v.hasValue ? "•••••• (überschreiben)" : "Wert einfügen"}
            autoComplete="off"
            spellCheck={false}
            className="ds-field !w-56 !py-1 font-mono text-xs"
          />
          <button type="button" onClick={() => setReveal((r) => !r)} className="ds-btn-ghost !px-2 text-ink-2" aria-label={reveal ? "verbergen" : "anzeigen"}>
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button type="button" disabled={!value || write.isPending} onClick={save} className="ds-btn-primary !py-1 !px-3 text-xs disabled:opacity-40">
            {write.isPending ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        <button type="button" onClick={() => setShowMeta((s) => !s)} className="text-accent underline decoration-dotted">
          {showMeta ? "Info schließen" : (v.spec ? "warum/wie/was" : "warum/wie/was hinterlegen")}
        </button>
        <button type="button" onClick={() => setShowHist((s) => !s)} className="text-ink-2 underline decoration-dotted">
          {showHist ? "Verlauf schließen" : "Verlauf"}
        </button>
        {write.isError && <span className="text-crit">{errMsg(write.error)}</span>}
        {write.isSuccess && !value && <span className="text-ok">Gespeichert (write-only in die .env).</span>}
      </div>

      {v.spec && !showMeta && (v.spec.why || v.spec.how || v.spec.what || v.spec.serviceLink) && (
        <div className="mt-1 text-xs text-ink-2">
          {v.spec.why && <span className="mr-3"><strong>Warum:</strong> {v.spec.why}</span>}
          {v.spec.serviceLink && <a href={safeHref(v.spec.serviceLink)} target="_blank" rel="noreferrer noopener" className="text-accent underline decoration-dotted">Service</a>}
        </div>
      )}
      {showMeta && <SpecEditor project={project} varKey={v.key} spec={v.spec} onDone={() => setShowMeta(false)} />}
      {showHist && <HistoryList project={project} varKey={v.key} />}
    </div>
  );
}

function StatusTag({ v }: { v: EnvVarView }) {
  if (v.hasValue) return <span className="ds-tag bg-ok/15 text-ok">gesetzt</span>;
  if (v.present) return <span className="ds-tag bg-warn/15 text-warn">leer</span>;
  return <span className="ds-tag bg-crit/15 text-crit">fehlt{v.inExample ? " (in .env.example)" : ""}</span>;
}

// --- Metadaten-Editor (nicht-geheim: warum/wie/was + Link) -------------------
function SpecEditor({ project, varKey, spec, onDone }: { project: string; varKey: string; spec: EnvVarView["spec"]; onDone: () => void }) {
  const save = useSaveEnvSpec();
  const [why, setWhy] = useState(spec?.why ?? "");
  const [how, setHow] = useState(spec?.how ?? "");
  const [what, setWhat] = useState(spec?.what ?? "");
  const [link, setLink] = useState(spec?.serviceLink ?? "");

  const submit = () => {
    save.mutate({ project, key: varKey, why, how, what, link, source: spec?.source ?? "manual" }, { onSuccess: onDone });
  };
  const field = (label: string, val: string, set: (s: string) => void) => (
    <label className="block">
      <span className="text-ink-2">{label}</span>
      <input value={val} onChange={(e) => set(e.target.value)} className="ds-field mt-0.5 w-full !py-1 text-sm" />
    </label>
  );
  return (
    <div className="mt-2 flex flex-col gap-2 border border-line bg-ground px-3 py-2 text-xs">
      {field("Warum wird die Variable gebraucht?", why, setWhy)}
      {field("Wie/wo bekomme ich den Wert?", how, setHow)}
      {field("Was für ein Wert (Format, geheim?)", what, setWhat)}
      {field("Service-Link (URL)", link, setLink)}
      <div className="flex items-center gap-2">
        <button type="button" disabled={save.isPending} onClick={submit} className="ds-btn-primary !py-1 !px-3">
          {save.isPending ? "Speichert…" : "Speichern"}
        </button>
        <button type="button" onClick={onDone} className="ds-btn-ghost border border-line !px-3">Abbrechen</button>
        {save.isError && <span className="text-crit">{errMsg(save.error)}</span>}
      </div>
    </div>
  );
}

// --- Verlauf (Audit, ohne Werte) --------------------------------------------
function HistoryList({ project, varKey }: { project: string; varKey: string }) {
  const q = useEnvHistory(project, varKey, true);
  if (q.isLoading) return <div className="mt-2 text-xs text-ink-2">Lädt…</div>;
  if (q.error) return <div className="mt-2 text-xs text-crit">{errMsg(q.error)}</div>;
  const history = q.data?.history ?? [];
  if (history.length === 0) return <div className="mt-2 text-xs text-ink-2">Noch keine Änderungen protokolliert.</div>;
  return (
    <div className="mt-2 max-h-40 overflow-y-auto border border-line bg-ground px-3 py-2 font-mono text-xs">
      {history.map((h) => (
        <div key={h.id} className="flex gap-3">
          <span className="shrink-0 text-ink-2">{new Date(h.at).toLocaleString("de-DE")}</span>
          <span>{CHANGE_LABEL[h.change] ?? h.change}</span>
        </div>
      ))}
    </div>
  );
}

const CHANGE_LABEL: Record<string, string> = {
  value_set: "Wert geändert",
  value_set_new: "Wert gesetzt (Datei angelegt)",
  spec_edited: "Beschreibung bearbeitet",
};

// --- Hilfsfunktionen ---------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Fehler";
}

// Nur http/https zulassen — nie javascript:/data: aus (untrusted) Haiku-/DB-Text.
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : "#";
}

// Haiku-JSON defensiv parsen: etwaige Markdown-Zäune entfernen, dann JSON.parse.
// Liefert null, wenn kein verwertbares Array herauskommt (dann zeigt die Seite
// den Rohtext). Nur die erwarteten String-Felder werden übernommen.
function parseEnvAssist(text: string): EnvRequirement[] | null {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out: EnvRequirement[] = [];
  for (const item of data) {
    const o = item as Record<string, unknown>;
    const key = typeof o["key"] === "string" ? o["key"].trim() : "";
    if (!key) continue;
    out.push({
      key,
      why: str(o["why"]),
      how: str(o["how"]),
      what: str(o["what"]),
      link: str(o["link"]),
    });
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
