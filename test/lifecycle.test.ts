// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M4-Gate (PRD F8): init/doctor/uninstall/purge als Kindprozess gegen die
// GEBAUTE CLI und Temp-settings.json. Niemals gegen ~/.claude (D5: --settings
// deaktiviert jede MCP-Registrierung automatisch).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const CLI = join(process.cwd(), "dist", "cli.js");

let tmp: string;
let home: string;
let dbPath: string;
let settingsPath: string;

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, COCKPIT_DB: dbPath, COCKPIT_HOME: home },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-lifecycle-"));
  home = join(tmp, "home");
  dbPath = join(tmp, "cockpit.db");
  settingsPath = join(tmp, "settings.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const FOREIGN_SETTINGS =
  JSON.stringify(
    {
      model: "opus",
      hooks: {
        Stop: [{ matcher: ".*", hooks: [{ type: "command", command: 'node "C:/fremd/hook.cjs"' }] }],
      },
    },
    null,
    2,
  ) + "\n";

describe("cockpit init / uninstall (Temp-settings)", () => {
  it("init copies the bundle, patches settings with diff+backup, keeps foreign hooks", () => {
    writeFileSync(settingsPath, FOREIGN_SETTINGS, "utf8");
    const res = cli(["init", "--settings", settingsPath, "--no-mcp", "--yes"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Hook-Bundle installiert");
    expect(res.stdout).toContain("Geplante Änderung");
    expect(res.stdout).toContain("cockpit backfill --dry-run");
    expect(existsSync(join(home, "bin", "cockpit-hook.cjs"))).toBe(true);
    expect(readFileSync(`${settingsPath}.cockpit-backup`, "utf8")).toBe(FOREIGN_SETTINGS);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("fremd");
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(
      /^node --no-warnings ".*cockpit-hook\.cjs"$/,
    );
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.model).toBe("opus");
  });

  it("init is idempotent; uninstall restores the original bytes", () => {
    writeFileSync(settingsPath, FOREIGN_SETTINGS, "utf8");
    expect(cli(["init", "--settings", settingsPath, "--no-mcp", "--yes"]).status).toBe(0);
    const afterFirst = readFileSync(settingsPath, "utf8");
    expect(cli(["init", "--settings", settingsPath, "--no-mcp", "--yes"]).status).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(afterFirst);

    const un = cli(["uninstall", "--settings", settingsPath]);
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("byte-genau");
    expect(un.stdout).toContain("Datenbank bleibt erhalten");
    expect(readFileSync(settingsPath, "utf8")).toBe(FOREIGN_SETTINGS);
  });

  it("init without --yes aborts cleanly on non-TTY", () => {
    writeFileSync(settingsPath, FOREIGN_SETTINGS, "utf8");
    const res = cli(["init", "--settings", settingsPath, "--no-mcp"]);
    expect(res.status).toBe(1);
    expect(readFileSync(settingsPath, "utf8")).toBe(FOREIGN_SETTINGS);
  });

  it("init on a machine without settings.json creates one (no backup)", () => {
    const res = cli(["init", "--settings", settingsPath, "--no-mcp", "--yes"]);
    expect(res.status).toBe(0);
    expect(existsSync(`${settingsPath}.cockpit-backup`)).toBe(false);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
  });
});

describe("cockpit doctor", () => {
  it("after init everything is OK (exit 0)", () => {
    cli(["init", "--settings", settingsPath, "--no-mcp", "--yes"]);
    const res = cli(["doctor", "--settings", settingsPath]);
    expect(res.status).toBe(0);
    // 6 Checks im Fixture-Modus (Node, FTS5, DB, Bundle, Hooks registriert,
    // disableAllHooks); die spawn-Checks (claude-Binary, MCP) laufen nur ohne
    // settings-Override — gleiche D5-Disziplin wie init.
    expect(res.stdout.match(/^OK /gm)).toHaveLength(6);
  });

  it("without init it names the missing pieces with fix commands (exit 1)", () => {
    const res = cli(["doctor", "--settings", settingsPath]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("FEHLT");
    expect(res.stdout).toContain("cockpit init");
  });
});

describe("cockpit purge", () => {
  it("refuses without --yes, deletes with --yes", () => {
    const store = Store.open(dbPath);
    store.insertTurn({
      uuid: "t-1",
      sessionId: "s",
      projectPath: "c:/dev/x",
      role: "user",
      content: "weg damit",
      timestamp: "2026-06-01T00:00:00Z",
    });
    store.addItem({ type: "fyi", title: "bleibt nicht" });
    store.close();

    expect(cli(["purge"]).status).toBe(1);
    const res = cli(["purge", "--yes"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("1 Turns, 1 Items");

    const check = Store.open(dbPath);
    expect(check.countTurns()).toBe(0);
    expect(check.searchTurns("weg")).toEqual([]);
    check.close();
  });

  it("purge --project deletes only that project", () => {
    const store = Store.open(dbPath);
    for (const [uuid, project] of [["t-1", "c:/dev/a"], ["t-2", "c:/dev/b"]] as const) {
      store.insertTurn({
        uuid,
        sessionId: "s",
        projectPath: project,
        role: "user",
        content: `inhalt ${project}`,
        timestamp: "2026-06-01T00:00:00Z",
      });
    }
    store.close();
    const res = cli(["purge", "--yes", "--project", "C:\\dev\\a"]);
    expect(res.status).toBe(0);
    const check = Store.open(dbPath);
    expect(check.countTurns()).toBe(1);
    check.close();
  });
});

// Regression: add-json mit JSON-Argument wurde von der Windows-Shell zerlegt
// ("Invalid input", live 2026-07-07). Die Registrierung muss die Args-Form nutzen.
describe("mcp registration command", () => {
  it("uses claude mcp add with plain args, never add-json", async () => {
    const { mcpRegisterArgs, mcpRegisterCommand } = await import("../src/lifecycle.js");
    const args = mcpRegisterArgs();
    expect(args[0]).toBe("mcp");
    expect(args[1]).toBe("add");
    expect(args).not.toContain("add-json");
    expect(args).toContain("--");
    expect(args).toContain("node");
    expect(args[args.length - 1]).toMatch(/mcp\.js$/);
    expect(args[args.length - 1]).not.toContain("\\");
    expect(mcpRegisterCommand()).toContain("claude mcp add --scope user cockpit");
  });
});
