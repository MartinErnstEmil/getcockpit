import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Locale } from "./prefs";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Aktive Sprache für die reinen Formatierer (ageText/dayMonth) — vom
// LocaleProvider gesetzt (i18n.tsx). Modul-Variable, damit die Formatierer
// pure Funktionen ohne React-Hook bleiben. Default EN wie die i18n-Basis.
let activeLocale: Locale = "en";
export function setActiveLocale(l: Locale): void {
  activeLocale = l;
}

const AGE_WORDS: Record<Locale, { today: string; yesterday: string; days: (n: number) => string }> = {
  en: { today: "today", yesterday: "since yesterday", days: (n) => `${n} days ago` },
  de: { today: "heute", yesterday: "seit gestern", days: (n) => `seit ${n} Tagen` },
  fr: { today: "aujourd’hui", yesterday: "depuis hier", days: (n) => `il y a ${n} jours` },
};

// Letzter Pfadbestandteil als Projektname (Onepager shortName).
export function shortName(p: string | null | undefined): string {
  if (!p) return "global";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Alter in Klartext der aktiven Sprache: heute / seit gestern / seit N Tagen —
// nach KALENDERTAGEN, nicht 24-h-Fenstern (Bug 10.07.: „9.7. 19:17" zeigte
// am 10.7. mittags noch „heute").
export function ageText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.max(0, Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000));
  const w = AGE_WORDS[activeLocale];
  if (days === 0) return w.today;
  if (days === 1) return w.yesterday;
  return w.days(days);
}

// ISO-Datum kurz (Tag + Monat) in der aktiven Sprache über Intl.
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat(activeLocale, { day: "2-digit", month: "short" }).format(d);
}

// Exakte Uhrzeit hh:mm (lokal); für ältere Karten mit Datum davor.
export function timeText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? hm : `${dayMonth(iso)} · ${hm}`;
}
