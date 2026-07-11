import { Link } from "react-router-dom";
import { Settings } from "lucide-react";
import { useStatus } from "@/api/queries";
import { useT } from "@/lib/i18n";
import { DEFAULT_ACTIVE_DAYS, type Scope } from "@/lib/scope";
import ScopeControl from "./ScopeControl";

// Der Header zieht IMMER den vollen Status (unabhängig von der Auswahl), damit
// das Projekt-Dropdown und die Setup-Chips vollständig sind.
const FULL: Scope = { mode: "all", project: "", days: DEFAULT_ACTIVE_DAYS };

export default function Header() {
  const t = useT();
  const { data } = useStatus(FULL);
  const realProjects = (data?.projects ?? []).filter((p) => !p.global);
  const doctor = data?.doctor ?? [];
  const doctorOk = doctor.every((c) => c.ok);
  const doctorTitle = doctor
    .map((c) => (c.ok ? `✓ ${c.label}` : `✗ ${c.label} — Fix: ${c.fix}`))
    .join("\n");

  // Carbon UI Shell: die globale Kopfzeile ist immer dunkel (Gray 100), auch im
  // Light-Theme — ein festes Chrome, theme-unabhängig. Interaktive Kinder tragen
  // die eigene helle Optik.
  return (
    <header className="relative z-10 flex h-full items-center gap-3 overflow-hidden border-b border-[#393939] bg-[#161616] px-4 text-[#f4f4f4]">
      <Link to="/overview" className="shrink-0 text-base font-semibold tracking-tight">
        Cockpit
      </Link>
      <div className="shrink-0">
        <ScopeControl projectsFull={realProjects} />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        {/* Doctor als EIN Status-Punkt (UI/UX-Befund 7): fünf Chips fraßen den
            44px-Header und erzeugten eine Scrollbar; Details im title-Popover. */}
        {doctor.length > 0 && (
          <span title={doctorTitle} className="inline-flex shrink-0 items-center gap-1.5 text-xs text-[#c6c6c6]">
            <span className={`h-2 w-2 rounded-full ${doctorOk ? "bg-ok" : "bg-crit"}`} />
            {doctorOk ? t("header.systemOk") : t("header.systemProblem")}
          </span>
        )}
        {/* Zahnrad -> /settings (Theme + Expertenlevel; PLAN-Delta 2026-07-08) */}
        <Link
          to="/settings"
          aria-label={t("header.settings")}
          className="shrink-0 rounded p-1.5 text-[#c6c6c6] hover:bg-white/10 hover:text-white"
        >
          <Settings className="h-4 w-4" />
        </Link>
      </div>
    </header>
  );
}
