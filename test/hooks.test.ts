// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M4-Gate (PRD F3): stdin-Fixture-E2E gegen das GEBAUTE Hook-Bundle
// (dist/hooks/cockpit-hook.cjs) als Kindprozess. Exit-Code IMMER 0.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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
    // Zustell-Protokoll: genau EIN answer_delivered-Event (via=prompt, session)
    // — die zweite (leere) Injektion beansprucht nichts, schreibt also keins.
    const ev = store2
      .rawDb()
      .prepare("SELECT session_id, payload_json FROM events WHERE event_type='answer_delivered'")
      .all() as Array<{ session_id: string | null; payload_json: string }>;
    store2.close();
    expect(row.delivered_at).toBeTruthy();
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload_json)).toEqual({ itemId: item.id, via: "prompt" });
    expect(ev[0]!.session_id).toBe("s-live");
  });
});

// G4: Auto-Snapshot im Stop-Hook (Git-Modi, mode='auto'). Echtes Temp-Repo;
// die Kern-Zusicherung ist, dass HEAD/Index/Worktree byte-identisch bleiben.
function g(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  g(dir, ["init", "-q", "-b", "master"]);
  g(dir, ["config", "user.email", "t@example.com"]);
  g(dir, ["config", "user.name", "Test"]);
  g(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "init"]);
}

function snapshotRefs(dir: string): string[] {
  return g(dir, ["for-each-ref", "--format=%(refname)", "refs/cockpit/"]).split("\n").filter(Boolean);
}

function stopPayload(repo: string, transcript: string): string {
  return JSON.stringify({ hook_event_name: "Stop", session_id: "s-live", transcript_path: transcript, cwd: repo });
}

function writeStopTranscript(repo: string): string {
  const transcript = join(tmp, "t.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      uuid: "u-1",
      sessionId: "s-live",
      cwd: repo,
      timestamp: "2026-07-12T01:00:00Z",
      type: "user",
      message: { role: "user", content: "arbeite" },
      gitBranch: "master",
    }) + "\n",
    "utf8",
  );
  return transcript;
}

describe("hook bundle E2E (Auto-Snapshot, Git-Modi)", () => {
  it("auto + dirty: Snapshot-Ref entsteht, HEAD/Index/Worktree bleiben byte-identisch", () => {
    const repo = join(tmp, "repo");
    initRepo(repo);
    const seed = openDb();
    seed.setGitMode(repo, "auto");
    seed.close();
    // Ungesicherte Arbeit: neue Datei + geänderte getrackte Datei.
    writeFileSync(join(repo, "b.txt"), "ungesichert\n", "utf8");
    writeFileSync(join(repo, "a.txt"), "hello geaendert\n", "utf8");
    // Index vor dem Lauf stabilisieren (git status schreibt den stat-Cache),
    // dann den Vorher-Zustand byte-genau festhalten.
    const beforeStatus = g(repo, ["status", "--porcelain"]);
    g(repo, ["status", "--porcelain"]);
    const beforeHead = g(repo, ["rev-parse", "HEAD"]);
    const beforeIndex = readFileSync(join(repo, ".git", "index"));

    const res = runHook(stopPayload(repo, writeStopTranscript(repo)));
    expect(res.status).toBe(0);

    const refs = snapshotRefs(repo);
    expect(refs.length).toBe(1);
    // Der Snapshot-Tree enthält die ungesicherte Datei.
    expect(g(repo, ["ls-tree", "-r", "--name-only", refs[0]!])).toContain("b.txt");
    // Kern-Zusicherung: Arbeitszustand unverändert.
    expect(g(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(g(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(readFileSync(join(repo, ".git", "index")).equals(beforeIndex)).toBe(true);
    // git_snapshot-Event mit der sha geschrieben.
    const store = openDb();
    const ev = store.rawDb().prepare("SELECT payload_json FROM events WHERE event_type='git_snapshot'").get() as
      | { payload_json: string }
      | undefined;
    store.close();
    expect(ev?.payload_json).toContain(g(repo, ["rev-parse", refs[0]!]));
    console.log(`[hooks] Auto-Snapshot-Latenz inkl. Spawn: ${res.ms.toFixed(0)} ms`);
  });

  it("advisory und manual: kein Snapshot-Ref", () => {
    for (const mode of ["advisory", "manual"] as const) {
      const repo = join(tmp, `repo-${mode}`);
      initRepo(repo);
      const seed = openDb();
      seed.setGitMode(repo, mode);
      seed.close();
      writeFileSync(join(repo, "b.txt"), "ungesichert\n", "utf8");
      expect(runHook(stopPayload(repo, writeStopTranscript(repo))).status).toBe(0);
      expect(snapshotRefs(repo)).toEqual([]);
    }
  });

  it("auto ohne ungesicherte Arbeit: kein Ref (Dedupe gegen HEAD-Tree)", () => {
    const repo = join(tmp, "repo");
    initRepo(repo);
    const seed = openDb();
    seed.setGitMode(repo, "auto");
    seed.close();
    // Sauberer Worktree == HEAD: zweimal Stop, nie ein Ref.
    expect(runHook(stopPayload(repo, writeStopTranscript(repo))).status).toBe(0);
    expect(runHook(stopPayload(repo, writeStopTranscript(repo))).status).toBe(0);
    expect(snapshotRefs(repo)).toEqual([]);
  });

  it("Prune: mehr als 20 Refs werden auf 20 gestutzt", () => {
    const repo = join(tmp, "repo");
    initRepo(repo);
    const seed = openDb();
    seed.setGitMode(repo, "auto");
    seed.close();
    // 21 künstliche (ältere) Snapshot-Refs auf HEAD.
    const head = g(repo, ["rev-parse", "HEAD"]);
    for (let i = 0; i <= 20; i++) {
      g(repo, ["update-ref", `refs/cockpit/wip-20250101-${String(i).padStart(4, "0")}`, head]);
    }
    expect(snapshotRefs(repo).length).toBe(21);
    // Ungesicherte Arbeit → der Lauf legt einen 22. (heutigen) Ref an und prunt.
    writeFileSync(join(repo, "b.txt"), "ungesichert\n", "utf8");
    expect(runHook(stopPayload(repo, writeStopTranscript(repo))).status).toBe(0);
    expect(snapshotRefs(repo).length).toBe(20);
  });

  it("kein Repo: auto endet still mit Exit 0, kein Snapshot-Event", () => {
    const dir = join(tmp, "kein-repo");
    mkdirSync(dir, { recursive: true });
    const seed = openDb();
    seed.setGitMode(dir, "auto");
    seed.close();
    const res = runHook(stopPayload(dir, writeStopTranscript(dir)));
    expect(res.status).toBe(0);
    const store = openDb();
    const ev = store.rawDb().prepare("SELECT 1 FROM events WHERE event_type='git_snapshot'").get();
    store.close();
    expect(ev).toBeUndefined();
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
