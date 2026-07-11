import { useQueryClient } from "@tanstack/react-query";
import { apiPost } from "@/api/client";

// Onboarding-Hinweis (PLAN-PRD §6.6): genau EINMAL, Dismiss-forever. Zustand in
// DB-Events (bindende Entscheidung 5), NICHT localStorage. Anzeige-Bedingung
// kommt aus status.dismissedHints.
export default function OnboardingBanner() {
  const qc = useQueryClient();
  const dismiss = async () => {
    await apiPost("/api/events", { eventType: "hint_dismiss", payload: { hint: "onboarding" } });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
  return (
    <div className="mb-5 border-l-4 border-accent bg-primary-container px-4 py-3.5 text-sm text-on-primary-container">
      <p>
        So funktioniert dein Cockpit: Agenten legen Fragen ab, du beantwortest sie hier, die Antwort
        geht in die nächste Session.
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void dismiss()} className="ds-btn-primary !py-1.5 text-xs">
          Verstanden
        </button>
        <button type="button" onClick={() => void dismiss()} className="ds-btn-ghost !py-1.5 text-xs">
          nicht mehr zeigen
        </button>
      </div>
    </div>
  );
}
