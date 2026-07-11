import { useScope } from "@/lib/useScope";
import { useT } from "@/lib/i18n";
import { ACTIVE_DAYS_CHOICES, buildActiveSet, type ScopeProject } from "@/lib/scope";
import { shortName, cn } from "@/lib/utils";

// Auswahl-Umschalter im Header (PLAN-PRD §4): [Projekt… ▼][Aktiv N Tage][Alle]
// plus Chip ‹projekt› × bei Einzelwahl. Der Header SPIEGELT jede Projektauswahl
// (Auflage P7) — auch Projektkarten-Klicks setzen dieselbe globale Auswahl.
// "Aktiv" ist rein zeitbasiert (Default 7 Tage); die Periode ist wählbar.
// Segmente tragen Zählwerte (UI/UX-Befund 1): der Umschalter zeigt seine
// Wirkung, statt wie ein toter Schalter auszusehen.
export default function ScopeControl({ projectsFull }: { projectsFull: ScopeProject[] }) {
  const t = useT();
  const { scope, setScope, setDays } = useScope();
  const projects = projectsFull.map((p) => p.projectPath);
  const activeCount = buildActiveSet(projectsFull, scope.days).size;
  return (
    <div className="flex items-center gap-2">
      {/* Carbon-Content-Switcher auf der dunklen Kopfzeile: eckig, aktive
          Segmente in Interactive-Blau. */}
      <div className="inline-flex items-stretch border border-[#4c4c4c]" role="group" aria-label={t("scope.group")}>
        <select
          aria-label={t("scope.chooseProject")}
          className={cn(
            "max-w-[180px] cursor-pointer bg-transparent px-3 py-1.5 text-sm text-[#f4f4f4] outline-none",
            scope.mode === "single" && "bg-[#0f62fe]",
          )}
          value={scope.mode === "single" ? scope.project : ""}
          onChange={(e) => (e.target.value ? setScope("single", e.target.value) : setScope("active"))}
        >
          <option value="" className="bg-[#262626]">{t("scope.project")}</option>
          {projects.map((p) => (
            <option key={p} value={p} className="bg-[#262626]">
              {shortName(p)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setScope("active")}
          className={cn("border-l border-[#4c4c4c] px-3.5 py-1.5 text-sm text-[#c6c6c6]", scope.mode === "active" && "bg-[#0f62fe] text-white")}
        >
          {t("scope.active")} · {activeCount}
        </button>
        {scope.mode === "active" && (
          <select
            aria-label={t("scope.period")}
            className="cursor-pointer border-l border-[#4c4c4c] bg-transparent px-2 py-1.5 text-sm text-[#c6c6c6] outline-none"
            value={scope.days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {ACTIVE_DAYS_CHOICES.map((d) => (
              <option key={d} value={d} className="bg-[#262626]">
                {t("scope.days", { n: d })}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setScope("all")}
          className={cn("border-l border-[#4c4c4c] px-3.5 py-1.5 text-sm text-[#c6c6c6]", scope.mode === "all" && "bg-[#0f62fe] text-white")}
        >
          {t("scope.all")} · {projects.length}
        </button>
      </div>
      {scope.mode === "single" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#393939] px-2.5 py-0.5 text-xs text-[#f4f4f4]">
          {shortName(scope.project)}
          <button
            type="button"
            aria-label={t("scope.clear")}
            className="ml-0.5 rounded-full px-1 hover:bg-white/15"
            onClick={() => setScope("active")}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}
