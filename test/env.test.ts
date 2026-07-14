// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Env-Tab: die SICHERHEITS-Zusagen scharf testen — Werte verlassen die Platte
// nie Richtung Aufrufer (nur Namen + gesetzt/leer), Schreiben ist write-only mit
// Backup, ungültige Namen/Werte werden abgewiesen. Echtes Dateisystem + echte DB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addEnvToGitignore,
  envView,
  readEnvKeys,
  resolveEnvTarget,
  scanEnvKeys,
  writeEnvVar,
} from "../src/env.js";
import { normalizeProjectPath } from "../src/paths.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let projectDir: string; // ein "bekanntes" Projekt (turns-Zeile) mit echtem Ordner

beforeEach(() => {
  ts = makeTempStore("cockpit-env-");
  projectDir = join(ts.dir, "proj");
  mkdirSync(projectDir, { recursive: true });
  ts.store.insertTurn({
    uuid: "t-1",
    sessionId: "s-1",
    projectPath: projectDir,
    role: "assistant",
    content: "x",
    timestamp: "2026-06-01T10:00:00Z",
  });
});

afterEach(() => ts.cleanup());

describe("readEnvKeys — nur Namen, nie Werte", () => {
  it("liefert key + hasValue, aber keinen Wert im Objekt", () => {
    const env = join(projectDir, ".env");
    writeFileSync(env, "FOO=supersecret\nBAR=\n# Kommentar\nexport BAZ=\"quoted\"\n", "utf8");
    const keys = readEnvKeys(env);
    const byName = Object.fromEntries(keys.map((k) => [k.key, k]));
    expect(Object.keys(byName).sort()).toEqual(["BAR", "BAZ", "FOO"]);
    expect(byName["FOO"]!.hasValue).toBe(true);
    expect(byName["BAR"]!.hasValue).toBe(false);
    expect(byName["BAZ"]!.hasValue).toBe(true);
    // Zusicherung: kein Feld trägt den Wert.
    expect(JSON.stringify(keys)).not.toContain("supersecret");
    expect(keys[0]).not.toHaveProperty("value");
  });

  it("fehlende Datei -> leere Liste", () => {
    expect(readEnvKeys(join(projectDir, "nope.env"))).toEqual([]);
  });
});

