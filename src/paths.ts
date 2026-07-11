// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// COCKPIT_HOME existiert für Tests (Selbstschutz: nachts wird nur in %TEMP%
// geschrieben) und Sonder-Setups; Produktdefault bleibt ~/.cockpit.
export function cockpitHome(): string {
  const env = process.env["COCKPIT_HOME"];
  if (env && env.trim()) return resolve(env);
  return join(homedir(), ".cockpit");
}

export function resolveDbPath(): string {
  const env = process.env["COCKPIT_DB"];
  if (env && env.trim()) return resolve(env);
  return join(cockpitHome(), "cockpit.db");
}

export function hooksLogPath(): string {
  return join(cockpitHome(), "hooks.log");
}

export function deadLetterPath(): string {
  return join(cockpitHome(), "dead-letter.jsonl");
}

export function hookBundleInstallPath(): string {
  return join(cockpitHome(), "bin", "cockpit-hook.cjs");
}

// Portiert aus dev/cola resolve-store.ts (ursprünglich MIT, (c) 2026,
// relizenziert durch denselben Rechteinhaber). Kanonisiert einen Projektpfad,
// damit dasselbe Verzeichnis immer auf denselben String abbildet — sonst
// zählen `C:/x` und `C:\x` als zwei Projekte ("already burned us once").
export function normalizeProjectPath(p: string): string {
  if (!p) return p;
  let out = p.replace(/\\/g, "/");
  if (/^[A-Z]:\//.test(out)) out = out[0]!.toLowerCase() + out.slice(1);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
