// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// F11-Gate: deterministische Sammelphase (Fair-Share), Source-Grounding
// (erfundene SHA/Item-Id/Daten werden gestrippt), Degradations-Pfade
// (kein Binary / unparsebare Ausgabe → Rohbericht, nie Hard-Fail).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL_UPSERT_GIT_STATE, gitStateParams } from "../src/schema.js";
import {
  collectStandupData,
  groundReport,
  parseSince,
  renderRawReport,
  runStandup,
} from "../src/standup.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
const NOW = "2026-07-07T12:00:00.000Z";
const SINCE = "2026-07-06T12:00:00.000Z";

beforeEach(() => {
  ts = makeTempStore("cockpit-standup-");
});

afterEach(() => {
  ts.cleanup();
});

function seed(): { itemId: string } {
  ts.store.insertTurn({
    uuid: "u-1",
    sessionId: "s-1",
    projectPath: "c:/dev/p",
    role: "user",
    content: "Bitte baue das Statusboard fertig",
    timestamp: "2026-07-07T08:00:00.000Z",
  });
  ts.store.insertTurn({
    uuid: "u-2",
    sessionId: "s-1",
    projectPath: "c:/dev/p",
    role: "user",
    content: "Alter Turn, außerhalb des Zeitraums",
    timestamp: "2026-07-01T08:00:00.000Z",
  });
  ts.store.rawDb()
    .prepare(SQL_UPSERT_GIT_STATE)
    .run(
      ...gitStateParams({
        projectPath: "c:/dev/p",
        headSha: "abc1234def5678900000",
        branch: "master",
        dirtyFiles: 0,
        lastCommitAt: "2026-07-07T09:00:00.000Z",
        recentCommits: [
          { sha: "abc1234def5678900000", at: "2026-07-07T09:00:00.000Z", subject: "feat: board" },
          { sha: "ffff000011112222", at: "2026-06-01T09:00:00.000Z", subject: "alt, vor Zeitraum" },
        ],
      }),
    );
  const q = ts.store.addItem({ type: "question", title: "Welche Farbe?", projectPath: "c:/dev/p" });
  ts.store.answerItem(q.id, "Blau", "human");
  return { itemId: q.id };
}

describe("collectStandupData", () => {
  it("filters by since, groups by project, includes commits and items", () => {
    const { itemId } = seed();
    const data = collectStandupData(ts.store, { since: SINCE, now: NOW });
    expect(data.projects.length).toBe(1);
    const p = data.projects[0]!;
    expect(p.projectPath).toBe("c:/dev/p");
    expect(p.userPrompts).toEqual(["Bitte baue das Statusboard fertig"]);
    expect(p.commits.map((c) => c.subject)).toEqual(["feat: board"]);
    expect(p.resolvedItems.map((i) => i.id)).toEqual([itemId]);
  });

  it("fair-share caps a chatty project and marks it truncated", () => {
    for (let i = 0; i < 200; i++) {
      ts.store.insertTurn({
        uuid: `u-${i}`,
        sessionId: "s-1",
        projectPath: "c:/dev/laut",
        role: "user",
        content: "x".repeat(290),
        timestamp: "2026-07-07T08:00:00.000Z",
      });
    }
    const data = collectStandupData(ts.store, { since: SINCE, now: NOW });
    const p = data.projects[0]!;
    expect(p.truncated).toBe(true);
    const used = p.userPrompts.reduce((a, s) => a + s.length, 0);
    expect(used).toBeLessThanOrEqual(30_000);
  });
});

describe("groundReport (Quellenpflicht)", () => {
  it("keeps cited references from the payload, strips fabricated ones", () => {
    const { itemId } = seed();
    const data = collectStandupData(ts.store, { since: SINCE, now: NOW });
    const report = [
      "## c:/dev/p",
      "**Getan** Commit abc1234 feat: board am 2026-07-07.",
      `**Entschieden** ${itemId} Welche Farbe? -> Blau.`,
      "**Erfunden** Commit deadbee9 am 2026-08-15 und Item i-ffffff99.",
    ].join("\n");
    const { text, stripped } = groundReport(report, data);
    expect(text).toContain("abc1234 feat: board");
    expect(text).toContain(itemId);
    expect(text).not.toContain("deadbee9");
    expect(text).not.toContain("2026-08-15");
    expect(text).not.toContain("i-ffffff99");
    expect(stripped).toBe(3);
    expect(text).toContain("3 unbelegte Referenzen entfernt");
  });
});

