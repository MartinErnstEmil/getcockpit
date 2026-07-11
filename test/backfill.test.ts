// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M2-Gate: Fixture-Import, Doppellauf-Idempotenz, Inkremental-Import,
// Smoke gegen Kopie echter Dateien in %TEMP% mit Zeitmessung (PRD F1).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backfill, listTranscriptFiles } from "../src/backfill.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let projectsDir: string;

function turnLine(uuid: string, content: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    uuid,
    sessionId: "s-1",
    cwd: "C:\\Users\\x\\projA",
    timestamp: "2026-05-16T19:12:57.168Z",
    type: "user",
    message: { role: "user", content },
    ...over,
  });
}

function writeFixture(name: string, lines: string[]): string {
  const p = join(projectsDir, name);
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

beforeEach(() => {
  ts = makeTempStore("cockpit-backfill-");
  projectsDir = join(ts.dir, "projects");
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  ts.cleanup();
});

describe("backfill fixtures", () => {
  it("imports turns, skips broken lines, counts redactions, reports", async () => {
    writeFixture("a.jsonl", [
      turnLine("u-1", "Entscheidung: wir nehmen SQLite"),
      "{ kaputte zeile",
      turnLine("u-2", "mein key ist sk-abcdefgh12345678 bitte merken"),
      JSON.stringify({ type: "file-history-snapshot" }),
      turnLine("u-3", "tool_result only", { isMeta: true }),
    ]);
    const report = await backfill(ts.store, { projectsDir });
    expect(report.files).toBe(1);
    expect(report.turnsInserted).toBe(2);
    expect(report.brokenLines).toBe(1);
    expect(report.redactions).toBe(1);
    expect(ts.store.countTurns()).toBe(2);
    const row = ts.store.rawDb().prepare("SELECT content FROM turns WHERE uuid='u-2'").get() as {
      content: string;
    };
    expect(row.content).not.toContain("sk-abcdefgh12345678");
  });

  it("double run = identical count, zero duplicates (bookkeeping skip)", async () => {
    writeFixture("a.jsonl", [turnLine("u-1", "alpha"), turnLine("u-2", "beta")]);
    const first = await backfill(ts.store, { projectsDir });
    expect(first.turnsInserted).toBe(2);
    const second = await backfill(ts.store, { projectsDir });
    expect(second.files).toBe(0);
    expect(second.filesUnchanged).toBe(1);
    expect(second.turnsInserted).toBe(0);
    expect(ts.store.countTurns()).toBe(2);
  });

  it("incremental import: appended lines land, existing uuids dedupe", async () => {
    const file = writeFixture("a.jsonl", [turnLine("u-1", "alpha")]);
    await backfill(ts.store, { projectsDir });
    appendFileSync(file, turnLine("u-2", "beta") + "\n", "utf8");
    // mtime-Auflösung kann grob sein; size-Änderung reicht dem Bookkeeping.
    const report = await backfill(ts.store, { projectsDir });
    expect(report.files).toBe(1);
    expect(report.turnsInserted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(ts.store.countTurns()).toBe(2);
  });

  it("project filter imports only matching cwd and writes no bookkeeping (D3)", async () => {
    writeFixture("a.jsonl", [
      turnLine("u-1", "in projA"),
      turnLine("u-2", "in projB", { cwd: "C:\\Users\\x\\projB" }),
    ]);
    const report = await backfill(ts.store, { projectsDir, project: "C:\\Users\\x\\projB" });
    expect(report.turnsInserted).toBe(1);
    expect(ts.store.getBackfillFile(join(projectsDir, "a.jsonl"))).toBeNull();
    // Voll-Import danach holt den Rest.
    const full = await backfill(ts.store, { projectsDir });
    expect(full.turnsInserted).toBe(1);
    expect(full.duplicates).toBe(1);
  });

  it("dry-run writes nothing", async () => {
    writeFixture("a.jsonl", [turnLine("u-1", "alpha")]);
    const report = await backfill(ts.store, { projectsDir, dryRun: true });
    expect(report.turnsInserted).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(ts.store.countTurns()).toBe(0);
    expect(ts.store.getBackfillFile(join(projectsDir, "a.jsonl"))).toBeNull();
  });

  // Live-Befund 2026-07-07: dry-run meldete 0 Redactions, Echtlauf 386 —
  // das Human-Gate "Report vor Import sichten" war blind.
  it("dry-run counts redactions identically to the real run", async () => {
    writeFixture("a.jsonl", [
      turnLine("u-1", "key eins sk-abcdefgh12345678 und Bearer abcdefghijklmnop123456"),
      turnLine("u-2", "harmlos"),
    ]);
    const dry = await backfill(ts.store, { projectsDir, dryRun: true });
    expect(ts.store.countTurns()).toBe(0);
    const real = await backfill(ts.store, { projectsDir });
    expect(dry.redactions).toBeGreaterThan(0);
    expect(dry.redactions).toBe(real.redactions);
  });

  it("limit restricts the number of files", async () => {
    writeFixture("a.jsonl", [turnLine("u-1", "a")]);
    writeFixture("b.jsonl", [turnLine("u-2", "b")]);
    const report = await backfill(ts.store, { projectsDir, limit: 1 });
    expect(report.files).toBe(1);
    expect(ts.store.countTurns()).toBe(1);
  });

  it("recurses into project subdirectories", async () => {
    const sub = join(projectsDir, "C--Users-x-projA");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "sess.jsonl"), turnLine("u-1", "tief") + "\n", "utf8");
    const report = await backfill(ts.store, { projectsDir });
    expect(report.turnsInserted).toBe(1);
    // Projektpfad kommt aus cwd, NICHT aus dem Verzeichnisnamen (ADR-007).
    const row = ts.store.rawDb().prepare("SELECT project_path FROM turns").get() as {
      project_path: string;
    };
    expect(row.project_path).toBe("c:/Users/x/projA");
  });
});

