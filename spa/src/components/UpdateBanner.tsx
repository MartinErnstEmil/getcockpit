import { useState } from "react";
import { useUpdate } from "@/api/queries";

// Update-Hinweis über allen Seiten, wenn die npm-Registry eine neuere Version
// meldet. Dismiss ist versionsgebunden (localStorage trägt die weggeklickte
// Version) — eine NOCH neuere Version zeigt den Hinweis wieder. Kein DB-Event
// nötig (rein kosmetischer, client-lokaler Hinweis, anders als das Onboarding).
const DISMISS_KEY = "cockpit-update-dismissed";

export default function UpdateBanner() {
  const { data } = useUpdate();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) ?? "");
  if (!data?.updateAvailable || !data.latest || dismissed === data.latest) return null;
  const latest = data.latest;
  return (
    <div className="flex items-center gap-2 border-b-2 border-accent bg-accent/10 px-4 py-2 text-xs text-ink">
      <span className="flex-1 text-center font-semibold">
        Update verfügbar: {latest} (installiert {data.current}). Neuen Installer laden — die Hooks heilen beim nächsten Start.
      </span>
      <button
        type="button"
        aria-label="Hinweis ausblenden"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, latest);
          setDismissed(latest);
        }}
        className="shrink-0 rounded px-1.5 text-muted hover:bg-line hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
