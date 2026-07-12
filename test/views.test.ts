// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// F10-Gate: Portfolio-View (Reihenfolge, Blocker, Stale, Erststart),
// Jetzt-dran-Ableitung, git_state-Cache und gitinfo gegen ein Temp-Repo.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitState } from "../src/gitinfo.js";
import { SQL_UPSERT_GIT_STATE, gitStateParams } from "../src/schema.js";
import { decisionsView, portfolioView } from "../src/views.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
const NOW = Date.parse("2026-07-07T12:00:00.000Z");

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function addTurn(uuid: string, project: string, msAgo: number, session = "s-" + project): void {
  ts.store.insertTurn({
    uuid,
    sessionId: session,
    projectPath: project,
    role: "user",
    content: "inhalt " + uuid,
    timestamp: iso(msAgo),
  });
}

beforeEach(() => {
  ts = makeTempStore("cockpit-views-");
});

afterEach(() => {
  ts.cleanup();
});

const MIN = 60_000;
const DAY = 24 * 60 * 60 * 1000;

describe("portfolioView (PRD F10)", () => {
  it("orders projects by last activity, flags active/stale/blockers", () => {
    addTurn("u-a1", "c:/dev/aktiv", 2 * MIN);
    addTurn("u-b1", "c:/dev/mittel", 3 * DAY);
    addTurn("u-c1", "c:/dev/alt", 40 * DAY);
    ts.store.addItem({ type: "blocker", title: "Migration blockiert", projectPath: "c:/dev/mittel" });

    const v = portfolioView(ts.store, { now: NOW });
    // Echte Projekte in Aktivitätsreihenfolge; die synthetische Global-Zeile
    // (Auflage P1) hängt separat hinten dran (global:true).
    const real = v.projects.filter((p) => !p.global);
    expect(real.map((p) => p.projectPath)).toEqual(["c:/dev/aktiv", "c:/dev/mittel", "c:/dev/alt"]);
    expect(v.projects.some((p) => p.global && p.projectPath === "")).toBe(true);
    expect(v.projects[0]!.activeSession).toBe(true);
    expect(v.projects[0]!.stale).toBe(false);
    expect(v.projects[1]!.blockers).toBe(1);
    expect(v.projects[1]!.waitingOnHuman).toBe(1);
    expect(v.projects[2]!.stale).toBe(true);
    expect(v.firstRun).toBeNull();
  });

  it("derives next actions: blockers first, then urgent, then newest questions (U1), capped at 5", () => {
    addTurn("u-1", "c:/dev/p", 5 * MIN);
    const setCreated = ts.store.rawDb().prepare("UPDATE items SET created_at = ? WHERE uuid = ?");
    const alt = ts.store.addItem({ type: "question", title: "Alte Frage", projectPath: "c:/dev/p" });
    setCreated.run(iso(10 * DAY), alt.id);
    const mittel = ts.store.addItem({ type: "question", title: "Mittlere Frage", projectPath: "c:/dev/p" });
    setCreated.run(iso(2 * DAY), mittel.id);
    const neu = ts.store.addItem({ type: "question", title: "Neue Frage", projectPath: "c:/dev/p" });
    setCreated.run(iso(5 * MIN), neu.id);
    ts.store.addItem({ type: "question", title: "Dringende Frage", priority: "urgent", projectPath: "c:/dev/p" });
    ts.store.addItem({ type: "blocker", title: "Der Blocker", projectPath: "c:/dev/p" });

    const v = portfolioView(ts.store, { now: NOW });
    expect(v.nextActions.length).toBe(5);
    expect(v.nextActions[0]!.kind).toBe("blocker");
    expect(v.nextActions[0]!.title).toBe("Der Blocker");
    expect(v.nextActions[1]!.kind).toBe("urgent");
    // Nach den Prioritäts-Stufen das NEUESTE zuerst (created_at DESC, U1):
    // die älteste Frage steht ganz hinten, statt die Liste zu fluten.
    expect(v.nextActions[2]!.title).toBe("Neue Frage");
    expect(v.nextActions[3]!.title).toBe("Mittlere Frage");
    expect(v.nextActions[4]!.title).toBe("Alte Frage");
  });

  it("summarises today (sessions, decisions, new items) and older-open backlog (U1)", () => {
    const setCreated = ts.store.rawDb().prepare("UPDATE items SET created_at = ? WHERE uuid = ?");
    addTurn("u-heute", "c:/dev/p", 5 * MIN, "s-heute");
    addTurn("u-alt", "c:/dev/p", 40 * DAY, "s-alt");
    const heute = ts.store.addItem({ type: "decision", title: "Heute entschieden", projectPath: "c:/dev/p" });
    setCreated.run(iso(5 * MIN), heute.id);
    const altOffen = ts.store.addItem({ type: "question", title: "Alt offen", projectPath: "c:/dev/p" });
    setCreated.run(iso(10 * DAY), altOffen.id);

    const v = portfolioView(ts.store, { now: NOW });
    expect(v.today.sessions).toBe(1);
    expect(v.today.decisions).toBe(1);
    expect(v.today.newItems).toBe(1);
    // "Alt offen" ist > 7 Tage alt und offen -> zählt als verdeckte Alt-Last.
    expect(v.olderOpen).toBe(1);
  });

  it("reports firstRun state when turns exist but no open items (Erststart)", () => {
    addTurn("u-1", "c:/dev/p", 60 * MIN);
    addTurn("u-2", "c:/dev/q", 90 * MIN);
    const v = portfolioView(ts.store, { now: NOW });
    expect(v.nextActions).toEqual([]);
    expect(v.firstRun).toEqual({ turns: 2, projects: 2 });
  });

  it("latest decisions include decision items and human-answered questions, max 3", () => {
    addTurn("u-1", "c:/dev/p", 5 * MIN);
    const setCreated = ts.store.rawDb().prepare("UPDATE items SET created_at = ? WHERE uuid = ?");
    for (let i = 0; i < 4; i++) {
      const d = ts.store.addItem({ type: "decision", title: `Entscheidung ${i}`, projectPath: "c:/dev/p", status: "done" });
      setCreated.run(iso((i + 2) * DAY), d.id); // deterministisch: älter als die Frage
    }
    const q = ts.store.addItem({ type: "question", title: "Beantwortete Frage", projectPath: "c:/dev/p" });
    setCreated.run(iso(1 * DAY), q.id);
    ts.store.answerItem(q.id, "So machen wir es", "human");
    const v = portfolioView(ts.store, { now: NOW });
    expect(v.projects[0]!.latestDecisions.length).toBe(3);
    expect(v.projects[0]!.latestDecisions[0]!.title).toBe("Beantwortete Frage");
  });

  it("joins git_state cache into the project card", () => {
    addTurn("u-1", "c:/dev/p", 5 * MIN);
    ts.store.rawDb()
      .prepare(SQL_UPSERT_GIT_STATE)
      .run(
        ...gitStateParams({
          projectPath: "c:/dev/p",
          headSha: "abc1234def",
          branch: "master",
          dirtyFiles: 2,
          lastCommitAt: iso(60 * MIN),
          recentCommits: [{ sha: "abc1234def", at: iso(60 * MIN), subject: "feat: x" }],
        }),
      );
    const v = portfolioView(ts.store, { now: NOW });
    expect(v.projects[0]!.git?.branch).toBe("master");
    expect(v.projects[0]!.git?.dirtyFiles).toBe(2);
    expect(v.projects[0]!.git?.recentCommits[0]!.subject).toBe("feat: x");
  });

  it("project filter narrows projects and next actions", () => {
    addTurn("u-1", "c:/dev/p", 5 * MIN);
    addTurn("u-2", "c:/dev/q", 5 * MIN);
    ts.store.addItem({ type: "question", title: "Nur in q", projectPath: "c:/dev/q" });
    const v = portfolioView(ts.store, { project: "C:\\dev\\p", now: NOW });
    // Einzelauswahl grenzt echte Projekte ein; die Global-Zeile bleibt in JEDER
    // Auswahl (Auflage P1), daher separat gefiltert.
    expect(v.projects.filter((p) => !p.global).map((p) => p.projectPath)).toEqual(["c:/dev/p"]);
    expect(v.projects.some((p) => p.global)).toBe(true);
    expect(v.nextActions).toEqual([]);
  });
});

