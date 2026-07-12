// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Zustell-Selbsttest (Zustell-Transparenz): beweist die Kette Hook -> Claim ->
// Injektion auf DIESER Maschine, vollständig isoliert (Temp-DB/-Home in %TEMP%,
// eigenes Temp-Projekt) — die echte cockpit.db und ~/.claude bleiben unberührt
// (Selbstschutz-Verbote). Kein Throw nach außen: jeder Ausgang ist ein Ergebnis
// mit Klartext-Grund, damit doctor/Web ihn direkt anzeigen können.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { hookBundleInstallPath } from "./paths.js";
import { Store } from "./store.js";

// Repo-Build des Hook-Bundles (dist/hooks/cockpit-hook.cjs) — dieselbe Datei,
// die cockpit init kopiert. Lokal berechnet (kein Import aus lifecycle.ts, das
// selbst den Selbsttest zieht) — vermeidet einen Modul-Zyklus.
const HERE = dirname(fileURLToPath(import.meta.url));
function repoHookBundle(): string {
  return join(HERE, "hooks", "cockpit-hook.cjs");
}

export interface SelftestResult {
  ok: boolean;
  ms: number;
  reason?: string;
}

// Isoliert die Zustell-Kette: seedet eine menschlich beantwortete Karte in einer
// Temp-DB und feuert das GEBAUTE Hook-Bundle mit einer synthetischen
// UserPromptSubmit-Payload — erwartet die Antwort im additionalContext UND das
// Item als zugestellt markiert. Bevorzugt das installierte Bundle; fehlt es,
// greift der Repo-Build (mit Hinweis, dass `cockpit init` aussteht).
// bundleOverride: explizites Bundle statt der Install-/Repo-Auflösung (Tests
// und Diagnose). Ohne Override wird das installierte Bundle bevorzugt.
export function runDeliverySelftest(bundleOverride?: string): SelftestResult {
  const t0 = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), "cockpit-selftest-"));
  const dbPath = join(tmp, "cockpit.db");
  const home = join(tmp, "home");
  const project = "c:/cockpit-selftest";
  // Einmaliger Marker als Antworttext — eindeutig im injizierten Kontext suchbar.
  const marker = `selftest-${randomBytes(6).toString("hex")}`;
  const finish = (ok: boolean, reason?: string): SelftestResult => ({ ok, ms: Date.now() - t0, reason });

  try {
    let bundle = bundleOverride ?? hookBundleInstallPath();
    let notInstalledHint: string | undefined;
    if (!bundleOverride && !existsSync(bundle)) {
      bundle = repoHookBundle();
      notInstalledHint = "Bundle nicht installiert (cockpit init fehlt) — Repo-Build getestet";
    }
    if (!existsSync(bundle)) return finish(false, "Hook-Bundle nicht gefunden — cockpit init ausführen");

    const seed = Store.open(dbPath);
    const item = seed.addItem({ type: "question", title: "Zustell-Selbsttest", projectPath: project, source: "claude" });
    seed.answerItem(item.id, marker, "human");
    seed.close();

    const res = spawnSync(process.execPath, ["--no-warnings", bundle], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "selftest", cwd: project, prompt: "selbsttest" }),
      encoding: "utf8",
      env: { ...process.env, COCKPIT_DB: dbPath, COCKPIT_HOME: home },
      timeout: 10_000,
    });
    if (res.status !== 0) return finish(false, `Hook endete mit Exit ${res.status ?? "?"} (erwartet 0)`);
    if (!res.stdout.trim()) return finish(false, "Hook lieferte keine Injektion (leerer stdout)");
    let context: string;
    try {
      context = (JSON.parse(res.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? "";
    } catch {
      return finish(false, "Hook-Ausgabe war kein JSON");
    }
    if (!context.includes(marker)) return finish(false, "Antwort fehlte im injizierten Kontext");

    const check = Store.open(dbPath);
    const delivered = !!check.getItem(item.id)?.deliveredAt;
    check.close();
    if (!delivered) return finish(false, "Item wurde nicht als zugestellt markiert");

    return finish(true, notInstalledHint);
  } catch (err) {
    return finish(false, err instanceof Error ? err.message : String(err));
  } finally {
    // Temp-Verzeichnis best-effort entfernen (nichts überlebt).
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // %TEMP% wird ohnehin geleert.
    }
  }
}
