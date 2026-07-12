// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Z3-Gate: der Zustell-Selbsttest gegen das GEBAUTE Hook-Bundle. Isoliert
// (Temp-DB/-Home im Modul selbst); der Fehlerpfad darf nie werfen.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runDeliverySelftest } from "../src/selftest.js";

const BUNDLE = join(process.cwd(), "dist", "hooks", "cockpit-hook.cjs");

describe("runDeliverySelftest (Zustell-Kette)", () => {
  it("beweist die Kette gegen das gebaute Bundle: ok=true mit Dauer", () => {
    const r = runDeliverySelftest(BUNDLE);
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    // Positiver Lauf gegen ein explizites, existierendes Bundle: kein Grund nötig.
    expect(r.reason).toBeUndefined();
  });

  it("Bundle-Pfad zeigt ins Leere: ok=false mit Grund, kein Throw", () => {
    const r = runDeliverySelftest(join(process.cwd(), "dist", "hooks", "gibtsnicht.cjs"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nicht gefunden/);
  });
});