describe("collectGitState (gitinfo)", () => {
  it("returns null outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-nogit-"));
    try {
      expect(collectGitState(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects sha, branch, dirty count and recent commits from a real repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-git-"));
    const run = (args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      run(["init", "-q"]);
      run(["config", "user.email", "t@example.com"]);
      run(["config", "user.name", "t"]);
      writeFileSync(join(dir, "a.txt"), "eins", "utf8");
      run(["add", "."]);
      run(["commit", "-q", "-m", "erster commit"]);
      writeFileSync(join(dir, "b.txt"), "zwei", "utf8"); // dirty (untracked)

      const g = collectGitState(dir);
      expect(g).not.toBeNull();
      expect(g!.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(g!.branch).toBeTruthy();
      expect(g!.dirtyFiles).toBe(1);
      expect(g!.recentCommits[0]!.subject).toBe("erster commit");
      expect(g!.lastCommitAt).toBe(g!.recentCommits[0]!.at);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decisionsView (PRD F12)", () => {
  it("shows only the active head of a supersede chain by default, full chain with all", () => {
    const setCreated = ts.store.rawDb().prepare("UPDATE items SET created_at = ? WHERE uuid = ?");
    const a = ts.store.addItem({ type: "decision", title: "A: Postgres", projectPath: "c:/dev/p",
      anchor: { file: "src/db.ts", line: 10 }, gitSha: "aaaa111bbbb222cccc33", gitBranch: "master" });
    setCreated.run(iso(3 * DAY), a.id);
    const b = ts.store.addItem({ type: "decision", title: "B: SQLite statt Postgres", projectPath: "c:/dev/p", parentId: a.id });
    setCreated.run(iso(2 * DAY), b.id);
    const c = ts.store.addItem({ type: "decision", title: "C: SQLite + FTS5", projectPath: "c:/dev/p", parentId: b.id });
    setCreated.run(iso(1 * DAY), c.id);
    const q = ts.store.addItem({ type: "question", title: "Cache-Frage", projectPath: "c:/dev/p" });
    ts.store.answerItem(q.id, "Kein Cache in V1", "human");

    const active = decisionsView(ts.store);
    expect(active.map((e) => e.title).sort()).toEqual(["C: SQLite + FTS5", "Cache-Frage"]);

    const all = decisionsView(ts.store, { all: true });
    expect(all.length).toBe(4);
    const byTitle = new Map(all.map((e) => [e.title, e]));
    expect(byTitle.get("A: Postgres")!.supersededById).toBe(b.id);
    expect(byTitle.get("B: SQLite statt Postgres")!.replacesId).toBe(a.id);
    expect(byTitle.get("B: SQLite statt Postgres")!.supersededById).toBe(c.id);
    expect(byTitle.get("C: SQLite + FTS5")!.supersededById).toBeNull();
    expect(byTitle.get("A: Postgres")!.anchorFile).toBe("src/db.ts");
    expect(byTitle.get("A: Postgres")!.anchorLine).toBe(10);
    expect(byTitle.get("A: Postgres")!.gitSha).toBe("aaaa111bbbb222cccc33");
  });

  it("unanswered questions never appear; rejected decisions only with all", () => {
    ts.store.addItem({ type: "question", title: "Offen", projectPath: "c:/dev/p" });
    const r = ts.store.addItem({ type: "decision", title: "Verworfen", projectPath: "c:/dev/p", status: "rejected" });
    expect(decisionsView(ts.store).map((e) => e.title)).not.toContain("Offen");
    expect(decisionsView(ts.store).map((e) => e.title)).not.toContain("Verworfen");
    expect(decisionsView(ts.store, { all: true }).map((e) => e.title)).toContain("Verworfen");
    void r;
  });

  it("shows drafts by default and hides archived until all=1 (U2)", () => {
    // Entwurf: gespeicherte, aber nicht zugestellte Antwort (status != answered).
    const draft = ts.store.addItem({ type: "question", title: "Entwurf-Frage", projectPath: "c:/dev/p" });
    ts.store.saveDraft(draft.id, "vorläufige Antwort");
    const arch = ts.store.addItem({ type: "decision", title: "Archiviert", projectPath: "c:/dev/p" });
    ts.store.setItemArchived(arch.id, true);

    const active = decisionsView(ts.store);
    const draftEntry = active.find((e) => e.title === "Entwurf-Frage");
    expect(draftEntry?.draft).toBe(true);
    expect(active.map((e) => e.title)).not.toContain("Archiviert");
    const all = decisionsView(ts.store, { all: true });
    expect(all.find((e) => e.title === "Archiviert")?.archived).toBe(true);
  });
});

describe("decisionsView Lücke 1 (beantwortete Vorschläge/Blocker sind Entscheidungen)", () => {
  it("answered proposal und blocker erscheinen im Log, offene nicht", () => {
    const prop = ts.store.addItem({ type: "proposal", title: "Vorschlag X", projectPath: "c:/dev/d1" });
    ts.store.answerItem(prop.id, "approved", "human");
    const blk = ts.store.addItem({ type: "blocker", title: "Blocker Y", projectPath: "c:/dev/d1" });
    ts.store.answerItem(blk.id, "so lösen", "human");
    ts.store.addItem({ type: "proposal", title: "Offen Z", projectPath: "c:/dev/d1" }); // unbeantwortet

    const titles = decisionsView(ts.store, { project: "c:/dev/d1" }).map((d) => d.title);
    expect(titles).toContain("Vorschlag X");
    expect(titles).toContain("Blocker Y");
    expect(titles).not.toContain("Offen Z");
  });

  it("done-Items mit Antwort erscheinen als Entscheidung, nicht als Entwurf (PO 12.07.)", () => {
    // Muster des Stale-Aufräumens: Item wird mit Begründung direkt auf done geschlossen.
    const closed = ts.store.addItem({ type: "proposal", title: "Erledigt mit Antwort", projectPath: "c:/dev/d1" });
    ts.store.updateItem(closed.id, { answer: "so umgesetzt", status: "done" });

    const entry = decisionsView(ts.store, { project: "c:/dev/d1" }).find(
      (d) => d.title === "Erledigt mit Antwort",
    );
    expect(entry).toBeDefined();
    expect(entry!.draft).toBe(false);
  });
});
