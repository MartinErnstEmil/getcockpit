// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Setup-Orchestrator: reine Settings-Chirurgie (Legacy erkennen/entfernen) als
// Unit-Test + `cockpit setup` als Kindprozess gegen Temp-settings.json/-home
// (nie gegen ~/.claude; --settings deaktiviert MCP-Spawns wie in lifecycle.test).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyHookKey, listLegacyHooks, removeLegacyHooks, type ClaudeSettings } from "../src/settings.js";
import { fileSetupBlocker, type SetupReport } from "../src/setup.js";
import { makeTempStore, type TempStore } from "./helpers.js";

const CLI = join(process.cwd(), "dist", "cli.js");

let tmp: string;
let home: string;
let dbPath: string;
let settingsPath: string;
let webRoot: string;

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, COCKPIT_DB: dbPath, COCKPIT_HOME: home },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Setup mit einer SPA-Fixture (der Test baut nur den Server, dist/web fehlt).
function setup(extra: string[] = []): ReturnType<typeof cli> {
  return cli(["setup", "--settings", settingsPath, "--web-root", webRoot, ...extra]);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-setup-"));
  home = join(tmp, "home");
  dbPath = join(tmp, "cockpit.db");
  settingsPath = join(tmp, "settings.json");
  webRoot = join(tmp, "web");
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>SPA</title>");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const LEGACY_SETTINGS: ClaudeSettings = {
  hooks: {
    Stop: [
      { matcher: ".*", hooks: [{ type: "command", command: 'node "C:/old/smriti-hook.cjs"' }] },
      { matcher: ".*", hooks: [{ type: "command", command: 'node "C:/mine/legit.cjs"' }] },
    ],
    SessionStart: [{ matcher: ".*", hooks: [{ type: "command", command: 'node "C:/old/cola2-hook.cjs"' }] }],
  },
};

describe("Legacy-Hook-Erkennung (rein)", () => {
  it("listet NUR bekannte Legacy-Marker, nie unbekannte Fremd-Hooks", () => {
    const legacy = listLegacyHooks(LEGACY_SETTINGS);
    expect(legacy.map((l) => l.marker).sort()).toEqual(["cola2-hook", "smriti"]);
    expect(legacy.some((l) => l.command.includes("legit"))).toBe(false);
  });

  it("entfernt nur ausgewählte Legacy-Keys; cockpit- und Fremd-Hooks bleiben", () => {
    const keys = [legacyHookKey("Stop", 'node "C:/old/smriti-hook.cjs"')];
    const { settings, removed } = removeLegacyHooks(LEGACY_SETTINGS, keys);
    expect(removed).toBe(1);
    expect(settings.hooks!.Stop).toHaveLength(1);
    expect(settings.hooks!.Stop![0].hooks![0].command).toContain("legit");
    expect(settings.hooks!.SessionStart).toHaveLength(1); // cola2 nicht gewählt -> bleibt
  });
});

describe("cockpit setup (CLI, Temp-settings)", () => {
  it("frische Maschine: Bundle installiert, Hooks registriert, alle Stufen OK, Log geschrieben", () => {
    const res = setup();
    for (const code of ["E100", "E200", "E300", "E400", "E500", "E700"]) {
      expect(res.stdout).toContain(`[${code}]`);
    }
    expect(res.status).toBe(0);
    expect(existsSync(join(home, "bin", "cockpit-hook.cjs"))).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("cockpit-hook.cjs");
    expect(existsSync(join(home, "setup.log"))).toBe(true);
    // Das kopierte Bundle trägt die gestanzte Version.
    const head = readFileSync(join(home, "bin", "cockpit-hook.cjs"), "utf8").slice(0, 200);
    expect(head).toMatch(/cockpit-hook-version:\s*\d+\.\d+\.\d+/);
  });

  it("erkennt Legacy-Hooks (E210), entfernt sie erst mit --remove-legacy", () => {
    writeFileSync(settingsPath, JSON.stringify(LEGACY_SETTINGS, null, 2) + "\n");
    const seen = setup();
    expect(seen.stdout).toContain("[E210]");
    expect(seen.stdout).toContain("smriti");
    expect(readFileSync(settingsPath, "utf8")).toContain("smriti"); // ohne Flag bleibt er

    const removed = setup(["--remove-legacy"]);
    expect(removed.stdout).toMatch(/Legacy-Hooks entfernt: 2/);
    const after = readFileSync(settingsPath, "utf8");
    expect(after).not.toContain("smriti");
    expect(after).not.toContain("cola2-hook");
    expect(after).toContain("legit"); // Fremd-Hook unangetastet
  });

  it("ist idempotent: zweiter Lauf schreibt keine settings.json-Änderung", () => {
    setup();
    const after1 = readFileSync(settingsPath, "utf8");
    setup();
    expect(readFileSync(settingsPath, "utf8")).toBe(after1);
  });

  it("harte Stufe schlägt fehl: fehlende SPA -> E501 + Exit 1", () => {
    const res = cli(["setup", "--settings", settingsPath, "--web-root", join(tmp, "does-not-exist")]);
    expect(res.stdout).toContain("[E501]");
    expect(res.status).toBe(1);
  });
});

describe("Blocker bei hartem Fehler (Dedupe)", () => {
  let ts: TempStore;
  afterEach(() => ts.cleanup());

  const hardFail: SetupReport = {
    ok: false,
    hardFailed: true,
    needsAttention: true,
    legacy: [],
    logPath: "",
    stages: [{ id: "frontend", code: "E501", status: "fail", title: "SPA-Build fehlt", fix: "npm run build" }],
  };

  it("legt genau EIN Blocker-Item an (kein Spam bei wiederholtem Fehlstart)", () => {
    ts = makeTempStore("cockpit-setup-blocker-");
    fileSetupBlocker(ts.store, hardFail);
    fileSetupBlocker(ts.store, hardFail);
    const blockers = ts.store.listItems({ type: "blocker" });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.title).toBe("Setup fehlgeschlagen (E501)");
    expect(blockers[0]!.body).toContain("E501");
    expect(blockers[0]!.priority).toBe("high");
  });
});
