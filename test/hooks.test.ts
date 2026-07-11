// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M4-Gate (PRD F3): stdin-Fixture-E2E gegen das GEBAUTE Hook-Bundle
// (dist/hooks/cockpit-hook.cjs) als Kindprozess. Exit-Code IMMER 0.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const BUNDLE = join(process.cwd(), "dist", "hooks", "cockpit-hook.cjs");

let tmp: string;
let home: string;
let dbPath: string;

function runHook(
  stdin: string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, ["--no-warnings", BUNDLE], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, COCKPIT_DB: dbPath, COCKPIT_HOME: home, ...env },
    timeout: 15_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr, ms: performance.now() - t0 };
}

function transcriptLine(uuid: string, type: "user" | "assistant", text: string): string {
  const content = type === "user" ? text : [{ type: "text", text }];
  return JSON.stringify({
    uuid,
    sessionId: "s-live",
    cwd: "C:\\dev\\live",
    timestamp: "2026-06-12T01:00:00Z",
    type,
    message: { role: type, content },
    gitBranch: "master",
  });
}

function openDb(): Store {
  return Store.open(dbPath);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-hooks-"));
  home = join(tmp, "home");
  dbPath = join(tmp, "cockpit.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("hook bundle E2E (Stop)", () => {
  it("captures user+assistant turns from the transcript tail with real uuids", () => {
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(
      transcript,
      [
        transcriptLine("u-1", "user", "Bitte Suche einbauen"),
        transcriptLine("a-1", "assistant", "Erledigt, BM25 läuft. Key war sk-abcdefgh12345678"),
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runHook(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s-live",
        transcript_path: transcript,
        cwd: "C:\\dev\\live",
      }),
    );
    expect(res.status).toBe(0);
    const store = openDb();
    const rows = store.rawDb().prepare("SELECT uuid, role, content FROM turns ORDER BY uuid").all() as Array<{
      uuid: string;
      role: string;
      content: string;
    }>;
    store.close();
    expect(rows.map((r) => r.uuid)).toEqual(["a-1", "u-1"]);
    expect(rows[0]?.content).toContain("[REDACTED:api-key]");
    expect(rows[0]?.content).not.toContain("sk-abcdefgh12345678");
    console.log(`[hooks] Stop-Latenz inkl. Spawn: ${res.ms.toFixed(0)} ms`);
  });

  it("re-running the same Stop produces zero duplicates (ADR-005)", () => {
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(transcript, transcriptLine("u-1", "user", "hallo") + "\n", "utf8");
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s-live",
      transcript_path: transcript,
      cwd: "C:\\dev\\live",
    });
    expect(runHook(payload).status).toBe(0);
    expect(runHook(payload).status).toBe(0);
    const store = openDb();
    expect(store.countTurns()).toBe(1);
    store.close();
  });

  it("CRLF transcript and CRLF-wrapped payload work", () => {
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(transcript, transcriptLine("u-1", "user", "windows zeilen") + "\r\n", "utf8");
    const payload =
      "\r\n" +
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s-live",
        transcript_path: transcript,
        cwd: "C:\\dev\\live",
      }) +
      "\r\n";
    expect(runHook(payload).status).toBe(0);
    const store = openDb();
    const row = store.rawDb().prepare("SELECT content FROM turns").get() as { content: string };
    store.close();
    expect(row.content).toBe("windows zeilen");
  });

  it("missing transcript_path exits 0 without writing", () => {
    const res = runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "s-live" }));
    expect(res.status).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("nonexistent transcript file exits 0 without writing", () => {
    const res = runHook(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s",
        transcript_path: join(tmp, "fehlt.jsonl"),
      }),
    );
    expect(res.status).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("hook bundle E2E (UserPromptSubmit)", () => {
  it("records a redacted hook_prompt event, no turn (D4)", () => {
    const res = runHook(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "s-live",
        cwd: "C:\\dev\\live",
        prompt: "Nutze den Key ghp_abcdefghij1234567890 dafür",
      }),
    );
    expect(res.status).toBe(0);
    const store = openDb();
    expect(store.countTurns()).toBe(0);
    const ev = store
      .rawDb()
      .prepare("SELECT payload_json FROM events WHERE event_type='hook_prompt'")
      .get() as { payload_json: string };
    store.close();
    expect(ev.payload_json).toContain("[REDACTED:github-token]");
    expect(ev.payload_json).not.toContain("ghp_abcdefghij1234567890");
    console.log(`[hooks] UserPromptSubmit-Latenz inkl. Spawn: ${res.ms.toFixed(0)} ms`);
  });

  it("empty prompt exits 0 and writes nothing", () => {
    const res = runHook(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "   " }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("injiziert eine menschliche Antwort on-the-fly und quittiert sie (Paket 1)", () => {
    const store = openDb();
    const item = store.addItem({ type: "question", title: "Welche Farbe?", projectPath: "C:\\dev\\live" });
    store.answerItem(item.id, "Blau");
    // Claude-beantwortetes Item darf NICHT on-the-fly zugestellt werden.
    const other = store.addItem({ type: "question", title: "Egal?", projectPath: "C:\\dev\\live" });
    store.answerItem(other.id, "vom Agenten", "claude");
    store.close();

    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-live",
      cwd: "C:\\dev\\live",
      prompt: "mach weiter",
    });
    const first = runHook(payload);
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("Blau");
    expect(out.hookSpecificOutput.additionalContext).toContain("<cockpit-inbox-untrusted>");
    // Claude-Antwort bleibt draußen (nur answered_by='human').
    expect(out.hookSpecificOutput.additionalContext).not.toContain("vom Agenten");
    console.log(`[hooks] On-the-fly UserPromptSubmit-Latenz inkl. Spawn: ${first.ms.toFixed(0)} ms`);

    // Zweiter Prompt: quittiert (delivered_at) → keine erneute Injektion.
    const second = runHook(payload);
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe("");

    const store2 = openDb();
    const row = store2.rawDb().prepare("SELECT delivered_at FROM items WHERE uuid = ?").get(item.id) as {
      delivered_at: string | null;
    };
    store2.close();
    expect(row.delivered_at).toBeTruthy();
  });
});

