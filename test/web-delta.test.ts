// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Phase 2 (PLAN-PRD §7.2, §10A): Backend-Delta. Global-Zeile (P1), Komma-Status
// in /api/items (T3), POST /api/events + dismissedHints auf payload_json (T2),
// hint_dismiss-Dedup (T8), Origin-Alias http://cockpit:<port> (T4).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createWebServer, newWebToken } from "../src/web.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let server: Server;
let port: number;
let token: string;

function url(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `http://127.0.0.1:${port}${path}${sep}token=${token}`;
}
function postJson(path: string, body: unknown, origin?: string) {
  return fetch(url(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : { origin: `http://127.0.0.1:${port}` }),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  ts = makeTempStore("cockpit-web-delta-");
  ts.store.insertTurn({
    uuid: "t-1",
    sessionId: "s-1",
    projectPath: "c:/dev/demo",
    role: "assistant",
    content: "Kontext für die Demo.",
    timestamp: "2026-06-01T10:00:00Z",
  });
  // Ein globales Item (project_path IS NULL) und projektgebundene Items.
  ts.store.addItem({ type: "blocker", title: "Globaler Blocker" }); // global
  ts.store.addItem({ type: "question", title: "Demo-Frage", projectPath: "c:/dev/demo" });
  token = newWebToken();
  server = createWebServer(ts.store, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  ts.cleanup();
});

describe("Global-Zeile in portfolioView (Auflage P1)", () => {
  it("status carries a synthetic global row with the global item counts", async () => {
    const body = (await (await fetch(url("/api/status"))).json()) as {
      projects: Array<{ projectPath: string; global?: boolean; blockers: number; openItems: number }>;
    };
    const global = body.projects.find((p) => p.global === true);
    expect(global).toBeDefined();
    expect(global?.projectPath).toBe("");
    expect(global?.blockers).toBe(1); // "Globaler Blocker"
    expect(global?.openItems).toBe(1);
    // Die echte Projektzeile bleibt erhalten und ist zuerst (nicht die Global-Zeile).
    expect(body.projects[0]?.projectPath).toBe("c:/dev/demo");
  });
});

describe("Komma-Status in /api/items (Auflage T3)", () => {
  it("status=new,in_progress uses an IN-list (same definition as the tiles)", async () => {
    const all = (await (await fetch(url("/api/items"))).json()) as { items: Array<{ status: string }> };
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    const open = (await (await fetch(url("/api/items?status=new,in_progress"))).json()) as {
      items: Array<{ status: string }>;
    };
    expect(open.items.length).toBeGreaterThanOrEqual(2);
    expect(open.items.every((i) => i.status === "new" || i.status === "in_progress")).toBe(true);
  });

  it("a single status still filters exactly", async () => {
    const done = (await (await fetch(url("/api/items?status=done"))).json()) as { items: unknown[] };
    expect(done.items).toHaveLength(0);
  });
});

describe("POST /api/events + dismissedHints (Auflagen T2/T8)", () => {
  it("rejects unknown eventType and missing hint", async () => {
    expect((await postJson("/api/events", { eventType: "evil" })).status).toBe(400);
    expect((await postJson("/api/events", { eventType: "hint_dismiss", payload: {} })).status).toBe(400);
  });

  it("rejects a foreign Origin (POST hardening applies)", async () => {
    const res = await postJson(
      "/api/events",
      { eventType: "hint_dismiss", payload: { hint: "onboarding" } },
      "http://evil.example",
    );
    expect(res.status).toBe(403);
  });

  it("roundtrip: POST hint_dismiss then status.dismissedHints contains it (payload_json)", async () => {
    const before = (await (await fetch(url("/api/status"))).json()) as { dismissedHints: string[] };
    expect(before.dismissedHints).not.toContain("onboarding");

    const ok = await postJson("/api/events", { eventType: "hint_dismiss", payload: { hint: "onboarding" } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);

    const after = (await (await fetch(url("/api/status"))).json()) as { dismissedHints: string[] };
    expect(after.dismissedHints).toContain("onboarding");
  });

  it("dedups: a second dismiss of the same hint writes no extra event (T8)", async () => {
    const countDismiss = () =>
      (
        ts.store
          .rawDb()
          .prepare("SELECT COUNT(*) c FROM events WHERE event_type = 'hint_dismiss'")
          .get() as { c: number }
      ).c;
    const first = countDismiss();
    await postJson("/api/events", { eventType: "hint_dismiss", payload: { hint: "onboarding" } });
    expect(countDismiss()).toBe(first); // unverändert
  });
});

describe("Origin-Alias http://cockpit:<port> (Auflage T4)", () => {
  it("accepts POST from the advertised cockpit host alias", async () => {
    const res = await postJson(
      "/api/events",
      { eventType: "hint_dismiss", payload: { hint: "capture" } },
      `http://cockpit:${port}`,
    );
    expect(res.status).toBe(200);
  });
});
