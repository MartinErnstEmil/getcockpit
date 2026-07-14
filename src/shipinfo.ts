// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Ship-Tab Slice 1 (local, kein Netz, keine Ausführung): sammelt ROHE Signale
// aus dem Projekt-Wurzelverzeichnis — welcher Deploy-Ziel-Marker liegt vor,
// welche npm-Skripte gibt es, existiert ein Deploy-Workflow. Die Klassifikation
// (Ziel + Kommando + Klartext) passiert rein und getestet in der SPA
// (shipplan.ts) — dieser Server-Teil liest nur eine feste Allowlist von Dateien.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Nur diese Namen werden im Wurzelverzeichnis geprüft (Wurzel-only bewusst:
// eine vercel.json in einem Unterordner/example ist kein Deploy-Ziel).
// Exportiert, damit ein Test die Kopplung zum Client-Klassifikator (shipplan.ts)
// absichert: jeder hier gemeldete Marker muss dort auch verstanden werden.
export const MARKER_FILES = [
  "vercel.json",
  ".vercel/project.json",
  "netlify.toml",
  ".netlify/state.json",
  "fly.toml",
  "wrangler.toml",
  "wrangler.jsonc",
  "render.yaml",
  "Dockerfile",
  "Procfile",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Makefile",
  "package.json",
] as const;

export interface ShipSignals {
  // Vorhandene aus MARKER_FILES (Teilmenge).
  files: string[];
  // Namen der package.json-scripts (leer, wenn keine package.json / keine scripts).
  npmScripts: string[];
  // .github/workflows/ enthält ein *deploy*.y(a)ml.
  deployWorkflow: boolean;
}

// null = Verzeichnis fehlt (z. B. Repo umgezogen). Sonst best-effort — jede
// Teiloperation fällt bei Fehler auf leer zurück, wirft nie.
export function collectShipSignals(cwd: string): ShipSignals | null {
  if (!existsSync(cwd)) return null;
  const files = MARKER_FILES.filter((f) => existsSync(join(cwd, f)));
  return {
    files,
    npmScripts: files.includes("package.json") ? readNpmScripts(cwd) : [],
    deployWorkflow: hasDeployWorkflow(cwd),
  };
}

function readNpmScripts(cwd: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return pkg.scripts ? Object.keys(pkg.scripts) : [];
  } catch {
    return []; // kaputte/riesige package.json -> keine Skripte, kein Absturz
  }
}

function hasDeployWorkflow(cwd: string): boolean {
  try {
    return readdirSync(join(cwd, ".github", "workflows")).some(
      (f) => /deploy/i.test(f) && /\.ya?ml$/i.test(f),
    );
  } catch {
    return false; // kein workflows-Verzeichnis
  }
}
