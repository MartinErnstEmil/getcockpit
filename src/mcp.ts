#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// MCP-Server (PRD F6, ADR-011): 7 Tools, keine Datei-Schreibfläche.
// Tool-Schemas konzeptionell aus dev/cola mcp-server (ursprünglich MIT,
// (c) 2026, relizenziert durch denselben Rechteinhaber).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { getGitContext } from "./git.js";
import { COCKPIT_VERSION } from "./index.js";
import { normalizeProjectPath, resolveDbPath } from "./paths.js";
import { ITEM_PRIORITIES, ITEM_STATUSES, ITEM_TYPES, Store } from "./store.js";
import { WEB_DEFAULT_PORT, loadOrCreateWebToken } from "./web.js";

// Klickbarer Kurzlink zum Item in der Web-UI: das Modell soll ihn dem Nutzer
// im Chat ausgeben, damit der direkt in die Cockpit-Inbox springen kann.
// Token ist das persistente Loopback-Token (F7a) — lokal, nie öffentlich.
function itemUrl(itemId: string): string | null {
  try {
    const token = loadOrCreateWebToken();
    return `http://127.0.0.1:${WEB_DEFAULT_PORT}/spa/inbox?item=${encodeURIComponent(itemId)}&token=${token}`;
  } catch {
    return null; // Link ist Komfort — ein Fehler darf add_item nie platzen lassen
  }
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// projectPath-Konvention für Lese- UND Schreibpfad (vom Vorgänger übernommen):
// nicht gesetzt → aktuelles Projekt (cwd des Servers), "" → global (kein
// Filter bzw. project_path NULL), sonst → dieser Pfad.
function resolveProjectArg(raw: string | undefined): string | undefined {
  if (raw === undefined) return normalizeProjectPath(process.cwd());
  if (raw === "") return undefined;
  return normalizeProjectPath(raw);
}

const typeEnum = z.enum(ITEM_TYPES);
const statusEnum = z.enum(ITEM_STATUSES);
const priorityEnum = z.enum(ITEM_PRIORITIES);
const anchorShape = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

export function buildMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: "cockpit", version: COCKPIT_VERSION });

  // Jeder Tool-Aufruf landet im Events-Log (Basis für `cockpit stats`); ein
  // Handler-Fehler wird zur isError-Antwort, nie zum Server-Crash.
  function register(
    name: string,
    description: string,
    shape: ZodRawShape,
    handler: (args: Record<string, unknown>) => ToolResult,
  ): void {
    server.registerTool(name, { description, inputSchema: shape }, (args: Record<string, unknown>) => {
      const t0 = Date.now();
      let result: ToolResult;
      try {
        result = handler(args);
      } catch (e) {
        result = err(e instanceof Error ? e.message : String(e));
      }
      try {
        store.recordEvent({
          eventType: "mcp_tool_call",
          projectPath: process.cwd(),
          payload: { tool: name, ms: Date.now() - t0, outcome: result.isError ? "err" : "ok" },
        });
      } catch {
        // Event-Logging darf die Tool-Antwort nie zerstören.
      }
      return result;
    });
  }

  register(
    "add_item",
    "Add an item to the cockpit inbox. Use this whenever you need the human to review, answer, or decide something. Prefer this over burying the ask in chat output. IMPORTANT: the result contains humanUrl — always show it to the user in your chat output as a clickable markdown link, e.g. [Item im Cockpit](humanUrl).",
    {
      type: typeEnum.describe("Kind of item"),
      priority: priorityEnum.describe("Urgency from the human's perspective"),
      title: z.string().min(1).describe("One-line summary"),
      body: z
        .string()
        .optional()
        .describe(
          "Markdown details. Antwortoptionen als eigene Zeilen: '( ) Option' (genau eine wählbar) oder '[ ] Option' (mehrere kombinierbar) — die Web-UI macht sie klickbar und füllt damit das Antwortfeld",
        ),
      anchor: anchorShape.optional().describe("Optional file:line this item is about"),
      tags: z.array(z.string()).optional(),
      sessionId: z.string().optional().describe("Session identifier for grouping"),
      parentId: z.string().optional().describe("Id of a parent item (thread)"),
      projectPath: z.string().optional().describe("Project this belongs to (default: cwd; '' = global)"),
    },
    (a) => {
      const git = getGitContext(process.cwd());
      const item = store.addItem({
        type: a["type"] as string,
        priority: a["priority"] as string,
        title: a["title"] as string,
        body: a["body"] as string | undefined,
        anchor: a["anchor"] as { file: string; line?: number; endLine?: number } | undefined,
        tags: a["tags"] as string[] | undefined,
        sessionId: a["sessionId"] as string | undefined,
        parentId: a["parentId"] as string | undefined,
        projectPath: resolveProjectArg(a["projectPath"] as string | undefined),
        source: "claude",
        gitSha: git?.sha,
        gitBranch: git?.branch,
      });
      const humanUrl = itemUrl(item.id);
      return ok({
        item,
        humanUrl,
        instruction: humanUrl
          ? `Zeige dem Nutzer jetzt diesen klickbaren Link im Chat: [${item.title.slice(0, 60)} → Cockpit](${humanUrl})`
          : undefined,
        // Paket 2: aktiver Abhol-Pfad, falls die On-the-fly-Injektion nicht greift.
        pickupHint:
          "Wenn du auf die Antwort wartest, rufe vor dem nächsten Schritt pickup_answers auf.",
      });
    },
  );

  register(
    "list_items",
    "List items in the cockpit inbox. Call at the start of a task to see what's open or answered. Scoped to the current project by default; pass projectPath:'' for all projects.",
    {
      status: statusEnum.optional(),
      priority: priorityEnum.optional(),
      type: typeEnum.optional(),
      updatedSince: z.string().optional().describe("ISO8601: only items updated at or after"),
      projectPath: z.string().optional(),
    },
    (a) => {
      const items = store.listItems({
        status: a["status"] as string | undefined,
        priority: a["priority"] as string | undefined,
        type: a["type"] as string | undefined,
        updatedSince: a["updatedSince"] as string | undefined,
        project: resolveProjectArg(a["projectPath"] as string | undefined),
      });
      return ok({ count: items.length, items });
    },
  );

  register(
    "update_item",
    "Update an item's status, priority, body, tags or answer. Use when you've resolved a blocker or learned something that changes an item.",
    {
      id: z.string().min(1),
      status: statusEnum.optional(),
      priority: priorityEnum.optional(),
      body: z.string().optional(),
      answer: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    (a) => {
      const status = a["status"] as string | undefined;
      const answer = a["answer"] as string | undefined;
      const item = store.updateItem(a["id"] as string, {
        status,
        priority: a["priority"] as string | undefined,
        body: a["body"] as string | undefined,
        answer,
        tags: a["tags"] as string[] | undefined,
        // Der MCP-Server IST die Modell-Seite: Antworten über update_item
        // zählen wie bei answer_question als 'claude' — sonst entsteht
        // status='answered' mit answered_by NULL, und das Briefing (das auf
        // answered_by='human' filtert) würde das Item nie als zugestellt führen.
        answeredBy: status === "answered" || answer != null ? "claude" : undefined,
      });
      return item ? ok({ item }) : err(`Item not found: ${String(a["id"])}`);
    },
  );

  register(
    "answer_question",
    "Answer an inbox item (status becomes 'answered'). Answers given by the model are marked answeredBy='claude' — the session briefing only delivers human answers.",
    {
      id: z.string().min(1).describe("Item id"),
      answer: z.string().min(1).describe("Answer text"),
    },
    (a) => {
      const item = store.answerItem(a["id"] as string, a["answer"] as string, "claude");
      return item ? ok({ item }) : err(`Item not found: ${String(a["id"])}`);
    },
  );

  register(
    "pickup_answers",
    "Claim the human's undelivered answers for this project and mark them delivered in ONE atomic step. Use this when you asked the human something (add_item) and are waiting — call it before your next step instead of blocking. Each answer is returned exactly once; a second call returns nothing (already delivered). Shares delivery state with the session briefing, so no answer is delivered twice. Scoped to the current project by default; pass projectPath:'' for global items.",
    {
      projectPath: z.string().optional().describe("Project to pick up for (default: cwd; '' = global)"),
    },
    (a) => {
      // resolveProjectArg liefert undefined für "" (global) — die claim-SQL
      // braucht aber einen String; "" beansprucht dann nur globale Items
      // (project_path IS NULL). Default (cwd) beansprucht Projekt + Globale.
      const project = resolveProjectArg(a["projectPath"] as string | undefined) ?? "";
      const answers = store.claimHumanAnswers(project);
      // Zustell-Protokoll: ein answer_delivered-Event JE abgeholter Antwort
      // (via='mcp', keine Session — der MCP-Server kennt keinen Session-Kontext).
      for (const ans of answers) {
        store.recordEvent({ eventType: "answer_delivered", projectPath: project, payload: { itemId: ans.uuid, via: "mcp" } });
      }
      return ok({ count: answers.length, answers });
    },
  );

  register(
    "search_decisions",
    "Full-text search over inbox items, type=decision by default (BM25-ranked, no embeddings). Useful before making a decision: has the human already decided this? Scoped to the current project by default; pass projectPath:'' for global.",
    {
      query: z.string().min(1).describe("FTS query (terms are AND-combined)"),
      projectPath: z.string().optional(),
      types: z.array(typeEnum).optional().describe("Item types to include (default: ['decision'])"),
      status: statusEnum.optional(),
      since: z.string().optional().describe("ISO8601: only items updated since"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (a) => {
      const results = store.searchItems(a["query"] as string, {
        types: (a["types"] as string[] | undefined) ?? ["decision"],
        project: resolveProjectArg(a["projectPath"] as string | undefined),
        status: a["status"] as string | undefined,
        since: a["since"] as string | undefined,
        limit: (a["limit"] as number | undefined) ?? 20,
      });
      return ok({ count: results.length, results });
    },
  );

  register(
    "recent_turns",
    "Most recent captured conversation turns, newest first. Scoped to the current project by default; pass projectPath:'' for global. Use to recall what was just discussed in another session of the same project.",
    {
      projectPath: z.string().optional(),
      role: z.enum(["user", "assistant"]).optional(),
      since: z.string().optional().describe("ISO8601: only turns at or after"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (a) => {
      const turns = store.listTurns({
        project: resolveProjectArg(a["projectPath"] as string | undefined),
        role: a["role"] as string | undefined,
        since: a["since"] as string | undefined,
        limit: (a["limit"] as number | undefined) ?? 20,
      });
      return ok({ count: turns.length, turns });
    },
  );

  return server;
}

const store = Store.open(resolveDbPath());
const server = buildMcpServer(store);
await server.connect(new StdioServerTransport());
