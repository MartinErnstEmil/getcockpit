// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M1-Gate: bm25-Suche gegen echte Datei-DB (PRD F2-Akzeptanzkriterien).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/store.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let store: Store;

function seedTurn(uuid: string, content: string, extra: Partial<Parameters<Store["insertTurn"]>[0]> = {}): void {
  store.insertTurn({
    uuid,
    sessionId: "s1",
    projectPath: "c:/dev/proj",
    role: "assistant",
    content,
    timestamp: "2026-06-01T10:00:00Z",
    ...extra,
  });
}

beforeEach(() => {
  ts = makeTempStore("cockpit-search-");
  store = ts.store;
});

afterEach(() => {
  ts.cleanup();
});

describe("searchTurns", () => {
  it("multi-term query finds a document WITHOUT the exact phrase (implicit AND)", () => {
    seedTurn("t1", "Wir haben SQLite als Datenbank für das Archiv gewählt.");
    seedTurn("t2", "Heute nur Smalltalk über das Wetter.");
    const hits = store.searchTurns("Archiv SQLite");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.uuid).toBe("t1");
    expect(hits[0]?.snippet).toContain("«");
  });

  it("umlaut/diacritics-robust via unicode61 remove_diacritics", () => {
    seedTurn("t1", "Die Begründung steht im ADR.");
    expect(store.searchTurns("Begrundung")).toHaveLength(1);
  });

  it("filters by project, role and since", () => {
    seedTurn("t1", "alpha beta", { projectPath: "c:/dev/a", role: "user" });
    seedTurn("t2", "alpha beta", {
      projectPath: "c:/dev/b",
      role: "assistant",
      timestamp: "2026-06-10T10:00:00Z",
    });
    expect(store.searchTurns("alpha", { project: "C:\\dev\\a" })).toHaveLength(1);
    expect(store.searchTurns("alpha", { role: "assistant" })).toHaveLength(1);
    expect(store.searchTurns("alpha", { since: "2026-06-05" })).toHaveLength(1);
  });

  it("FTS5 syntax error falls back to phrase search instead of throwing", () => {
    seedTurn("t1", 'Suche nach AND OR "Klammern" (geklammert)');
    // Roher FTS5-Operator-Mix wäre ein Syntaxfehler; gequotete Terme + Fallback fangen das.
    expect(() => store.searchTurns('AND) OR ("')).not.toThrow();
  });

  it("empty query returns no hits", () => {
    seedTurn("t1", "irgendwas");
    expect(store.searchTurns("   ")).toEqual([]);
  });

  it("fts index follows UPDATE and DELETE (the predecessor corruption bug)", () => {
    seedTurn("t1", "originaler inhalt einzigartig");
    store.rawDb().prepare("UPDATE turns SET content='ersetzter inhalt' WHERE uuid='t1'").run();
    expect(store.searchTurns("einzigartig")).toHaveLength(0);
    expect(store.searchTurns("ersetzter")).toHaveLength(1);
    store.rawDb().prepare("DELETE FROM turns WHERE uuid='t1'").run();
    expect(store.searchTurns("ersetzter")).toHaveLength(0);
    // Integritäts-Selbsttest des external-content-Index.
    expect(() =>
      store.rawDb().exec("INSERT INTO turns_fts(turns_fts, rank) VALUES('integrity-check', 0)"),
    ).not.toThrow();
  });
});

describe("searchItems ranking", () => {
  it("title hit beats body hit (column weights)", () => {
    store.addItem({ type: "decision", title: "Anderes Thema", body: "Hier geht es um Tokenizer Details und mehr Text drumherum." });
    store.addItem({ type: "decision", title: "Tokenizer Entscheidung", body: "Kurzer Body." });
    const hits = store.searchItems("Tokenizer");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe("Tokenizer Entscheidung");
  });

  it("finds hits in answers and keeps index in sync after update", () => {
    const item = store.addItem({ type: "question", title: "Portfrage" });
    store.answerItem(item.id, "Wir nehmen Port 7878 dafür.");
    const hits = store.searchItems("7878");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(item.id);
  });
});
