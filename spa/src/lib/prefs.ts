// Nutzer-Einstellungen (Settings-Seite): Expertenlevel steuert die Persona
// der Haiku-Assists. Persistenz wie das Theme in localStorage — eine
// Geräte-Präferenz, kein DB-Zustand.

import type { BudgetCheckResult } from "@/api/types";

export type ExpertLevel = "vibecoder" | "advanced" | "expert";

const STORAGE_KEY = "cockpit-expert-level";

// Sprache der Oberfläche (U3). EN ist die Basis; DE/FR sind kuratiert, weitere
// Claude-Sprachen lassen sich als Wörterbücher nachrüsten (i18n.tsx).
export type Locale = "en" | "de" | "fr";
const LOCALE_KEY = "cockpit-locale";
const SUPPORTED_LOCALES: Locale[] = ["en", "de", "fr"];

// Migration ohne Überraschung: bestehende Installationen (irgendeine frühere
// cockpit-Präferenz vorhanden) behalten Deutsch; frische Installationen starten
// auf Englisch. Der ermittelte Default wird einmal festgeschrieben.
export function getLocale(): Locale {
  const v = window.localStorage.getItem(LOCALE_KEY);
  if (v && SUPPORTED_LOCALES.includes(v as Locale)) return v as Locale;
  const initial: Locale = hasExistingCockpitPref() ? "de" : "en";
  window.localStorage.setItem(LOCALE_KEY, initial);
  return initial;
}

export function setLocale(l: Locale): void {
  window.localStorage.setItem(LOCALE_KEY, l);
}

function hasExistingCockpitPref(): boolean {
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith("cockpit-") && k !== LOCALE_KEY) return true;
  }
  return false;
}

export const EXPERT_LEVELS: Array<{ value: ExpertLevel; label: string; hint: string }> = [
  { value: "vibecoder", label: "Vibecoder", hint: "Erklärungen ohne Jargon, Konsequenzen ausgeschrieben" },
  { value: "advanced", label: "Fortgeschritten", hint: "normale technische Sprache, keine Grundlagen" },
  { value: "expert", label: "Experte", hint: "maximal dicht, nur die Essenz" },
];

export function getExpertLevel(): ExpertLevel {
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "advanced" || v === "expert" ? v : "vibecoder";
}

export function setExpertLevel(level: ExpertLevel): void {
  window.localStorage.setItem(STORAGE_KEY, level);
}

// CLAUDE.md-Budget (Nachtrag 10.07.): manuell einstellbar, global UND je Projekt
// — das Projekt überschreibt global. Geräte-Präferenz in localStorage.
// EHRLICHKEIT: Der Default ist eine HEURISTIK (Zeichen), KEIN offizieller Wert —
// Anthropic publiziert keinen (Stand 10.07.: "keep it concise").
export const DEFAULT_CLAUDEMD_BUDGET = 8000;
const BUDGET_GLOBAL_KEY = "cockpit-claudemd-budget";
const BUDGET_PROJECT_PREFIX = "cockpit-claudemd-budget:";

function readNumber(key: string): number | null {
  const raw = window.localStorage.getItem(key);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getGlobalBudget(): number {
  return readNumber(BUDGET_GLOBAL_KEY) ?? DEFAULT_CLAUDEMD_BUDGET;
}

export function setGlobalBudget(n: number): void {
  window.localStorage.setItem(BUDGET_GLOBAL_KEY, String(n));
}

// null = kein Projekt-Override (dann gilt der globale Wert).
export function getProjectBudget(project: string): number | null {
  return readNumber(BUDGET_PROJECT_PREFIX + project);
}

export function setProjectBudget(project: string, n: number | null): void {
  const key = BUDGET_PROJECT_PREFIX + project;
  if (n == null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, String(n));
}

// Projekt überschreibt global.
export function effectiveBudget(project?: string | null): number {
  if (project) {
    const p = getProjectBudget(project);
    if (p != null) return p;
  }
  return getGlobalBudget();
}

// Letztes Quellen-Check-Ergebnis (persistiert, damit die ehrliche Notiz sofort
// nach Reload steht, ohne erneuten LLM-Lauf).
const CHECK_KEY = "cockpit-claudemd-check";

export function getLastCheck(): BudgetCheckResult | null {
  try {
    const raw = window.localStorage.getItem(CHECK_KEY);
    return raw ? (JSON.parse(raw) as BudgetCheckResult) : null;
  } catch {
    return null;
  }
}

export function setLastCheck(r: BudgetCheckResult): void {
  window.localStorage.setItem(CHECK_KEY, JSON.stringify(r));
}