describe("writeEnvVar — write-only mit Backup", () => {
  it("legt die .env an und schreibt genau eine Zeile", () => {
    const r = writeEnvVar(ts.store, projectDir, "API_KEY", "abc123");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.backup).toBeNull();
    const content = readFileSync(join(projectDir, ".env"), "utf8");
    expect(content).toContain("API_KEY=abc123");
  });

  it("ersetzt einen bestehenden Schlüssel, erhält andere Zeilen und sichert die Vorversion", () => {
    const env = join(projectDir, ".env");
    writeFileSync(env, "# Header\nAPI_KEY=old\nOTHER=keep\n", "utf8");
    const r = writeEnvVar(ts.store, projectDir, "API_KEY", "new");
    expect(r.ok).toBe(true);
    const content = readFileSync(env, "utf8");
    expect(content).toContain("API_KEY=new");
    expect(content).not.toContain("API_KEY=old");
    expect(content).toContain("OTHER=keep");
    expect(content).toContain("# Header");
    // Backup existiert und trägt den alten Wert (auf der Platte, gitignored).
    const backups = readdirSync(join(projectDir, ".env-backups"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(projectDir, ".env-backups", backups[0]!), "utf8")).toContain("API_KEY=old");
  });

  it("quotet Werte mit Sonderzeichen", () => {
    const r = writeEnvVar(ts.store, projectDir, "URL", "https://a b?x=1");
    expect(r.ok).toBe(true);
    const content = readFileSync(join(projectDir, ".env"), "utf8");
    expect(content).toContain('URL="https://a b?x=1"');
  });

  it("weist ungültige Namen und mehrzeilige Werte ab", () => {
    expect(writeEnvVar(ts.store, projectDir, "1BAD", "x")).toMatchObject({ ok: false, status: 400 });
    expect(writeEnvVar(ts.store, projectDir, "A-B", "x")).toMatchObject({ ok: false, status: 400 });
    expect(writeEnvVar(ts.store, projectDir, "OK", "line1\nline2")).toMatchObject({ ok: false, status: 400 });
  });

  it("weist unbekannte Projekte ab (nur Selektor, nie Rohpfad)", () => {
    expect(writeEnvVar(ts.store, join(ts.dir, "fremd"), "OK", "x")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("resolveEnvTarget", () => {
  it("global -> ~/.claude/.env; bekanntes Projekt -> <root>/.env; unbekannt -> null", () => {
    expect(resolveEnvTarget(ts.store, undefined)).toMatch(/[\\/]\.claude[\\/]\.env$/);
    expect(normalizeProjectPath(resolveEnvTarget(ts.store, projectDir)!)).toBe(normalizeProjectPath(join(projectDir, ".env")));
    expect(resolveEnvTarget(ts.store, join(ts.dir, "fremd"))).toBeNull();
  });
});

describe("addEnvToGitignore — idempotent", () => {
  it("hängt fehlende Zeilen an, aber nie doppelt", () => {
    const first = addEnvToGitignore(projectDir);
    expect(first.added).toEqual([".env", ".env-backups/"]);
    const gi = readFileSync(join(projectDir, ".gitignore"), "utf8");
    expect(gi).toContain(".env");
    expect(gi).toContain(".env-backups/");
    const second = addEnvToGitignore(projectDir);
    expect(second.added).toEqual([]); // nichts doppelt
  });
});

describe("scanEnvKeys — referenzierte Variablen finden", () => {
  it("findet process.env, import.meta.env und .env.example-Namen", () => {
    writeFileSync(join(projectDir, "app.ts"), "const a = process.env.API_KEY; const b = import.meta.env.VITE_URL;", "utf8");
    writeFileSync(join(projectDir, ".env.example"), "STRIPE_SECRET_KEY=\n", "utf8");
    const keys = scanEnvKeys(projectDir);
    expect(keys).toContain("API_KEY");
    expect(keys).toContain("VITE_URL");
    expect(keys).toContain("STRIPE_SECRET_KEY");
  });
});

describe("envView — Ansicht baut ohne Werte", () => {
  it("global + Projekt, Variablen tragen present/hasValue, aber keinen Wert", () => {
    writeFileSync(join(projectDir, ".env"), "SET_KEY=value\nEMPTY_KEY=\n", "utf8");
    const views = envView(ts.store, {});
    const proj = views.find((v) => normalizeProjectPath(v.projectPath) === normalizeProjectPath(projectDir));
    expect(proj).toBeTruthy();
    const byName = Object.fromEntries(proj!.vars.map((v) => [v.key, v]));
    expect(byName["SET_KEY"]!.hasValue).toBe(true);
    expect(byName["EMPTY_KEY"]!.present).toBe(true);
    expect(byName["EMPTY_KEY"]!.hasValue).toBe(false);
    expect(JSON.stringify(views)).not.toContain("value");
    // Auf ein Projekt gefiltert -> kein Global-Eintrag.
    expect(envView(ts.store, { project: projectDir }).some((v) => v.projectPath === "")).toBe(false);
  });
});

describe("Store — Env-Metadaten + Audit (nie Werte)", () => {
  it("upsertEnvSpec/listEnvSpecs round-trip, Historie append-only", () => {
    ts.store.upsertEnvSpec({ project: projectDir, keyName: "API_KEY", why: "Zugriff", how: "Konsole", what: "geheim", serviceLink: "https://x", source: "manual" });
    const specs = ts.store.listEnvSpecs(projectDir);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ keyName: "API_KEY", why: "Zugriff", serviceLink: "https://x" });
    ts.store.recordEnvHistory({ project: projectDir, keyName: "API_KEY", change: "value_set" });
    ts.store.recordEnvHistory({ project: projectDir, keyName: "API_KEY", change: "spec_edited" });
    const hist = ts.store.listEnvHistory(projectDir, "API_KEY");
    expect(hist).toHaveLength(2);
    expect(hist[0]!.change).toBe("spec_edited"); // neueste zuerst
  });
});
