import { useMemo } from "react";
import { useStatus, useItems } from "@/api/queries";
import { buildActiveSet, inScope, inPeriod, type Scope } from "./scope";
import type { Item, ProjectStatus } from "@/api/types";

// Gemeinsame Auswahl-Filterung: EINE useStatus()-Query liefert die aktive
// Menge (Client-Filter "aktive"), der inScope-Selektor gilt für Items,
// Projekte und Aktionen (PLAN-PRD §4). Globale sind immer sichtbar (P1).
export function useScopedStatus(scope: Scope) {
  const status = useStatus(scope);
  const activeSet = useMemo(
    () => buildActiveSet(status.data?.projects ?? [], scope.days),
    [status.data?.projects, scope.days],
  );
  const keep = (projectPath: string | null | undefined) => inScope(scope, projectPath, activeSet);
  // Archiv-Ausschluss (Paket 5): archivierte Projekte fehlen in Badges/Listen;
  // globale Items (kein Projektpfad) sind nie archiviert. portfolioView entfernt
  // sie bereits aus projects[] (Auswahl/Kacheln) — hier für Badges/Items.
  const archived = useMemo(() => new Set(status.data?.archivedProjects ?? []), [status.data?.archivedProjects]);
  const notArchived = (projectPath: string | null | undefined) => !projectPath || !archived.has(projectPath);
  // Echte Projekte in Auswahl (ohne die synthetische Global-Zeile).
  const projects: ProjectStatus[] = (status.data?.projects ?? []).filter(
    (p) => !p.global && keep(p.projectPath),
  );
  const nextActions = (status.data?.nextActions ?? []).filter((a) => keep(a.projectPath));
  return { status, activeSet, keep, notArchived, projects, nextActions };
}

export function useScopedItems(scope: Scope, keep: (p: string | null | undefined) => boolean) {
  const items = useItems(scope);
  const status = useStatus(scope);
  // Archiv-Ausschluss (Paket 5): Items archivierter Projekte fallen aus Inbox
  // UND Badge — so bleibt Kachel == Badge == Liste (Suche/Verlauf behalten sie).
  const archived = useMemo(() => new Set(status.data?.archivedProjects ?? []), [status.data?.archivedProjects]);
  // Zwei Achsen: Projekt-Auswahl (keep) UND Zeitperiode (inPeriod) — die
  // Periode begrenzt in "Aktiv" auch das Karten-Alter, damit der Tage-Filter
  // sichtbar wirkt. hiddenByPeriod macht das Ausblenden ehrlich sichtbar
  // (Badge, Kacheln und Liste bleiben konsistent, weil ALLE aus diesem Set lesen).
  const { inScopeItems, hiddenByPeriod } = useMemo(() => {
    const projectScoped = (items.data?.items ?? []).filter(
      (i) => keep(i.projectPath) && (!i.projectPath || !archived.has(i.projectPath)),
    );
    const scoped = projectScoped.filter((i) => inPeriod(i, scope));
    return { inScopeItems: scoped as Item[], hiddenByPeriod: projectScoped.length - scoped.length };
  }, [items.data?.items, keep, scope, archived]);
  return { items, inScopeItems, hiddenByPeriod };
}
