import { Link, useLocation } from "react-router-dom";
import { useStatus } from "@/api/queries";

// Warnbanner über allen Seiten, solange disableAllHooks in der Claude-
// settings.json steht: Hooks sind dann registriert, aber wirkungslos — der
// Kern-Kreislauf (Aufzeichnung + Antwort-Zustellung) steht komplett. Klick
// führt in die Einstellungen, wo ein Knopf das behebt.
export default function HooksBanner() {
  const { search } = useLocation();
  // Gleicher Query-Key wie die Seiten-Status-Queries — kein Extra-Request.
  const status = useStatus({ mode: "active", project: "", days: 7 });
  if (!status.data?.hooksDisabled) return null;
  return (
    <Link
      to={{ pathname: "/settings", search }}
      className="block border-b-2 border-warn bg-warn/15 px-4 py-2 text-center text-xs font-semibold text-ink hover:bg-warn/25"
    >
      ⚠ Hooks deaktiviert — Cockpit zeichnet keine Sessions auf und stellt keine Antworten zu. Klicken, um sie in den Einstellungen zu aktivieren.
    </Link>
  );
}
