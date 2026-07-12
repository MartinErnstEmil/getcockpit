import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, Inbox, GitBranch, GitCommitHorizontal, Search, History, FileText, BookOpen, ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useScope } from "@/lib/useScope";
import { isActionable } from "@/lib/scope";
import { useScopedStatus, useScopedItems } from "@/lib/useScopedData";
import { useDecisions } from "@/api/queries";

// UI-Wörter bindend (PLAN-PRD §4): "Verlauf" (nie raw/turns), "Gedächtnis &
// Regeln" (nie config/memory). Labels über i18n (U3). Keine Composer-Seite hier.
const NAV: Array<{ to: string; key: string; Icon: typeof Inbox; badge?: "inbox" | "decisions" }> = [
  { to: "/overview", key: "nav.overview", Icon: LayoutDashboard },
  { to: "/briefing", key: "nav.briefing", Icon: ClipboardList },
  { to: "/inbox", key: "nav.inbox", Icon: Inbox, badge: "inbox" },
  { to: "/decisions", key: "nav.decisions", Icon: GitBranch, badge: "decisions" },
  { to: "/search", key: "nav.search", Icon: Search },
  { to: "/report", key: "nav.report", Icon: BookOpen },
  { to: "/sessions", key: "nav.sessions", Icon: History },
  { to: "/git", key: "nav.git", Icon: GitCommitHorizontal },
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
