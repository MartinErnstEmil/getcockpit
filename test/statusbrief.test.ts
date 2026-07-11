// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Projekt-Briefing: LLM-Pfad mit Mock-Binary, Fail-open-Degradation auf den
// Rohbericht (gleiche Disziplin wie Standup F11).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runStatusBrief } from "../src/statusbrief.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;

beforeEach(() => {
  ts = makeTempStore("cockpit-brief-");
  ts.store.insertTurn({
    uuid: "t-b1",
    sessionId: "s-b1",
    projectPath: "c:/dev/briefdemo",
    role: "user",
    content: "Bitte baue das Login-Formular fertig.",
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
  });
  ts.store.addItem({ type: "question", title: "Welche Farbe für den Button?", projectPath: "c:/dev/briefdemo" });
});

afterEach(() => ts.cleanup());

describe("runStatusBrief", () => {
  it("liefert den LLM-Bericht, wenn das Binary antwortet", async () => {
    const brief = await runStatusBrief(ts.store, {
      project: "c:/dev/briefdemo",
      claudeCmd: {
        cmd: process.execPath,
        baseArgs: ["-e", "console.log('## Wo das Projekt steht\\nLogin in Arbeit.')"],
      },
    });
    expect(brief.mode).toBe("llm");
    expect(brief.report).toContain("Wo das Projekt steht");
  });

  it("degradiert fail-open auf den Rohbericht, wenn das Binary fehlt", async () => {
    const brief = await runStatusBrief(ts.store, {
      project: "c:/dev/briefdemo",
      claudeCmd: { cmd: "gibts-nicht-binary", baseArgs: [] },
      timeoutMs: 3000,
    });
    expect(brief.mode).toBe("raw");
    expect(brief.degradedBecause).toBeTruthy();
    // Der Rohbericht trägt die offene Frage — ehrliche Anzeige ohne KI.
    expect(brief.report).toContain("Welche Farbe für den Button?");
  });
});
