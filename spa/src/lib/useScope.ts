import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { DEFAULT_ACTIVE_DAYS, parseScope, type Scope, type ScopeMode } from "./scope";

// Die Auswahl ist ein globaler Query-Param auf jeder Route (?scope=&project=
// &days=). setScope erhält alle anderen Parameter (z. B. ?item=, ?all=1),
// damit Deep-Links und Filter beim Auswahlwechsel überleben (PLAN-PRD §4).
export function useScope(): {
  scope: Scope;
  setScope: (mode: ScopeMode, project?: string) => void;
  setDays: (days: number) => void;
} {
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params);

  const setScope = useCallback(
    (mode: ScopeMode, project?: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (mode === "active") {
            next.delete("scope");
            next.delete("project");
          } else if (mode === "all") {
            next.set("scope", "all");
            next.delete("project");
          } else {
            next.set("scope", "single");
            if (project) next.set("project", project);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setDays = useCallback(
    (days: number) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (days === DEFAULT_ACTIVE_DAYS) next.delete("days");
          else next.set("days", String(days));
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { scope, setScope, setDays };
}
