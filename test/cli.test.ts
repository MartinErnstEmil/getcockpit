// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// E2E gegen die GEBAUTE CLI (dist/cli.js) als Kindprozess mit COCKPIT_DB auf
// Temp — kein Mocking von Kindprozessen (Repo-Regel).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

let tmp: string;
let dbPath: string;

function cli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, COCKPIT_DB: dbPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-cli-"));
  dbPath = join(tmp, "cockpit.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("cockpit CLI E2E", () => {
  it("dist/cli.js exists (build ran before tests)", () => {
    expect(existsSync(CLI)).toBe(true);
  });

  it("backfill + search roundtrip over a fixture project dir", () => {
    const projectsDir = join(tmp, "projects");
    mkdirSync(projectsDir);
    writeFileSync(
      join(projectsDir, "s.jsonl"),
      [
        JSON.stringify({
          uuid: "u-1",
          sessionId: "s-1",
          cwd: "C:\\dev\\demo",
          timestamp: "2026-05-01T10:00:00Z",
          type: "user",
          message: { role: "user", content: "Wir entscheiden uns für Postgres Replikation" },
        }),
        "{ kaputt",
      ].join("\n"),
      "utf8",
    );
    const out = cli(["backfill", "--projects-dir", projectsDir]);
    expect(out).toContain("1 Dateien importiert");
    expect(out).toContain("1 Turns");
    expect(out).toContain("1 kaputte Zeilen geskippt");

    const search = cli(["search", "Replikation", "Postgres"]);
    expect(search).toContain("c:/dev/demo");
    expect(search).toContain("user");

    const none = cli(["search", "existiertnichtxyz"]);
    expect(none).toContain("Keine Treffer.");
  });

  it("add → inbox → answer → done roundtrip", () => {
    const out = cli(["add", "Welcher Paketname?", "--type", "question", "--priority", "high"]);
    const id = /Angelegt: (i-\w+)/.exec(out)?.[1];
    expect(id).toBeTruthy();

    expect(cli(["inbox"])).toContain("Welcher Paketname?");
    expect(cli(["answer", id!, "cockpit", "bleibt"])).toContain("Beantwortet:");
    expect(cli(["inbox", "--status", "answered"])).toContain("↳ cockpit bleibt");
    expect(cli(["done", id!])).toContain("Erledigt:");
    expect(cli(["inbox"])).toContain("Inbox leer.");
  });

  it("search --items finds items via FTS", () => {
    cli(["add", "Tokenizer Entscheidung dokumentieren", "--type", "decision"]);
    const out = cli(["search", "--items", "Tokenizer"]);
    expect(out).toContain("Tokenizer Entscheidung dokumentieren");
  });

  it("unknown item id exits non-zero", () => {
    expect(() => cli(["done", "i-gibtsnicht"])).toThrow();
  });

  it("stats reports turns, items and event counts", () => {
    cli(["add", "Statistik-Item", "--type", "question"]);
    cli(["search", "irgendwas"]);
    const out = cli(["stats"]);
    expect(out).toContain("Turns:     0");
    expect(out).toContain("Items:     1");
    expect(out).toMatch(/search: 1/);
    expect(out).toContain("Antwortquote: 0 %");
  });
});
