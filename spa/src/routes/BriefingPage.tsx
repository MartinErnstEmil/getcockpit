import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, Rocket, Sparkles } from "lucide-react";
import { useScope } from "@/lib/useScope";
import { isActionable, scopeToParams } from "@/lib/scope";
import { useScopedStatus, useScopedItems } from "@/lib/useScopedData";
import { useBrief, useDecisions } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { ageText, shortName } from "@/lib/utils";
import { sessionPromptGitRule } from "@/lib/gitmode";
import type { StatusBrief } from "@/api/types";

// /briefing — Status-Zusammenfassung eines Projekts (Ziel des Projektkarten-
// Klicks): deterministischer Stand sofort (garfield-Erbe), KI-Zusammenfassung
// mit bewerteten nächsten Schritten auf Knopfdruck (Standup-Infrastruktur),
// Copy-Übergabe für ein CLI-Fenster (context-engine-Erbe).
export default function BriefingPage() {
  const { scope, setScope } = useScope();
  const { status, keep, projects } = useScopedStatus(scope);

  if (status.error) return <div className="p-5"><ErrorBox error={status.error} onRetry={() => void status.refetch()} /></div>;
  if (status.isLoading) return <EmptyState title="Lädt…" />;

  if (scope.mode !== "single") {
    return (
      <div className="mx-auto max-w-[1120px] px-5 py-5">
        <h2 className="mb-3 text-[15px] font-semibold">Briefing</h2>
        <p className="mb-3 text-sm text-ink-2">Wähle ein Projekt — das Briefing fasst dessen Stand zusammen.</p>
        {projects.length === 0 ? (
          <p className="italic text-ink-2">Keine Projekte in dieser Auswahl.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {projects.map((p) => (
              <button key={p.projectPath} type="button" onClick={() => setScope("single", p.projectPath)} className="ds-btn-tertiary">
                {shortName(p.projectPath)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  // key=project: beim Projektwechsel (Header-Auswahl) muss der lokale State
  // (KI-Zusammenfassung, Kopiert-Flag) zurückgesetzt werden — sonst zeigt die
  // Seite statisch das Briefing des vorherigen Projekts (User-Befund 10.07.).
  return <ProjectBriefing key={scope.project} project={scope.project} keep={keep} />;
}

function ProjectBriefing({ project, keep }: { project: string; keep: (p: string | null | undefined) => boolean }) {
  const { scope, setScope } = useScope();
  const navigate = useNavigate();
  const { projects } = useScopedStatus(scope);
  const { inScopeItems } = useScopedItems(scope, keep);
  const decisionsQ = useDecisions(scope, false);
  const brief = useBrief();
  const [briefOut, setBriefOut] = useState<StatusBrief | null>(null);
  const [copied, setCopied] = useState(false);

  const p = projects.find((x) => x.projectPath === project);
  const open = inScopeItems.filter(isActionable);
  const decisions = (decisionsQ.data?.decisions ?? []).filter((d) => d.projectPath === project).slice(0, 5);

  function deterministicMd(): string {
    const lines = [`# Briefing ${shortName(project)} — ${new Date().toLocaleDateString("de-DE")}`, ""];
    if (p) {
      lines.push(`Letzte Aktivität: ${ageText(p.lastActivity)}${p.activeSession ? " · Session läuft gerade" : ""}`);
      if (p.git) lines.push(`Git: ${p.git.branch ?? "?"} · ${p.git.dirtyFiles} ungesicherte Dateien`);
      for (const c of p.git?.recentCommits.slice(0, 3) ?? []) lines.push(`- Commit: ${c.subject}`);
    }
    if (open.length) {
      lines.push("", "Wartet auf dich:");
      for (const i of open) lines.push(`- ${i.title}`);
    }
    if (decisions.length) {
      lines.push("", "Letzte Entscheidungen:");
      for (const d of decisions) lines.push(`- ${d.title}${d.answer ? ` ↳ ${d.answer}` : ""}`);
    }
    return lines.join("\n");
  }

  async function copyAll() {
    const md = [deterministicMd(), briefOut ? `\n## KI-Zusammenfassung\n${briefOut.report}` : ""].join("\n");
    await navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Session-Prompt für eine AUTONOME Claude-Code-Session (PO 11.07.):
  // Briefing-Kontext + bindende Arbeitsregeln — /simplify nach jedem Paket,
  // Abschluss-Dokumentation und Übergabe (Learnings/Fragen/Ergebnis) über die
  // Cockpit-MCP-Tools. Deterministisch komponiert, per Copy in die Session.
  const [sessionPrompt, setSessionPrompt] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);

  function buildSessionPrompt(): string {
    // Git-Regel folgt dem Modus des Projekts (manual = weglassen); die
    // übrigen Regeln werden dynamisch nummeriert, damit das Weglassen keine
    // Lücke reißt. Fehlender Modus = 'advisory'.
    const gitRule = sessionPromptGitRule(p?.gitMode ?? "advisory");
    const rules = [
      "Gates nach JEDEM Paket: Tests + Typecheck (und Build, wo vorhanden) —\n" +
        "   keine Gates aufweichen, keine .skip.",
      "/simplify an nützlichen Stellen: nach jedem inhaltlich abgeschlossenen\n" +
        "   Paket einen /simplify-Lauf über den Paket-Diff (Reuse, Vereinfachung,\n" +
        "   Altitude) und die Findings direkt anwenden, BEVOR du weitermachst.",
      ...(gitRule ? [gitRule] : []),
      "Cockpit ist dein Kanal zum Menschen (MCP-Server \"cockpit\"):\n" +
        "   - Fragen, Blocker und Vorschläge sofort als add_item ablegen (Typ\n" +
        "     präzise, anchor auf Datei:Zeile) — nie im Chat-Text begraben.\n" +
        "   - Vor Architektur-Entscheidungen: search_decisions.\n" +
        "   - Wartest du auf eine Antwort: pickup_answers vor dem nächsten Schritt.",
      "Session-Abschluss (Pflicht, bevor du endest):\n" +
        "   - EIN result-Item: was getan, was offen, Gates-Stand.\n" +
        "   - Learnings/Erkenntnisse als je ein kurzes fyi-Item.\n" +
        "   - Offene Fragen als question-Items.\n" +
        "   - Repo-Doku aktualisieren, wo die Arbeit sie veraltet hat.",
    ];
    return [
      `Du arbeitest autonom im Projekt ${project}.`,
      "",
      "## Ausgangslage (Cockpit-Briefing)",
      deterministicMd(),
      ...(briefOut ? ["", "## Stand + nächste Schritte (KI-Zusammenfassung)", briefOut.report] : []),
      "",
      "## Auftrag",
      "Arbeite die offenen Punkte oben ab — Blocker und \"Wartet auf dich\" zuerst,",
      "dann die nächsten Schritte aus der Zusammenfassung. Kleine, in sich",
      "abgeschlossene Pakete; nach jedem Paket alle Gates.",
      "",
      "## Arbeitsregeln (bindend)",
      ...rules.map((r, i) => `${i + 1}. ${r}`),
    ].join("\n");
  }

  async function copyPrompt() {
    if (!sessionPrompt) return;
    await navigator.clipboard.writeText(sessionPrompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  }

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 flex flex-wrap items-center gap-2 text-[15px] font-semibold">
        <button
          type="button"
          className="text-accent underline"
          onClick={() => { setScope("active"); navigate({ pathname: "/overview", search: scopeToParams({ mode: "active", project: "", days: scope.days }).toString() }); }}
        >
          ← Alle Projekte
        </button>
        Briefing · {shortName(project)}
        <button type="button" onClick={() => void copyAll()} className="ds-btn-ghost ml-auto flex items-center gap-1.5" title="Briefing als Markdown kopieren — zum Einfügen in ein CLI-Fenster">
          <Copy className="h-3.5 w-3.5" /> {copied ? "Kopiert!" : "Für Session kopieren"}
        </button>
      </h2>

      {/* Deterministischer Stand — sofort da, keine KI nötig. */}
      <div className="ds-card mb-3 px-4 py-3 text-sm">
        {p ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>Letzte Aktivität: <strong>{ageText(p.lastActivity)}</strong>{p.activeSession && <span className="ml-1.5 text-ok">● Session läuft</span>}</span>
            {p.git && <span>Git: <strong>{p.git.branch ?? "?"}</strong> · {p.git.dirtyFiles} ungesichert</span>}
            <span>Sessions: {p.sessions} · Wortmeldungen: {p.turns.toLocaleString("de-DE")}</span>
          </div>
        ) : (
          <span className="italic text-ink-2">Keine Statusdaten (Projekt ohne erfasste Sessions).</span>
        )}
        {(p?.git?.recentCommits.length ?? 0) > 0 && (
          <div className="mt-2 text-xs text-ink-2">
            {p!.git!.recentCommits.slice(0, 3).map((c) => <div key={c.sha}>⌥ {c.subject}</div>)}
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="ds-card px-4 py-3">
          <div className="mb-1.5 text-sm font-semibold">Wartet auf dich · {open.length}</div>
          {open.length === 0 ? (
            <p className="text-sm italic text-ink-2">Nichts — alle Fragen beantwortet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {open.slice(0, 8).map((i) => (
                <li key={i.id}>
                  <button type="button" className="text-left text-accent underline decoration-dotted" onClick={() => {
                    const sp = scopeToParams(scope);
                    sp.set("item", i.id);
                    navigate({ pathname: "/inbox", search: sp.toString() });
                  }}>{i.title}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="ds-card px-4 py-3">
          <div className="mb-1.5 text-sm font-semibold">Letzte Entscheidungen</div>
          {decisions.length === 0 ? (
            <p className="text-sm italic text-ink-2">Noch keine.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {decisions.map((d) => (
                <li key={d.id}>{d.title}{d.answer && <span className="text-ink-2"> ↳ {d.answer.slice(0, 120)}</span>}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* KI-Zusammenfassung auf Knopfdruck (dauert ~20-60 s, kostet einen Call). */}
      <div className="ds-card mt-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Stand + nächste Schritte (KI)</span>
          <button
            type="button"
            disabled={brief.isPending}
            onClick={() => brief.mutate({ project }, { onSuccess: setBriefOut })}
            className="ds-btn-primary ml-auto flex items-center gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {brief.isPending ? "Fasst zusammen … (bis zu 1 Min.)" : briefOut ? "Neu zusammenfassen" : "Zusammenfassen lassen"}
          </button>
        </div>
        {brief.isError && (
          <div className="mt-2 border-l-4 border-crit bg-panel px-3 py-2 text-sm text-ink-2">
            {brief.error instanceof Error ? brief.error.message : String(brief.error)} — Erneut versuchen.
          </div>
        )}
        {briefOut && (
          <>
            {briefOut.mode === "raw" && (
              <div className="mt-2 border-l-4 border-warn bg-panel px-3 py-2 text-xs text-ink-2">
                Claude nicht erreichbar ({briefOut.degradedBecause ?? "unbekannt"}) — unten die ungeglätteten Rohdaten.
                Was du tun kannst: Claude Code installieren und einmal <code className="font-mono">claude</code> im
                Terminal starten (einloggen); <code className="font-mono">cockpit doctor</code> prüft es. Danach hier
                einfach „Neu zusammenfassen".
              </div>
            )}
            <pre className="mt-2 max-w-[90ch] whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{briefOut.report}</pre>
          </>
        )}
        {!briefOut && !brief.isPending && !brief.isError && (
          <p className="mt-1.5 text-xs text-ink-2">Fasst die letzten 7 Tage zusammen und bewertet die nächsten Schritte — ohne Jargon.</p>
        )}
      </div>

      {/* Autonome Session: fertiger Prompt aus Briefing-Kontext + bindenden
          Arbeitsregeln (/simplify je Paket, Abschluss-Übergabe ans Cockpit). */}
      <div className="ds-card mt-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Autonome Session starten</span>
          <button
            type="button"
            onClick={() => setSessionPrompt(buildSessionPrompt())}
            className="ds-btn-tertiary ml-auto flex items-center gap-1.5"
          >
            <Rocket className="h-3.5 w-3.5" />
            {sessionPrompt ? "Prompt neu erzeugen" : "Session-Prompt erzeugen"}
          </button>
          {sessionPrompt && (
            <button type="button" onClick={() => void copyPrompt()} className="ds-btn-primary flex items-center gap-1.5">
              <Copy className="h-3.5 w-3.5" /> {promptCopied ? "Kopiert!" : "Prompt kopieren"}
            </button>
          )}
        </div>
        {sessionPrompt ? (
          <pre className="mt-2 max-h-[420px] max-w-[90ch] overflow-y-auto whitespace-pre-wrap border border-line bg-panel px-3 py-2 text-xs leading-relaxed text-ink-2">{sessionPrompt}</pre>
        ) : (
          <p className="mt-1.5 text-xs text-ink-2">
            Erzeugt einen kopierfertigen Auftrag für eine autonome Claude-Code-Session: Briefing-Kontext
            {briefOut ? " inkl. KI-Zusammenfassung" : " (KI-Zusammenfassung wird eingebettet, wenn vorhanden)"} plus
            bindende Regeln — /simplify nach jedem Paket, Abschluss-Übergabe (Ergebnis, Learnings, offene Fragen) ans Cockpit.
          </p>
        )}
      </div>
    </div>
  );
}