describe("runStandup Degradation (fail-open)", () => {
  it("falls back to the raw report when the binary is missing", async () => {
    seed();
    const result = await runStandup(ts.store, {
      since: SINCE,
      claudeCmd: { cmd: "cockpit-nonexistent-binary", baseArgs: [] },
      timeoutMs: 5_000,
    });
    expect(result.mode).toBe("raw");
    expect(result.degradedBecause).toBeTruthy();
    expect(result.report).toContain("# Standup");
    expect(result.report).toContain("abc1234 feat: board");
  });

  it("falls back when the output is unparsable, uses LLM output when structured", async () => {
    seed();
    const dir = ts.dir;
    const bad = join(dir, "bad.cjs");
    writeFileSync(bad, "process.stdout.write('nur eine zeile ohne struktur')", "utf8");
    const badResult = await runStandup(ts.store, {
      since: SINCE,
      claudeCmd: { cmd: process.execPath, baseArgs: [bad] },
      timeoutMs: 10_000,
    });
    expect(badResult.mode).toBe("raw");
    expect(badResult.degradedBecause).toBe("unparsebare Ausgabe");

    const good = join(dir, "good.cjs");
    writeFileSync(
      good,
      "process.stdout.write('## c:/dev/p\\n**Getan** Commit abc1234 und erfundenes ffffff1 fertig.')",
      "utf8",
    );
    const goodResult = await runStandup(ts.store, {
      since: SINCE,
      claudeCmd: { cmd: process.execPath, baseArgs: [good] },
      timeoutMs: 10_000,
    });
    expect(goodResult.mode).toBe("llm");
    expect(goodResult.report).toContain("abc1234");
    expect(goodResult.report).not.toContain("ffffff1");
    expect(goodResult.strippedReferences).toBe(1);
  });

  it("raw report is deterministic and lists open items", () => {
    seed();
    ts.store.addItem({ type: "blocker", title: "Offener Blocker", projectPath: "c:/dev/p" });
    const data = collectStandupData(ts.store, { since: SINCE, now: NOW });
    const raw = renderRawReport(data);
    expect(raw).toContain("Offen (wartet auf Mensch):");
    expect(raw).toContain("Offener Blocker");
  });
});

describe("parseSince", () => {
  const now = Date.parse(NOW);
  it("parses relative days, yesterday and ISO", () => {
    expect(parseSince("1d", now)).toBe("2026-07-06T12:00:00.000Z");
    expect(parseSince("7d", now)).toBe("2026-06-30T12:00:00.000Z");
    expect(parseSince("yesterday", now)).toBe("2026-07-06T12:00:00.000Z");
    expect(parseSince("2026-07-01", now)).toBe("2026-07-01T00:00:00.000Z");
    expect(() => parseSince("nächste woche", now)).toThrow(/Ungültiges/);
  });
});

describe("prompt via stdin (Windows-argv-Limit)", () => {
  it("delivers the full prompt through stdin, not argv", async () => {
    seed();
    const echo = join(ts.dir, "echo.cjs");
    writeFileSync(
      echo,
      "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.includes('DATEN (JSON)')&&d.includes('abc1234def5678900000')?'## c:/dev/p\\nstdin-ok':'kaputt'))",
      "utf8",
    );
    const result = await runStandup(ts.store, {
      since: SINCE,
      claudeCmd: { cmd: process.execPath, baseArgs: [echo] },
      timeoutMs: 10_000,
    });
    expect(result.mode).toBe("llm");
    expect(result.report).toContain("stdin-ok");
  });
});