// PRD F1/F2-Akzeptanz: Smoke gegen Kopie von >=10 echten Transcript-Dateien
// in %TEMP% (Quelle READ-ONLY), mit Zeitmessung und P95-Suche < 1 s.
describe("backfill smoke against real transcript copies", () => {
  it("imports >=10 real files without crash; P95 search < 1s", async () => {
    const realDir = join(homedir(), ".claude", "projects");
    expect(existsSync(realDir), `Referenz-Verzeichnis fehlt: ${realDir}`).toBe(true);
    const all = listTranscriptFiles(realDir);
    expect(all.length).toBeGreaterThanOrEqual(10);
    // Mittelgroße Dateien: repräsentativ, ohne den Test minutenlang zu machen.
    const bySize = all
      .map((f) => ({ f, size: statSync(f).size }))
      .sort((a, b) => b.size - a.size);
    const picked = bySize.slice(4, 14).map((x) => x.f);
    const smokeDir = mkdtempSync(join(tmpdir(), "cockpit-smoke-"));
    for (let i = 0; i < picked.length; i++) {
      copyFileSync(picked[i]!, join(smokeDir, `real-${i}.jsonl`));
    }
    const report = await backfill(ts.store, { projectsDir: smokeDir });
    console.log(
      `[smoke] ${report.files} Dateien, ${report.turnsInserted} Turns, ${report.brokenLines} Skips, ` +
        `${report.redactions} Redactions, ${report.durationMs} ms`,
    );
    expect(report.files).toBe(10);
    expect(report.turnsInserted).toBeGreaterThan(0);

    const queries = ["error", "fix", "test", "commit", "warum", "implement", "bug", "review"];
    const durations: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const t0 = performance.now();
        ts.store.searchTurns(q, { limit: 20 });
        durations.push(performance.now() - t0);
      }
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    console.log(`[smoke] Suche: ${durations.length} Läufe, P95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(1000);
    rmSync(smokeDir, { recursive: true, force: true });
  }, 120_000);
});
