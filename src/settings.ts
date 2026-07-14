// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Idempotente settings.json-Chirurgie (PRD F8). Multiplexer-Pattern aus
// dev/cola hooks.ts (ursprünglich MIT, (c) 2026, relizenziert durch denselben
// Rechteinhaber): eigene Einträge am Marker erkennen, fremde NIE anfassen.
// Windows-Wissen: Pfade im command IMMER forward-slash und gequotet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOOK_MARKER = "cockpit-hook.cjs";
export const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "SessionStart"] as const;

// Bekannte Vorgänger-Produkte derselben Familie (Setup „Legacy entfernen"):
// deren Hook-Bundles dürfen nie neben cockpit weiterlaufen (smriti-Vorfall
// 09.07. — stillgelegtes smriti hängte wiederholt eigene Hooks ein). Nur
// GEZIELT diese Marker gelten als Legacy — fremde, unbekannte Hooks des Nutzers
// werden NIE angetastet oder auch nur zur Entfernung vorgeschlagen.
export const LEGACY_HOOK_MARKERS = [
  "smriti",
  "cola2-hook",
  "cola-hook",
  "garfield-hook",
  "context-engine",
] as const;

export interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type: string; command: string }>;
}

export interface ClaudeSettings {
  hooks?: Record<string, HookEntry[] | undefined>;
  [k: string]: unknown;
}

export function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function hookCommand(bundlePath: string): string {
  // --no-warnings: node:sqlite ist experimental und würde sonst bei jedem
  // Hook-Lauf stderr verschmutzen (D2).
  return `node --no-warnings "${bundlePath.replace(/\\/g, "/")}"`;
}

export function loadSettings(path: string): { settings: ClaudeSettings; raw: string | null } {
  if (!existsSync(path)) return { settings: {}, raw: null };
  const raw = readFileSync(path, "utf8");
  return { settings: JSON.parse(raw) as ClaudeSettings, raw };
}

export function serializeSettings(settings: ClaudeSettings): string {
  return JSON.stringify(settings, null, 2) + "\n";
}

export function saveSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSettings(settings), "utf8");
}

export function isCockpitHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => h.command?.includes(HOOK_MARKER));
}

export interface LegacyHook {
  event: string;
  command: string;
  marker: string;
}

// Stabiler Schlüssel für die Auswahl in Panel/CLI: Ereignis + exaktes Kommando.
// Der Index eignet sich nicht — er verschiebt sich, sobald ein Eintrag entfällt.
export function legacyHookKey(event: string, command: string): string {
  return `${event}::${command}`;
}

// Listet ausschließlich Hooks bekannter Vorgänger-Produkte (LEGACY_HOOK_MARKERS)
// — cockpit-eigene und unbekannte Fremd-Hooks bleiben außen vor.
export function listLegacyHooks(settings: ClaudeSettings): LegacyHook[] {
  const out: LegacyHook[] = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      if (isCockpitHook(entry)) continue;
      for (const h of entry.hooks ?? []) {
        const marker = LEGACY_HOOK_MARKERS.find((m) => h.command?.includes(m));
        if (marker) out.push({ event, command: h.command, marker });
      }
    }
  }
  return out;
}

// Entfernt NUR ausgewählte Legacy-Hooks (keys aus legacyHookKey); cockpit- und
// unbekannte Fremd-Hooks bleiben byte-identisch. Leere Strukturen fallen weg.
export function removeLegacyHooks(
  settings: ClaudeSettings,
  keys: string[],
): { settings: ClaudeSettings; removed: number } {
  const selected = new Set(keys);
  const out: ClaudeSettings = structuredClone(settings);
  let removed = 0;
  for (const [event, entries] of Object.entries(out.hooks ?? {})) {
    if (!entries) continue;
    const kept: HookEntry[] = [];
    for (const entry of entries) {
      if (isCockpitHook(entry)) {
        kept.push(entry);
        continue;
      }
      const hooks = (entry.hooks ?? []).filter((h) => {
        const isLegacy = LEGACY_HOOK_MARKERS.some((m) => h.command?.includes(m));
        if (isLegacy && selected.has(legacyHookKey(event, h.command))) {
          removed++;
          return false;
        }
        return true;
      });
      if (hooks.length > 0) kept.push({ ...entry, hooks });
    }
    if (kept.length === 0) delete out.hooks![event];
    else out.hooks![event] = kept;
  }
  if (out.hooks && Object.keys(out.hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

// Fügt die drei cockpit-Hook-Einträge hinzu; vorhandene cockpit-Einträge werden
// ersetzt (Pfad-Updates), fremde Einträge bleiben byte-identisch erhalten.
export function addCockpitHooks(
  settings: ClaudeSettings,
  bundlePath: string,
): { settings: ClaudeSettings; added: string[]; replaced: string[] } {
  const out: ClaudeSettings = structuredClone(settings);
  out.hooks ??= {};
  const added: string[] = [];
  const replaced: string[] = [];
  for (const event of HOOK_EVENTS) {
    const existing = out.hooks[event] ?? [];
    const foreign = existing.filter((e) => !isCockpitHook(e));
    if (foreign.length !== existing.length) replaced.push(event);
    else added.push(event);
    foreign.push({
      matcher: ".*",
      hooks: [{ type: "command", command: hookCommand(bundlePath) }],
    });
    out.hooks[event] = foreign;
  }
  return { settings: out, added, replaced };
}

// Entfernt ausschließlich cockpit-Einträge; leere Strukturen werden entfernt,
// damit ein Init→Uninstall-Zyklus byte-identisch zur Ausgangsdatei führt.
export function removeCockpitHooks(settings: ClaudeSettings): {
  settings: ClaudeSettings;
  removed: string[];
} {
  const out: ClaudeSettings = structuredClone(settings);
  const removed: string[] = [];
  if (!out.hooks) return { settings: out, removed };
  for (const [event, entries] of Object.entries(out.hooks)) {
    if (!entries) continue;
    const kept = entries.filter((e) => !isCockpitHook(e));
    if (kept.length !== entries.length) removed.push(event);
    if (kept.length === 0) delete out.hooks[event];
    else out.hooks[event] = kept;
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

export function hasCockpitHooks(settings: ClaudeSettings): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const event of HOOK_EVENTS) {
    result[event] = (settings.hooks?.[event] ?? []).some(isCockpitHook);
  }
  return result;
}
