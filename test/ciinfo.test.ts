// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Reine CI-Klassifikation (Ship-Tab Slice 2) — testbar OHNE gh/Netz. Die
// gh-spawnenden Teile (Präsenz/Login/run-list) sind dünne I/O und laufen im
// Web-Smoke-Test fail-open gegen die echte Umgebung.
import { describe, it, expect } from "vitest";
import { classifyCiRuns, type GhRun } from "../src/ciinfo.js";

const run = (over: Partial<GhRun>): GhRun => ({
  headSha: "aaa",
  status: "completed",
  conclusion: "success",
  workflowName: "CI",
  url: "https://example/run",
  databaseId: 1,
  ...over,
});

describe("classifyCiRuns (reine Ableitung)", () => {
  it("kein Lauf für HEAD + ahead>0 = unpushed (nicht 'kaputt')", () => {
    expect(classifyCiRuns([run({ headSha: "other" })], "aaa", { ahead: 2, behind: 0 }).state).toBe("unpushed");
  });

  it("kein Lauf für HEAD + nichts ahead = no-run", () => {
    expect(classifyCiRuns([], "aaa", { ahead: 0, behind: 0 }).state).toBe("no-run");
    expect(classifyCiRuns([], "aaa", null).state).toBe("no-run");
  });

  it("passender Fehl-Lauf = failed, trägt runId für die Log-Übersetzung", () => {
    const s = classifyCiRuns([run({ conclusion: "failure", databaseId: 42 })], "aaa", null);
    expect(s.state).toBe("failed");
    expect(s.runId).toBe(42);
  });

  it("alle passenden Läufe grün = passed", () => {
    expect(classifyCiRuns([run({}), run({ workflowName: "Deploy" })], "aaa", null).state).toBe("passed");
  });

  it("laufender Lauf (status != completed) = running", () => {
    expect(classifyCiRuns([run({ status: "in_progress", conclusion: null })], "aaa", null).state).toBe("running");
  });

  it("failed schlägt running (ein roter Pflicht-Job versteckt sich nicht)", () => {
    const runs = [run({ status: "in_progress", conclusion: null }), run({ conclusion: "failure", databaseId: 7 })];
    const s = classifyCiRuns(runs, "aaa", null);
    expect(s.state).toBe("failed");
    expect(s.runId).toBe(7);
  });

  it("nur Läufe mit passendem headSha zählen", () => {
    const runs = [run({ headSha: "zzz", conclusion: "failure" }), run({ headSha: "aaa", conclusion: "success" })];
    expect(classifyCiRuns(runs, "aaa", null).state).toBe("passed");
  });
});
