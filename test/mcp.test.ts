// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M3-Gate: MCP-SDK-Client + StdioClientTransport spawnt den GEBAUTEN Server
// (dist/mcp.js) gegen eine Temp-DB und ruft jedes der 6 Tools auf (PRD F6).
// NIEMALS via Registrierung in einer Claude-Session verifizieren.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const SERVER = join(process.cwd(), "dist", "mcp.js");

let tmp: string;
let dbPath: string;
let client: Client;

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResponse;
}

function payload<T>(res: ToolResponse): T {
  return JSON.parse(res.content[0]!.text) as T;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cockpit-mcp-"));
  dbPath = join(tmp, "cockpit.db");
  // Turns für recent_turns vorab seeden — WAL erlaubt den Parallelzugriff
  // von Test-Prozess und Server-Prozess.
  const seed = Store.open(dbPath);
  seed.insertTurn({
    uuid: "t-1",
    sessionId: "s-1",
    projectPath: "c:/dev/demo",
    role: "assistant",
    content: "Wir haben uns für Port 7878 entschieden.",
    timestamp: "2026-06-01T10:00:00Z",
  });
  seed.close();

  client = new Client({ name: "cockpit-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, COCKPIT_DB: dbPath },
    cwd: tmp,
  });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("MCP server (8 tools, F6)", () => {
  it("lists exactly the eight tools (ADR-011 + pickup/ack v2)", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "ack_answers",
      "add_item",
      "answer_question",
      "list_items",
      "pickup_answers",
      "recent_turns",
      "search_decisions",
      "update_item",
    ]);
  });

  it("add_item creates an item with defaults, redaction and project scoping", async () => {
    const res = await call("add_item", {
      type: "question",
      priority: "high",
      title: "Welchen Tokenizer nehmen wir? Key sk-abcdefgh12345678",
      body: "Details zur Frage",
      tags: ["m3"],
      projectPath: "c:/dev/demo",
    });
    expect(res.isError).toBeFalsy();
    const { item } = payload<{ item: { id: string; title: string; status: string } }>(res);
    expect(item.id).toMatch(/^i-/);
    expect(item.status).toBe("new");
    expect(item.title).toContain("[REDACTED:api-key]");
    expect(item.title).not.toContain("sk-abcdefgh12345678");
  });

  it("list_items scopes by project and filters by status", async () => {
    const all = payload<{ count: number }>(await call("list_items", { projectPath: "" }));
    expect(all.count).toBeGreaterThanOrEqual(1);
    const scoped = payload<{ count: number; items: Array<{ projectPath?: string }> }>(
      await call("list_items", { projectPath: "c:/dev/demo", status: "new" }),
    );
    expect(scoped.count).toBeGreaterThanOrEqual(1);
    const other = payload<{ count: number }>(
      await call("list_items", { projectPath: "c:/dev/andere" }),
    );
    expect(other.count).toBe(0);
  });

  it("update_item patches status and tags", async () => {
    const created = payload<{ item: { id: string } }>(
      await call("add_item", { type: "blocker", priority: "urgent", title: "Build rot" }),
    );
    const updated = payload<{ item: { status: string; tags: string[] } }>(
      await call("update_item", { id: created.item.id, status: "in_progress", tags: ["ci"] }),
    );
    expect(updated.item.status).toBe("in_progress");
    expect(updated.item.tags).toEqual(["ci"]);
  });

  it("update_item with status=answered marks answeredBy=claude (Briefing-Invariante)", async () => {
    const created = payload<{ item: { id: string } }>(
      await call("add_item", { type: "question", priority: "low", title: "Via update beantwortet?" }),
    );
    const updated = payload<{ item: { status: string; answeredBy?: string } }>(
      await call("update_item", { id: created.item.id, status: "answered", answer: "So." }),
    );
    expect(updated.item.status).toBe("answered");
    expect(updated.item.answeredBy).toBe("claude");
  });

  it("add_item with projectPath='' creates a global item (konsistent zu list_items)", async () => {
    const created = payload<{ item: { id: string; projectPath?: string } }>(
      await call("add_item", { type: "fyi", priority: "low", title: "Global angelegt", projectPath: "" }),
    );
    expect(created.item.projectPath).toBeUndefined();
  });

  it("answer_question sets answer with answeredBy=claude", async () => {
    const created = payload<{ item: { id: string } }>(
      await call("add_item", { type: "question", priority: "low", title: "Selbstbeantwortet?" }),
    );
    const answered = payload<{ item: { status: string; answer: string; answeredBy: string } }>(
      await call("answer_question", { id: created.item.id, answer: "Ja, geht." }),
    );
    expect(answered.item.status).toBe("answered");
    expect(answered.item.answer).toBe("Ja, geht.");
    expect(answered.item.answeredBy).toBe("claude");
  });

  it("search_decisions finds decision items via FTS, default type filter", async () => {
    await call("add_item", {
      type: "decision",
      priority: "medium",
      title: "Tokenizer: unicode61 mit remove_diacritics",
      projectPath: "c:/dev/demo",
    });
    await call("add_item", {
      type: "fyi",
      priority: "low",
      title: "Tokenizer-Doku gelesen",
      projectPath: "c:/dev/demo",
    });
    const res = payload<{ count: number; results: Array<{ type: string; title: string }> }>(
      await call("search_decisions", { query: "Tokenizer", projectPath: "c:/dev/demo" }),
    );
    expect(res.count).toBe(1);
    expect(res.results[0]?.type).toBe("decision");
  });

  it("recent_turns returns seeded turns, newest first, project-scoped", async () => {
    const res = payload<{ count: number; turns: Array<{ uuid: string; content: string }> }>(
      await call("recent_turns", { projectPath: "c:/dev/demo" }),
    );
    expect(res.count).toBe(1);
    expect(res.turns[0]?.uuid).toBe("t-1");
    const empty = payload<{ count: number }>(
      await call("recent_turns", { projectPath: "c:/dev/nix" }),
    );
    expect(empty.count).toBe(0);
  });

  it("pickup_answers ist NICHT-finalisierend; erst ack_answers finalisiert (v2)", async () => {
    // Menschlich beantwortetes Item direkt seeden — MCP-Tools schreiben nur 'claude'.
    const seed = Store.open(dbPath);
    const item = seed.addItem({ type: "question", title: "Pickup-Testfrage?", projectPath: "c:/dev/pickup" });
    seed.answerItem(item.id, "menschliche Antwort", "human");
    seed.close();

    const first = payload<{ count: number; answers: Array<{ uuid: string; answer: string }> }>(
      await call("pickup_answers", { itemIds: [item.id], projectPath: "c:/dev/pickup" }),
    );
    expect(first.count).toBe(1);
    expect(first.answers[0]?.answer).toBe("menschliche Antwort");
    // Zweiter Pull ohne Ack: NICHT-finalisierend -> Antwort taucht wieder auf.
    const second = payload<{ count: number }>(
      await call("pickup_answers", { itemIds: [item.id], projectPath: "c:/dev/pickup" }),
    );
    expect(second.count).toBe(1);

    const mid = Store.open(dbPath);
    expect(mid.getItem(item.id)?.deliveredAt).toBeFalsy(); // noch nicht finalisiert
    expect(mid.getItem(item.id)?.offeredAt).toBeTruthy(); // aber angeboten
    mid.close();

    // Ack finalisiert (exactly-once): danach ist die Antwort aus der Outbox.
    const acked = payload<{ count: number; acked: string[] }>(
      await call("ack_answers", { itemIds: [item.id], projectPath: "c:/dev/pickup" }),
    );
    expect(acked.count).toBe(1);
    const third = payload<{ count: number }>(
      await call("pickup_answers", { itemIds: [item.id], projectPath: "c:/dev/pickup" }),
    );
    expect(third.count).toBe(0);

    const check = Store.open(dbPath);
    expect(check.getItem(item.id)?.deliveredAt).toBeTruthy();
    // Quittung (answer_acked): via=mcp, ohne Session.
    const info = check.deliveryInfo([item.id]).get(item.id);
    check.close();
    expect(info?.via).toBe("mcp");
    expect(info?.sessionId).toBeNull();
  });

  it("unknown item ids return isError without crashing the server", async () => {
    const res = await call("answer_question", { id: "i-gibtsnicht", answer: "x" });
    expect(res.isError).toBe(true);
    // Server lebt noch:
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(8);
  });

  it("records mcp_tool_call events (stats backbone)", async () => {
    const check = Store.open(dbPath);
    const rows = check
      .rawDb()
      .prepare("SELECT COUNT(*) c FROM events WHERE event_type='mcp_tool_call'")
      .get() as { c: number };
    check.close();
    expect(rows.c).toBeGreaterThan(5);
  });
});
