import { useEffect, useState } from "react";
import { getTheme, setTheme, type Theme } from "@/lib/theme";
import {
  EXPERT_LEVELS,
  getExpertLevel,
  setExpertLevel,
  DEFAULT_CLAUDEMD_BUDGET,
  getGlobalBudget,
  setGlobalBudget,
  getProjectBudget,
  setProjectBudget,
  getLastCheck,
  setLastCheck,
  type ExpertLevel,
} from "@/lib/prefs";
import {
  useEnableHooks,
  useStatus,
  useProjects,
  useSetCapture,
  useSetArchived,
  useDeleteProject,
  useClaudeMdCheck,
} from "@/api/queries";
import { cn, shortName, dayMonth } from "@/lib/utils";
import { useT, useLocale, LOCALES } from "@/lib/i18n";
import type { BudgetCheckResult, ProjectAdmin } from "@/api/types";

const THEMES: Array<{ value: Theme; labelKey: string }> = [
  { value: "system", labelKey: "settings.theme.system" },
  { value: "light", labelKey: "settings.theme.light" },
  { value: "dark", labelKey: "settings.theme.dark" },
];

// /settings (Zahnrad im Header): Geräte-Präferenzen. Das Expertenlevel steuert
// die Persona der Haiku-Assists (assist.ts PERSONA_INSTRUCTION) — es wird bei
// jedem /api/assist-Call mitgeschickt.
export default function SettingsPage() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [level, setLevelState] = useState<ExpertLevel>(getExpertLevel());
  const status = useStatus({ mode: "active", project: "", days: 7 });
  const enable = useEnableHooks();

  return (
    <div className="mx-auto max-w-[720px] px-5 py-5">
      <h2 className="mb-5 text-[15px] font-semibold">{t("settings.title")}</h2>

      <section className="mb-7">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.recording.title")}</h3>
        {status.data?.hooksDisabled ? (
          <div className="border-l-4 border-warn bg-panel px-4 py-3">
            <p className="max-w-[60ch] text-sm text-ink-2">{t("settings.recording.disabled")}</p>
            <button
              type="button"
              disabled={enable.isPending}
              onClick={() => enable.mutate()}
              className="ds-btn-primary mt-2.5"
            >
              {enable.isPending ? t("settings.recording.enabling") : t("settings.recording.enable")}
            </button>
            {enable.isError && (
              <p className="mt-2 text-xs text-crit">
                {enable.error instanceof Error ? enable.error.message : String(enable.error)} — {t("common.retry")}.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-2">
            {t("settings.recording.active")}
            {enable.isSuccess && t("settings.recording.activeNext")}
          </p>
        )}
      </section>

      <section className="mb-7">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.language.title")}</h3>
        <p className="mb-2 max-w-[60ch] text-xs text-ink-2">{t("settings.language.text")}</p>
        <div className="inline-flex items-stretch border border-outline" role="group" aria-label={t("settings.language.title")}>
          {LOCALES.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setLocale(o.value)}
              className={cn(
                "px-4 py-2 text-sm text-ink-2",
                i > 0 && "border-l border-outline",
                locale === o.value && "bg-accent text-white",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-7">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.theme.title")}</h3>
        <p className="mb-2 text-xs text-ink-2">{t("settings.theme.device")}</p>
        <div className="inline-flex items-stretch border border-outline" role="group" aria-label={t("settings.theme.title")}>
          {THEMES.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { setTheme(o.value); setThemeState(o.value); }}
              className={cn(
                "px-4 py-2 text-sm text-ink-2",
                i > 0 && "border-l border-outline",
                theme === o.value && "bg-accent text-white",
              )}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </section>

      <ProjectsSection />

      <ClaudeMdBudgetSection />

      <section className="mb-7">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.expert.title")}</h3>
        <p className="mb-2 max-w-[60ch] text-xs text-ink-2">{t("settings.expert.text")}</p>
        <div className="flex flex-col gap-2">
          {EXPERT_LEVELS.map((o) => (
            <label
              key={o.value}
              className={cn(
                "flex cursor-pointer items-baseline gap-3 border border-line px-4 py-3",
                level === o.value && "border-accent bg-accent/5",
              )}
            >
              <input
                type="radio"
                name="expert-level"
                checked={level === o.value}
                onChange={() => { setExpertLevel(o.value); setLevelState(o.value); }}
              />
              <span className="text-sm font-semibold">{o.label}</span>
              <span className="text-xs text-ink-2">{o.hint}</span>
            </label>
          ))}
        </div>
      </section>

      <AboutSection />
    </div>
  );
}

// Über & Feedback (U4): aktive Bitte um Rückmeldung, Repo-Link, Lizenz-Klartext.
// Clean UI — keine AGB-Wand, nur die zwei, drei Sätze, die man wirklich braucht.
function AboutSection() {
  const t = useT();
  const version = __APP_VERSION__;
  const repoUrl = __REPO_URL__;
  const feedbackHref =
    `mailto:martin@extracode.de?subject=${encodeURIComponent(`Cockpit-Feedback (v${version})`)}` +
    `&body=${encodeURIComponent("Was läuft gut, was fehlt, was nervt?\n\n")}`;
  // Lizenz-Satz mit Platzhaltern in fester Reihenfolge {contact}→{a}→{b}: am
  // Platzhalter zerlegen und Kontakt-Link + Datei-Namen als Knoten einsetzen
  // (statt HTML-in-String). parts = [lead, zw1, zw2, tail].
  const parts = t("settings.about.licenseText").split(/\{contact\}|\{a\}|\{b\}/);
  return (
    <section className="mb-7">
      <h3 className="mb-1 text-sm font-semibold">{t("settings.about.title")}</h3>
      <p className="mb-2 text-xs text-ink-2">{t("settings.about.version", { v: version })}</p>
      <p className="mb-3 max-w-[60ch] text-sm text-ink-2">
        {t("settings.about.intro")}{" "}
        <a href={feedbackHref} className="text-accent underline">{t("settings.about.feedback")}</a> {t("settings.about.feedbackTail")}
        {repoUrl && (
          <>
            {" · "}
            <a href={repoUrl} target="_blank" rel="noreferrer" className="text-accent underline">{t("settings.about.repo")}</a>
          </>
        )}
      </p>
      <div className="border-l-4 border-line bg-panel px-4 py-3">
        <div className="mb-1 text-sm font-medium">{t("settings.about.license")}</div>
        <p className="max-w-[60ch] text-xs text-ink-2">
          {parts[0]}
          <a href="mailto:license@thinkinvoice.com" className="text-accent underline">license@thinkinvoice.com</a>
          {parts[1]}
          <code className="font-mono">LICENSE</code>
          {parts[2]}
          <code className="font-mono">LICENSE-COMMERCIAL.md</code>
          {parts[3]}
        </p>
      </div>
    </section>
  );
}

// Projekte-Verwaltung (Paket 5): Aufzeichnen an/aus, Archivieren (aus Auswahl/
// Kacheln/Badges verschwinden, Daten bleiben) und Löschen (purge, doppelte
// Bestätigung). Archivierte Projekte bleiben HIER sichtbar und umkehrbar.
function ProjectsSection() {
  const q = useProjects();
  const setCapture = useSetCapture();
  const setArchived = useSetArchived();
  const del = useDeleteProject();
  const busy = setCapture.isPending || setArchived.isPending || del.isPending;
  const mutErr = setCapture.error ?? setArchived.error ?? del.error;

  const onDelete = (p: ProjectAdmin) => {
    const name = shortName(p.projectPath);
    if (!window.confirm(`Projekt „${name}" wirklich löschen? Alle erfassten Sessions, Karten und Ereignisse werden entfernt.`)) return;
    if (!window.confirm(`Endgültig löschen: „${name}". Das kann nicht rückgängig gemacht werden. Fortfahren?`)) return;
    del.mutate({ project: p.projectPath, confirm: true });
  };

  return (
    <section className="mb-7">
      <h3 className="mb-1 text-sm font-semibold">Projekte</h3>
      <p className="mb-2 max-w-[60ch] text-xs text-ink-2">
        Aufzeichnen aus stoppt neue Sessions dieses Projekts. Archivieren blendet es aus Auswahl, Kacheln und Badges aus — Suche und Verlauf behalten die Daten, umkehrbar. Löschen entfernt die Daten unwiderruflich.
      </p>
      {mutErr && (
        <p className="mb-2 text-xs text-crit">
          {mutErr instanceof Error ? mutErr.message : String(mutErr)} — Erneut versuchen.
        </p>
      )}
      {q.isLoading ? (
        <p className="text-sm text-ink-2">Lädt…</p>
      ) : q.error ? (
        <p className="text-sm text-crit">
          {q.error instanceof Error ? q.error.message : String(q.error)}{" "}
          <button type="button" className="underline" onClick={() => void q.refetch()}>Erneut laden</button>
        </p>
      ) : (q.data?.projects.length ?? 0) === 0 ? (
        <p className="text-sm italic text-ink-2">Noch keine erfassten Projekte.</p>
      ) : (
        <div className="ds-card divide-y divide-line">
          {q.data!.projects.map((p) => (
            <div key={p.projectPath} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3", p.archived && "opacity-60")}>
              <div className="min-w-[160px] flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {shortName(p.projectPath)}
                  {p.archived && <span className="ds-tag">archiviert</span>}
                  {!p.captureEnabled && <span className="ds-tag">Aufzeichnen aus</span>}
                </div>
                <div className="text-xs text-ink-2">
                  {p.lastActivity ? `zuletzt ${dayMonth(p.lastActivity)}` : "keine Aktivität"} · {p.turns} Wortmeldungen · {p.openItems} offen
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={p.captureEnabled}
                  disabled={busy}
                  onChange={(e) => setCapture.mutate({ project: p.projectPath, enabled: e.target.checked })}
                />
                Aufzeichnen
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => setArchived.mutate({ project: p.projectPath, archived: !p.archived })}
                className="ds-btn-ghost border border-line !px-3 text-xs"
              >
                {p.archived ? "Wiederherstellen" : "Archivieren"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(p)}
                className="ds-btn-ghost !px-3 text-xs text-crit"
              >
                Löschen…
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// CLAUDE.md-Budget (Nachtrag 10.07.): manuell einstellbar, global UND je Projekt
// (Projekt überschreibt global). Der Quellen-Check prüft per Websearch-LLM die
// Anthropic-Doku. EHRLICHKEIT (bindend): Anthropic publiziert Stand 10.07. KEINEN
// Zahlwert — der Check erfindet nie einen, sondern zeigt sauber, dass die
// Heuristik bleibt.
function ClaudeMdBudgetSection() {
  const [globalBudget, setGlobalState] = useState(() => getGlobalBudget());
  const projectsQ = useProjects();
  const [proj, setProj] = useState("");
  const [projVal, setProjVal] = useState("");
  const check = useClaudeMdCheck();
  const [last, setLast] = useState<BudgetCheckResult | null>(() => getLastCheck());

  // Projektwechsel: bestehenden Override laden (leer = kein Override).
  useEffect(() => {
    setProjVal(proj ? String(getProjectBudget(proj) ?? "") : "");
  }, [proj]);

  const saveGlobal = (n: number) => {
    setGlobalState(n);
    if (n > 0) setGlobalBudget(n);
  };
  const saveProject = () => {
    const t = projVal.trim();
    const n = t === "" ? null : Number(t);
    setProjectBudget(proj, n != null && Number.isFinite(n) && n > 0 ? n : null);
  };
  const runCheck = () => {
    check.mutate(undefined, {
      onSuccess: (r) => { setLast(r); setLastCheck(r); },
    });
  };

  return (
    <section className="mb-7">
      <h3 className="mb-1 text-sm font-semibold">CLAUDE.md-Budget</h3>
      <p className="mb-2 max-w-[60ch] text-xs text-ink-2">
        Richtwert für die Größe deiner CLAUDE.md-Dateien (in Zeichen). Global und je Projekt einstellbar — das Projekt überschreibt global. Der Wert ist eine <strong>Heuristik</strong>: Anthropic veröffentlicht keinen offiziellen Zahlwert.
      </p>

      <label className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-ink-2">Global:</span>
        <input
          type="number"
          min={1}
          value={globalBudget}
          onChange={(e) => saveGlobal(Number(e.target.value))}
          className="ds-field !w-28 !py-1 text-sm"
        />
        <span className="text-xs text-ink-2">Zeichen</span>
      </label>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">Projekt-Override:</span>
        <select value={proj} onChange={(e) => setProj(e.target.value)} className="ds-field !w-auto !py-1 text-sm">
          <option value="">Projekt wählen…</option>
          {(projectsQ.data?.projects ?? []).map((p) => (
            <option key={p.projectPath} value={p.projectPath}>{shortName(p.projectPath)}</option>
          ))}
        </select>
        {proj && (
          <>
            <input
              type="number"
              min={1}
              placeholder={`global (${globalBudget})`}
              value={projVal}
              onChange={(e) => setProjVal(e.target.value)}
              className="ds-field !w-28 !py-1 text-sm"
            />
            <button type="button" onClick={saveProject} className="ds-btn-ghost border border-line !px-3 text-xs">Speichern</button>
            <button type="button" onClick={() => { setProjectBudget(proj, null); setProjVal(""); }} className="ds-btn-ghost !px-3 text-xs text-ink-2">Override entfernen</button>
          </>
        )}
      </div>

      <div className="border-l-4 border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Quellen-Check</span>
          <button type="button" disabled={check.isPending} onClick={runCheck} className="ds-btn-ghost border border-line !px-3 text-xs">
            {check.isPending ? "Prüft die Anthropic-Doku…" : "Quelle jetzt prüfen"}
          </button>
        </div>
        {check.isError && (
          <p className="mt-1.5 text-xs text-crit">
            {check.error instanceof Error ? check.error.message : String(check.error)} — die Heuristik bleibt.
          </p>
        )}
        {last ? (
          <div className="mt-1.5 text-xs text-ink-2">
            {last.found && last.value != null ? (
              <p className="text-ok">
                Offizieller Wert gefunden: {last.value} {last.unit === "tokens" ? "Tokens" : "Zeichen"}.
                {last.sourceUrl && <> Quelle: <a href={last.sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline">{last.sourceUrl}</a></>}
              </p>
            ) : (
              <p>{last.note}</p>
            )}
            <p className="mt-0.5 text-[11px]">zuletzt geprüft: {new Date(last.checkedAt).toLocaleString("de-DE")}</p>
          </div>
        ) : (
          <p className="mt-1.5 text-xs italic text-ink-2">
            Noch nicht geprüft — die Heuristik ({DEFAULT_CLAUDEMD_BUDGET} Zeichen) gilt.
          </p>
        )}
      </div>
    </section>
  );
}
