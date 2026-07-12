import type { ComponentType } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, Inbox, GitBranch, Search, History, FileText, BookOpen, ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useScope } from "@/lib/useScope";
import { isActionable } from "@/lib/scope";
import { useScopedStatus, useScopedItems } from "@/lib/useScopedData";
import { useDecisions } from "@/api/queries";

// Offizielles Git-Logo (Jason Long, CC BY 3.0, git-scm.com/community/logos),
// schwarze Mono-Variante als Git-Tab-Icon (PO 12.07.). fill=currentColor statt
// des Original-#100f0d, damit Hover/Aktiv/Dark-Theme wie bei den Lucide-Icons
// greifen; Pfad und rotate(-45) sind unverändert aus Git-Icon-Black.svg.
function GitLogoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 78 78" fill="currentColor" aria-hidden="true" className={className}>
      <path
        transform="translate(10 10) rotate(-45 29 29)"
        d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"
      />
    </svg>
  );
}

// UI-Wörter bindend (PLAN-PRD §4): "Verlauf" (nie raw/turns), "Gedächtnis &
// Regeln" (nie config/memory). Labels über i18n (U3). Keine Composer-Seite hier.
const NAV: Array<{ to: string; key: string; Icon: ComponentType<{ className?: string }>; badge?: "inbox" | "decisions" }> = [
  { to: "/overview", key: "nav.overview", Icon: LayoutDashboard },
  { to: "/briefing", key: "nav.briefing", Icon: ClipboardList },
  { to: "/inbox", key: "nav.inbox", Icon: Inbox, badge: "inbox" },
  { to: "/decisions", key: "nav.decisions", Icon: GitBranch, badge: "decisions" },
  { to: "/search", key: "nav.search", Icon: Search },
  { to: "/report", key: "nav.report", Icon: BookOpen },
  { to: "/sessions", key: "nav.sessions", Icon: History },
  { to: "/git", key: "nav.git", Icon: GitLogoIcon },
  { to: "/files", key: "nav.files", Icon: FileText },
];

export default function Sidebar() {
  const t = useT();
  const { search } = useLocation();
  const { scope } = useScope();
  const { keep, notArchived } = useScopedStatus(scope);
  const { inScopeItems } = useScopedItems(scope, keep);
  const decisionsQ = useDecisions(scope, false);
  // Badge == Kachel == Liste: dieselbe Prädikat-Funktion (Auflagen T3/P2).
  // PO-Entscheid 09.07.: Badge = handlungspflichtige Zahl, nicht alles Offene.
  // Archivierte Projekte (Paket 5) zählen nicht (inScopeItems ist bereits
  // archiv-gefiltert; Entscheidungen hier explizit).
  const badges = {
    inbox: inScopeItems.filter(isActionable).length,
    decisions: (decisionsQ.data?.decisions ?? []).filter((d) => keep(d.projectPath) && notArchived(d.projectPath)).length,
  };
  return (
    <nav className="flex h-full flex-col py-1 text-sm">
      <ul className="flex flex-col">
        {NAV.map((item) => {
          const count = item.badge ? badges?.[item.badge] : undefined;
          const label = t(item.key);
          return (
            <li key={item.to}>
              {/* Carbon SideNav: eckig, aktive Route = 3px Interactive-Blau-Kante
                  links + selektierte Ebene; Auswahl-Query beim Navigieren erhalten. */}
              <NavLink
                to={{ pathname: item.to, search }}
                title={label}
                aria-label={label}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 border-l-[3px] border-transparent py-3 pl-[13px] pr-4 text-ink-2 transition-colors hover:bg-surface-container hover:text-ink",
                    isActive && "border-accent bg-surface-container font-semibold text-ink",
                  )
                }
              >
                <item.Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
                {count !== undefined && count > 0 && (
                  <span className="ml-auto rounded-full bg-secondary-container px-2 py-0.5 text-xs tabular-nums text-on-secondary-container">
                    {count}
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
