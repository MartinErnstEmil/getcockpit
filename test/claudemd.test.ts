// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CLAUDE.md-Budget-Quellen-Check: der Ehrlichkeits-Guard ist bindend — ein Wert
// wird NUR mit found + konkreter Zahl + anthropic.com-Quelle übernommen, sonst
// bleibt die Heuristik. Getestet gegen ein Mock-Binary (kein echter Websearch).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBudgetCheck } from "../src/claudemd.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-claudemd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mock(output: string): { cmd: string; baseArgs: string[] } {
  const p = join(dir, "mock.cjs");
  writeFileSync(
    p,
    `process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write(${JSON.stringify(output)}))`,
    "utf8",
  );
  return { cmd: process.execPath, baseArgs: [p] };
}

describe("runBudgetCheck (Ehrlichkeits-Guard)", () => {
  it("übernimmt einen Wert NUR mit found + Zahl + anthropic.com-Quelle", async () => {
    const r = await runBudgetCheck({
      claudeCmd: mock('{"found":true,"value":25000,"unit":"chars","sourceUrl":"https://docs.anthropic.com/claude-code/memory"}'),
      timeoutMs: 10_000,
    });
    expect(r.found).toBe(true);
    expect(r.value).toBe(25000);
    expect(r.unit).toBe("chars");
  });

  it("verwirft einen Wert mit fremder Quelle — erfindet nichts", async () => {
    const r = await runBudgetCheck({
      claudeCmd: mock('{"found":true,"value":9999,"unit":"chars","sourceUrl":"https://random-blog.example/claude"}'),
      timeoutMs: 10_000,
    });
    expect(r.found).toBe(false);
    expect(r.value).toBeNull();
    expect(r.note).toContain("Heuristik");
  });

  it("found=false → Heuristik bleibt (keep it concise)", async () => {
    const r = await runBudgetCheck({
      claudeCmd: mock('{"found":false,"value":null,"unit":null,"sourceUrl":null}'),
      timeoutMs: 10_000,
    });
    expect(r.found).toBe(false);
    expect(r.note).toContain("keep it concise");
  });

  it("kaputte Ausgabe → Heuristik, kein Crash", async () => {
    const r = await runBudgetCheck({ claudeCmd: mock("kein json hier"), timeoutMs: 10_000 });
    expect(r.found).toBe(false);
    expect(r.value).toBeNull();
  });

  it("LLM nicht verfügbar → Heuristik-Notiz statt Absturz", async () => {
    const r = await runBudgetCheck({ claudeCmd: { cmd: "cockpit-kein-binary", baseArgs: [] }, timeoutMs: 5_000 });
    expect(r.found).toBe(false);
    expect(r.note).toContain("nicht möglich");
  });
});