describe("hook bundle E2E (Fehlerpfade)", () => {
  it("broken JSON on stdin: exit 0, diagnose in hooks.log", () => {
    const res = runHook("{ kein json");
    expect(res.status).toBe(0);
    const log = readFileSync(join(home, "hooks.log"), "utf8");
    expect(log).toContain("broken stdin payload");
  });

  it("empty stdin exits 0", () => {
    expect(runHook("").status).toBe(0);
  });

  it("DB-Opt-out (Paket 5): capture aus → Stop schreibt keine Turns", () => {
    const seed = openDb(); // legt DB an + migriert
    seed.setCapture("C:\\dev\\live", false);
    seed.close();
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(transcript, transcriptLine("u-1", "user", "geheim") + "\n", "utf8");
    const res = runHook(
      JSON.stringify({ hook_event_name: "Stop", session_id: "s-live", transcript_path: transcript, cwd: "C:\\dev\\live" }),
    );
    expect(res.status).toBe(0);
    const store = openDb();
    expect(store.countTurns()).toBe(0); // Aufzeichnung aus → nichts geschrieben
    store.close();
  });

  it(".cola/no-capture opt-out: nothing is written", () => {
    const project = join(tmp, "proj");
    mkdirSync(join(project, ".cola"), { recursive: true });
    writeFileSync(join(project, ".cola", "no-capture"), "", "utf8");
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(transcript, transcriptLine("u-1", "user", "geheim") + "\n", "utf8");
    const res = runHook(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s",
        transcript_path: transcript,
        cwd: project,
      }),
    );
    expect(res.status).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("db failure: exit 0 + dead-letter.jsonl", () => {
    // Eltern-"Verzeichnis" der DB ist eine Datei → open schlägt sicher fehl.
    const blocker = join(tmp, "blockiert");
    writeFileSync(blocker, "datei statt verzeichnis", "utf8");
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(transcript, transcriptLine("u-1", "user", "hallo") + "\n", "utf8");
    const res = runHook(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s-live",
        transcript_path: transcript,
        cwd: "C:\\dev\\live",
      }),
      { COCKPIT_DB: join(blocker, "sub", "cockpit.db") },
    );
    expect(res.status).toBe(0);
    const dead = readFileSync(join(home, "dead-letter.jsonl"), "utf8");
    expect(dead).toContain('"event":"Stop"');
    const log = readFileSync(join(home, "hooks.log"), "utf8");
    expect(log.length).toBeGreaterThan(0);
  });
});
