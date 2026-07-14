// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Gedächtnis & Regeln (v7): der Config-View listet je Projekt CLAUDE.md +
// settings.json (read-only) und hält bei jedem Lesen einen Versions-Snapshot
// fest — aber nur, wenn sich der Inhalt seit dem letzten unterscheidet
// (Hash-Dedup). Echtes Dateisystem + echte DB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configView, writeViewerFile } from "../src/config.js";
import { normalizeProjectPath } from "../src/paths.js";
import { Store } from "../src/store.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let projectDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  ts = makeTempStore("cockpit-config-");
  // Editor-Backups sollen in %TEMP% landen, nicht im echten ~/.cockpit.
  prevHome = process.env["COCKPIT_HOME"];
  process.env["COCKPIT_HOME"] = ts.dir;
  projectDir = join(ts.dir, "proj");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  ts.store.insertTurn({
    uuid: "t-1",
    sessionId: "s-1",
    projectPath: projectDir,
    role: "assistant",
    content: "x",
    timestamp: "2026-06-01T10:00:00Z",
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["COCKPIT_HOME"];
  else process.env["COCKPIT_HOME"] = prevHome;
  ts.cleanup();
});

describe("configView — mehrere Config-Dateien je Projekt", () => {
  it("listet CLAUDE.md (editierbar, mit Budget) und settings.json (read-only)", () => {
    writeFileSync(join(projectDir, "CLAUDE.md"), "# Regeln\n", "utf8");
    writeFileSync(join(projectDir, ".claude", "settings.json"), '{"a":1}\n', "utf8");
    const entries = configView(ts.store, { project: projectDir });
    const claude = entries.find((e) => e.kind === "claude-md")!;
    const settings = entries.find((e) => e.kind === "settings")!;
    expect(claude.editable).toBe(true);
    expect(claude.budget).toBeGreaterThan(0);
    expect(settings.editable).toBe(false);
    expect(settings.budget).toBeNull();
    expect(settings.exists).toBe(true);
  });

  it("blendet nicht vorhandene settings.json aus, zeigt CLAUDE.md aber immer", () => {
    // Keine settings.json geschrieben; CLAUDE.md existiert nicht -> trotzdem gelistet.
    const entries = configView(ts.store, { project: projectDir });
    expect(entries.some((e) => e.kind === "claude-md")).toBe(true);
    expect(entries.some((e) => e.kind === "settings")).toBe(false);
  });
});

describe("Versions-Snapshots (Capture-on-read + Hash-Dedup)", () => {
  it("erster Blick erfasst genau einen Snapshot; unveränderter Blick fügt keinen hinzu", () => {
    const file = join(projectDir, "CLAUDE.md");
    writeFileSync(file, "v1\n", "utf8");
    let entries = configView(ts.store, { project: projectDir });
    expect(entries.find((e) => e.kind === "claude-md")!.historyCount).toBe(1);
    // Zweiter Blick ohne Änderung -> Dedup, immer noch 1.
    entries = configView(ts.store, { project: projectDir });
    expect(entries.find((e) => e.kind === "claude-md")!.historyCount).toBe(1);
  });

  it("nach einer Änderung wächst die Historie und der Diff kennt den Vorgänger", () => {
    const file = join(projectDir, "CLAUDE.md");
    const norm = normalizeProjectPath(file);
    writeFileSync(file, "v1\n", "utf8");
    configView(ts.store, { project: projectDir });
    writeFileSync(file, "v2\n", "utf8");
    const entries = configView(ts.store, { project: projectDir });
    expect(entries.find((e) => e.kind === "claude-md")!.historyCount).toBe(2);
    const snaps = ts.store.listConfigSnapshots(norm);
    expect(snaps.length).toBe(2);
    // Neuester zuerst: dessen Diff trägt den vorherigen Inhalt.
    const diff = ts.store.getConfigSnapshotDiff(snaps[0]!.id)!;
    expect(diff.content).toBe("v2\n");
    expect(diff.prevContent).toBe("v1\n");
    // Ältester hat keinen Vorgänger.
    const first = ts.store.getConfigSnapshotDiff(snaps[1]!.id)!;
    expect(first.prevContent).toBeNull();
  });
});

describe("Snapshot-Härtung (Redaction, Retention, Editor-Save)", () => {
  it("redigiert Secrets im Inhalt VOR dem Persistieren", () => {
    const file = join(projectDir, "CLAUDE.md");
    const norm = normalizeProjectPath(file);
    writeFileSync(file, "token: sk-abcdefghij0123456789XYZ\n", "utf8");
    configView(ts.store, { project: projectDir });
    const snaps = ts.store.listConfigSnapshots(norm);
    const stored = ts.store.getConfigSnapshotDiff(snaps[0]!.id)!;
    expect(stored.content).not.toContain("sk-abcdefghij0123456789XYZ");
    expect(stored.content).toContain("[REDACTED:api-key]");
  });

  it("kappt die Historie auf CONFIG_SNAPSHOT_KEEP je Datei", () => {
    const norm = normalizeProjectPath(join(projectDir, "CLAUDE.md"));
    // Mehr als das Limit an DISTINKTEN Ständen schreiben (Dedup zählt nur Änderungen).
    for (let i = 0; i < Store.CONFIG_SNAPSHOT_KEEP + 5; i++) {
      ts.store.recordConfigSnapshot({ projectPath: projectDir, file: norm, content: `v${i}\n` });
    }
    expect(ts.store.countConfigSnapshots(norm)).toBe(Store.CONFIG_SNAPSHOT_KEEP);
    // Der jüngste Stand bleibt erhalten, die ältesten fallen weg.
    const newest = ts.store.getConfigSnapshotDiff(ts.store.listConfigSnapshots(norm)[0]!.id)!;
    expect(newest.content).toBe(`v${Store.CONFIG_SNAPSHOT_KEEP + 4}\n`);
  });

  it("Editor-Save einer CLAUDE.md hält einen eigenen Snapshot fest", () => {
    const file = join(projectDir, "CLAUDE.md");
    const norm = normalizeProjectPath(file);
    writeFileSync(file, "start\n", "utf8"); // muss existieren (kein Anlegen via Viewer)
    const before = ts.store.countConfigSnapshots(norm);
    const r = writeViewerFile(ts.store, file, projectDir, "start\nedit\n");
    expect(r.ok).toBe(true);
    expect(ts.store.countConfigSnapshots(norm)).toBe(before + 1);
  });
});
