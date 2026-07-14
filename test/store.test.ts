// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M1-Gate: Store-Integration gegen echte Datei-DB in %TEMP% (keine Mocks).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { MIGRATIONS } from "../src/schema.js";
import { Store } from "../src/store.js";
import { decisionsView, portfolioView } from "../src/views.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let store: Store;

beforeEach(() => {
  ts = makeTempStore("cockpit-store-");
  store = ts.store;
});

afterEach(() => {
  ts.cleanup();
});

describe("pragmas & migrations", () => {
  it("opens with WAL, busy_timeout=5000 and current user_version", () => {
    const db = store.rawDb();
    expect(String(db.pragma("journal_mode", { simple: true }))).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });

  it("reopening an existing db does not re-run migrations", () => {
    store.close();
    store = Store.open(join(ts.dir, "cockpit.db"));
    ts.store = store;
    expect(store.rawDb().pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });
});

describe("turns: insert, dedupe, redaction", () => {
  const turn = {
    uuid: "t-001",
    sessionId: "s1",
    projectPath: "C:\\Users\\foo\\proj",
    role: "user",
    content: "hello world",
    timestamp: "2026-06-01T10:00:00Z",
  };

  it("inserts a turn with normalized project path", () => {
    expect(store.insertTurn(turn)).toEqual({ inserted: true, redactions: 0 });
    const row = store.rawDb().prepare("SELECT * FROM turns").get() as Record<string, unknown>;
    expect(row.project_path).toBe("c:/Users/foo/proj");
    expect(row.is_sidechain).toBe(0);
  });

  it("same uuid twice = exactly one row (ADR-005 dedupe key)", () => {
    store.insertTurn(turn);
    expect(store.insertTurn({ ...turn, content: "changed" })).toEqual({
      inserted: false,
      redactions: 0,
    });
    expect(store.countTurns()).toBe(1);
  });

  it("redacts secrets before persisting; raw secret never reaches the db", () => {
    const res = store.insertTurn({
      ...turn,
      uuid: "t-002",
      content: "my key is sk-abcdefgh12345678 ok",
    });
    expect(res).toEqual({ inserted: true, redactions: 1 });
    const row = store.rawDb().prepare("SELECT content FROM turns WHERE uuid='t-002'").get() as {
      content: string;
    };
    expect(row.content).toContain("[REDACTED:api-key]");
    expect(row.content).not.toContain("sk-abcdefgh12345678");
  });
});

describe("items CRUD (PRD F5)", () => {
  it("addItem assigns id, defaults, timestamps", () => {
    const item = store.addItem({ type: "question", title: "Wie heißt das Paket?" });
    expect(item.id).toMatch(/^i-/);
    expect(item.status).toBe("new");
    expect(item.priority).toBe("medium");
    expect(item.tags).toEqual([]);
    expect(item.createdAt).toBe(item.updatedAt);
  });

  it("persists anchor, tags, parentId, git context round-trip", () => {
    const parent = store.addItem({ type: "decision", title: "Eltern-Item" });
    const item = store.addItem({
      type: "proposal",
      title: "Anker-Test",
      body: "Details",
      anchor: { file: "src/db.ts", line: 10, endLine: 12 },
      tags: ["m1", "store"],
      parentId: parent.id,
      projectPath: "C:\\dev\\x",
      gitSha: "abc123",
      gitBranch: "master",
      sessionId: "s9",
    });
    const got = store.getItem(item.id);
    expect(got?.anchor).toEqual({ file: "src/db.ts", line: 10, endLine: 12 });
    expect(got?.tags).toEqual(["m1", "store"]);
    expect(got?.parentId).toBe(parent.id);
    expect(got?.projectPath).toBe("c:/dev/x");
    expect(got?.gitSha).toBe("abc123");
    expect(got?.sessionId).toBe("s9");
  });

  it("getItem resolves a unique uuid prefix, rejects ambiguous ones", () => {
    const item = store.addItem({ type: "fyi", title: "Präfix" });
    store.addItem({ type: "fyi", title: "Zweites Item macht 'i-' mehrdeutig" });
    expect(store.getItem(item.id.slice(0, 6))?.id).toBe(item.id);
    expect(store.getItem("i-")).toBeNull();
  });

  it("answerItem sets answer, status=answered, answered_at", () => {
    const item = store.addItem({ type: "question", title: "Frage?" });
    const answered = store.answerItem(item.id, "Antwort: 42");
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toBe("Antwort: 42");
    expect(answered?.answeredAt).toBeTruthy();
  });

  it("saveDraft sets answer WITHOUT answering (Paket A): status/answered_by/answered_at bleiben", () => {
    const item = store.addItem({ type: "question", title: "Deploy wohin?" });
    const draft = store.saveDraft(item.id, "  Fly.io — Bemerkung: günstig  ");
    expect(draft?.answer).toBe("Fly.io — Bemerkung: günstig"); // getrimmt
    expect(draft?.status).toBe("new"); // NICHT answered
    expect(draft?.answeredBy).toBeUndefined();
    expect(draft?.answeredAt).toBeUndefined();
    // U2: Der Entwurf erscheint im Log, aber als Entwurf markiert (draft=true)
    // — eine gespeicherte, noch nicht zugestellte Antwort, keine Entscheidung.
    const draftEntry = decisionsView(store, {}).find((d) => d.id === item.id);
    expect(draftEntry?.draft).toBe(true);
    // Danach zustellen macht es answered — jetzt eine echte Entscheidung.
    const delivered = store.answerItem(item.id, draft!.answer!);
    expect(delivered?.status).toBe("answered");
    expect(delivered?.answeredBy).toBe("human");
    expect(delivered?.answeredAt).toBeTruthy();
    expect(decisionsView(store, {}).find((d) => d.id === item.id)?.draft).toBe(false);
    expect(store.saveDraft("i-existiertnicht", "x")).toBeNull();
    expect(() => store.saveDraft(item.id, "   ")).toThrow(/Entwurf/);
  });

  it("listSessionMarkers webt Items und Commits ins Session-Zeitfenster (Verlauf B)", () => {
    // Weites Zeitfenster, damit die 'now'-created_at der Items hineinfallen.
    store.insertTurn({ uuid: "t-a", sessionId: "s-v", projectPath: "c:/dev/v", role: "user", content: "start", timestamp: "2000-01-01T00:00:00Z" });
    store.insertTurn({ uuid: "t-b", sessionId: "s-v", projectPath: "c:/dev/v", role: "assistant", content: "ok", timestamp: "2100-01-01T00:00:00Z" });
    store.addItem({ type: "decision", title: "Port 7878", projectPath: "c:/dev/v" });
    store.addItem({ type: "question", title: "Welche DB?", projectPath: "c:/dev/v" });
    store.addItem({ type: "fyi", title: "nur Info", projectPath: "c:/dev/v" }); // kein Marker
    store.addItem({ type: "decision", title: "Fremdprojekt", projectPath: "c:/dev/other" }); // anderes Projekt
    store
      .rawDb()
      .prepare("INSERT INTO git_state (project_path, branch, recent_commits, updated_at) VALUES (?,?,?,?)")
      .run("c:/dev/v", "main", JSON.stringify([{ sha: "abc1234def", at: "2026-06-01T00:00:00Z", subject: "feat: x" }]), "2026-06-01T00:00:00Z");

    const markers = store.listSessionMarkers("s-v");
    const kinds = markers.map((m) => `${m.kind}:${m.title}`);
    expect(kinds).toContain("decision:Port 7878");
    expect(kinds).toContain("item:Welche DB?");
    expect(kinds).toContain("commit:feat: x");
    expect(kinds).not.toContain("decision:Fremdprojekt"); // anderes Projekt
    expect(markers.some((m) => m.title === "nur Info")).toBe(false); // fyi ist kein Marker
    const commit = markers.find((m) => m.kind === "commit");
    expect(commit?.branch).toBe("main");
    expect(store.listSessionMarkers("s-unbekannt")).toEqual([]);
  });

  it("Projekt-Verwaltung: Capture/Archiv/Löschen + Archiv-Filter in portfolioView (Paket 5)", () => {
    store.insertTurn({ uuid: "t-k", sessionId: "s", projectPath: "c:/dev/keep", role: "user", content: "x", timestamp: "2026-06-01T10:00:00Z" });
    store.insertTurn({ uuid: "t-a", sessionId: "s2", projectPath: "c:/dev/arch", role: "user", content: "y", timestamp: "2026-06-01T10:00:00Z" });
    store.addItem({ type: "question", title: "offen keep", projectPath: "c:/dev/keep" });
    store.addItem({ type: "question", title: "offen arch", projectPath: "c:/dev/arch" });

    // Default: kein Eintrag → capture an, nicht archiviert.
    expect(store.listProjectSettings()).toEqual([]);

    // Archivieren: raus aus portfolioView.projects, in archivedProjects.
    store.setArchived("c:/dev/arch", true);
    const view = portfolioView(store, {});
    const paths = view.projects.map((p) => p.projectPath);
    expect(paths).toContain("c:/dev/keep");
    expect(paths).not.toContain("c:/dev/arch");
    expect(view.archivedProjects).toEqual(["c:/dev/arch"]);

    // Umkehrbar.
    store.setArchived("c:/dev/arch", false);
    expect(portfolioView(store, {}).projects.map((p) => p.projectPath)).toContain("c:/dev/arch");

    // Capture aus + Admin-Liste trägt den Zustand.
    store.setCapture("c:/dev/arch", false);
    const admin = store.projectAdminList();
    expect(admin.find((a) => a.projectPath === "c:/dev/arch")?.captureEnabled).toBe(false);
    expect(admin.find((a) => a.projectPath === "c:/dev/keep")?.openItems).toBe(1);

    // Löschen entfernt Daten UND den project_settings-Eintrag.
    store.purge("c:/dev/arch");
    expect(store.listProjectSettings().some((s) => s.projectPath === "c:/dev/arch")).toBe(false);
    expect(portfolioView(store, {}).projects.map((p) => p.projectPath)).not.toContain("c:/dev/arch");
  });

  it("Git-Modi (Migration v4): Default advisory, Spalten-Default, Roundtrip, Junk wirft", () => {
    // Frische DB: kein Eintrag → Default advisory, ohne dass eine Zeile existiert.
    expect(store.gitMode("c:/dev/gm")).toBe("advisory");

    // Spalten-Default: ein Capture-Upsert legt die Zeile ohne git_mode an →
    // die ALTER-TABLE-DEFAULT-Klausel füllt 'advisory'.
    store.setCapture("c:/dev/gm", true);
    expect(store.listProjectSettings().find((s) => s.projectPath === "c:/dev/gm")?.gitMode).toBe("advisory");

    // Roundtrip: setzen → gitMode + projectAdminList tragen den Modus.
    store.setGitMode("c:/dev/gm", "auto");
    expect(store.gitMode("c:/dev/gm")).toBe("auto");
    expect(store.projectAdminList().find((a) => a.projectPath === "c:/dev/gm")?.gitMode).toBe("auto");

    // Allowlist: Junk-Modus wirft (Store-Schicht, kein CHECK-Constraint).
    expect(() => store.setGitMode("c:/dev/gm", "bogus")).toThrow(/gitMode/);
  });

  it("deliveryInfo: bei Mehrfach-Events gewinnt das älteste (erstes Abholen)", () => {
    const item = store.addItem({ type: "question", title: "Mehrfach?", projectPath: "c:/dev/d" });
    store.answerItem(item.id, "ja", "human");
    // Parallel-Kante: zwei Ack-Events (answer_acked) fürs selbe Item.
    const e1 = store.recordEvent({ eventType: "answer_acked", sessionId: "s-old", payload: { itemId: item.id, via: "prompt" } });
    const e2 = store.recordEvent({ eventType: "answer_acked", sessionId: "s-new", payload: { itemId: item.id, via: "briefing" } });
    const setAt = store.rawDb().prepare("UPDATE events SET created_at = ? WHERE uuid = ?");
    setAt.run("2026-07-12T10:00:00.000Z", e1.id);
    setAt.run("2026-07-12T11:00:00.000Z", e2.id);

    const info = store.deliveryInfo([item.id]).get(item.id);
    expect(info?.via).toBe("prompt");
    expect(info?.sessionId).toBe("s-old");
    expect(info?.at).toBe("2026-07-12T10:00:00.000Z");
    // Leere Eingabe = leere Map (kein IN () SQL-Fehler).
    expect(store.deliveryInfo([]).size).toBe(0);
  });

  it("status done sets done_at; update bumps updated_at", () => {
    const item = store.addItem({ type: "result", title: "Fertig" });
    const done = store.updateItem(item.id, { status: "done" });
    expect(done?.doneAt).toBeTruthy();
    expect(done?.updatedAt >= item.updatedAt).toBe(true);
  });

  it("updateItem on unknown id returns null", () => {
    expect(store.updateItem("i-existiertnicht", { status: "done" })).toBeNull();
  });

  it("rejects invalid enum values for type, status, priority, answeredBy", () => {
    expect(() => store.addItem({ type: "bogus", title: "X" })).toThrow(/type/);
    expect(() => store.addItem({ type: "fyi", title: "X", priority: "egal" })).toThrow(/priority/);
    const item = store.addItem({ type: "fyi", title: "Valide" });
    expect(() => store.updateItem(item.id, { status: "fertig" })).toThrow(/status/);
    expect(() => store.updateItem(item.id, { answeredBy: "bot" })).toThrow(/answeredBy/);
  });

  it("rejects whitespace-only answers; trims padded answers before storing", () => {
    const item = store.addItem({ type: "question", title: "Trim?" });
    expect(() => store.answerItem(item.id, "   ")).toThrow(/answer/);
    expect(store.getItem(item.id)?.status).toBe("new");
    expect(store.answerItem(item.id, "  passt  ")?.answer).toBe("passt");
  });

  it("listItems filters by status, type, tag, project (incl. global items)", () => {
    store.addItem({ type: "question", title: "A", tags: ["x"], projectPath: "c:/p1" });
    store.addItem({ type: "decision", title: "B", projectPath: "c:/p2" });
    store.addItem({ type: "blocker", title: "C global" });
    expect(store.listItems({ type: "question" })).toHaveLength(1);
    expect(store.listItems({ tag: "x" })).toHaveLength(1);
    // Projektfilter liefert projektgebundene UND globale Items.
    expect(store.listItems({ project: "C:\\p1" }).map((i) => i.title).sort()).toEqual([
      "A",
      "C global",
    ]);
    expect(store.listItems({ status: "new" })).toHaveLength(3);
  });

  it("redacts secrets in item title/body/answer", () => {
    const item = store.addItem({
      type: "fyi",
      title: "Token ghp_abcdefghij1234567890",
      body: "key sk-abcdefgh12345678",
    });
    expect(item.title).toContain("[REDACTED:github-token]");
    expect(item.body).toContain("[REDACTED:api-key]");
    const answered = store.answerItem(item.id, "use AKIAIOSFODNN7EXAMPLE");
    expect(answered?.answer).toContain("[REDACTED:aws-key]");
  });
});

describe("events", () => {
  it("records events with unique ids, normalized path, JSON payload", () => {
    const a = store.recordEvent({ eventType: "test", sessionId: "s1" });
    const b = store.recordEvent({
      eventType: "search",
      projectPath: "C:\\Users\\foo\\proj",
      payload: { q: "x" },
    });
    expect(a.id).toMatch(/^e-/);
    expect(a.id).not.toBe(b.id);
    const rows = store
      .rawDb()
      .prepare("SELECT event_type, project_path, payload_json, session_id FROM events ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ event_type: "test", session_id: "s1", payload_json: null });
    expect(rows[1]?.project_path).toBe("c:/Users/foo/proj");
    expect(JSON.parse(String(rows[1]?.payload_json))).toEqual({ q: "x" });
  });

  it("hasEvent answers per (type, session) — briefing dedupe", () => {
    expect(store.hasEvent("briefing", "s1")).toBe(false);
    store.recordEvent({ eventType: "briefing", sessionId: "s1" });
    expect(store.hasEvent("briefing", "s1")).toBe(true);
    expect(store.hasEvent("briefing", "s2")).toBe(false);
  });
});

describe("Entscheidungs-Karten v2 (U2)", () => {
  it("reviseDecision creates a superseding decision; comments append; archive toggles a tag", () => {
    const parent = store.addItem({ type: "decision", title: "Alt", projectPath: "c:/dev/p" });
    const revised = store.reviseDecision(parent.id, "Neu", "besserer Weg");
    expect(revised?.parentId).toBe(parent.id);
    expect(revised?.status).toBe("answered");
    expect(revised?.answer).toBe("besserer Weg");
    expect(revised?.answeredBy).toBe("human");

    store.addDecisionComment(parent.id, "Notiz dazu");
    store.addDecisionComment(parent.id, "und noch eine");
    const comments = store.listDecisionComments(parent.id);
    expect(comments.map((c) => c.text)).toEqual(["Notiz dazu", "und noch eine"]);

    const archived = store.setItemArchived(parent.id, true);
    expect(archived?.tags).toContain("archived");
    const restored = store.setItemArchived(parent.id, false);
    expect(restored?.tags).not.toContain("archived");
  });
});

describe("projectSeq (projektlokale Sequenznummer, berechnet)", () => {
  it("nummeriert je Projekt über die VOLLE Partition, unabhängig von Filter/Limit", () => {
    const a1 = store.addItem({ type: "question", title: "A eins", projectPath: "c:/dev/a" });
    const a2 = store.addItem({ type: "result", title: "A zwei", projectPath: "c:/dev/a" });
    const b1 = store.addItem({ type: "question", title: "B eins", projectPath: "c:/dev/b" });
    const g1 = store.addItem({ type: "fyi", title: "global", projectPath: "" });

    const byId = new Map(store.listItems({}).map((i) => [i.id, i.projectSeq]));
    expect(byId.get(a1.id)).toBe(1);
    expect(byId.get(a2.id)).toBe(2);
    expect(byId.get(b1.id)).toBe(1);
    expect(byId.get(g1.id)).toBe(1); // NULL-Partition = eigene global-Sequenz

    // Die Nummer bleibt stabil, wenn ein früheres Item den Status wechselt
    // und die Liste gefiltert wird (Nummerierung VOR dem WHERE).
    store.updateItem(a1.id, { status: "done" });
    const openOnly = new Map(
      store.listItems({ status: "new,in_progress" }).map((i) => [i.id, i.projectSeq]),
    );
    expect(openOnly.get(a2.id)).toBe(2);

    // getItem liefert dieselbe Nummer (Deep-Link-Karte).
    expect(store.getItem(a2.id)?.projectSeq).toBe(2);
  });
});

describe("Verlauf: listSessions + listSessionTurns", () => {
  it("gruppiert Sessions mit Zeitspanne, Turn-Zahl und erstem Prompt; Raw-Turns chronologisch und gekappt", () => {
    const t = (uuid: string, session: string, role: string, content: string, ts: string) =>
      store.insertTurn({ uuid, sessionId: session, projectPath: "c:/dev/hist", role, content, timestamp: ts });
    t("u1", "s-a", "user", "Erster Auftrag", "2026-07-01T10:00:00Z");
    t("a1", "s-a", "assistant", "Antwort A", "2026-07-01T10:01:00Z");
    t("u2", "s-b", "user", "Zweiter Auftrag", "2026-07-02T09:00:00Z");

    const sessions = store.listSessions({ project: "c:/dev/hist" });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.sessionId).toBe("s-b"); // neueste zuerst
    const sa = sessions.find((s) => s.sessionId === "s-a");
    expect(sa?.turns).toBe(2);
    expect(sa?.firstPrompt).toBe("Erster Auftrag");
    expect(sa?.firstAt).toBe("2026-07-01T10:00:00Z");
    expect(sa?.lastAt).toBe("2026-07-01T10:01:00Z");

    const turns = store.listSessionTurns("s-a");
    expect(turns.map((x) => x.uuid)).toEqual(["u1", "a1"]); // aufsteigend
    expect(turns[0]?.truncated).toBe(false);

    // Kappung: sehr lange Turns werden fürs Lesen gekürzt und markiert.
    t("u3", "s-c", "user", "x".repeat(10_000), "2026-07-03T08:00:00Z");
    const long = store.listSessionTurns("s-c");
    expect(long[0]?.truncated).toBe(true);
    expect(long[0]?.content.length).toBe(6_000);
  });
});
