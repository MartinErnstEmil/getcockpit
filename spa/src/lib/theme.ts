// Theme-Umschalter (PLAN-PRD §6.9): drei Zustände System / Hell / Dunkel über
// das data-theme-Attribut auf dem Root-Element (CSS-Variablen aus §6.5).
// "System" entfernt das Attribut -> zurück zu prefers-color-scheme. Persistenz:
// localStorage — bewusste Ausnahme von der DB-Event-Regel, weil Theme eine
// GERÄTE-Anzeige-Präferenz ist und gerade NICHT zwischen Geräten synchronisiert.

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "cockpit-theme";

export function getTheme(): Theme {
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function setTheme(theme: Theme): void {
  if (theme === "system") window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}
