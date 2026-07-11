// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M0 gate: both SQLite drivers must provide FTS5 + bm25() on this machine.
// Hooks bundle relies on node:sqlite (zero-dep, see DECISIONS.md D2);
// CLI/MCP rely on better-sqlite3.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal common surface of both drivers needed for the smoke check.
interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

function expectFts5WithBm25(db: SqliteLike): void {
  db.exec("CREATE VIRTUAL TABLE f USING fts5(t)");
  db.exec("INSERT INTO f VALUES ('hello bm25 world'), ('unrelated row')");
  const rows = db
    .prepare("SELECT t, bm25(f) AS rank FROM f WHERE f MATCH 'hello' ORDER BY rank")
    .all() as Array<{ t: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.t).toContain("hello");
  db.close();
}

describe("M0 driver smoke", () => {
  it("better-sqlite3 supports FTS5 and bm25 (CLI/MCP driver)", () => {
    expectFts5WithBm25(new Database(":memory:"));
  });

  it("node:sqlite supports FTS5 and bm25 (hook driver)", () => {
    expectFts5WithBm25(new DatabaseSync(":memory:"));
  });

  it("WAL pragma works on a file-backed db in temp", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-m0-"));
    const db = new Database(join(dir, "t.db"));
    expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
