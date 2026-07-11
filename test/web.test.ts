// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// M6-Gate (ADR-010): HTTP-Tests auf ephemerem Port inkl. Origin/Host/Token-
// Härtung; der Server wird nach den Tests beendet (kein Überlebender).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWebServer, newWebToken } from "../src/web.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let server: Server;
let port: number;
let token: string;
let itemId: string;

function url(path: string, withToken = true): string {
  const sep = path.includes("?") ? "&" : "?";
  return `http://127.0.0.1:${port}${path}${withToken ? `${sep}token=${token}` : ""}`;
}

beforeAll(async () => {
  ts = makeTempStore("cockpit-web-");
  ts.store.insertTurn({
    uuid: "t-1",
    sessionId: "s-1",
    projectPath: "c:/dev/demo",
    role: "assistant",
    content: "Die Replikation läuft über Postgres.",
    timestamp: "2026-06-01T10:00:00Z",
  });
  itemId = ts.store.addItem({ type: "question", title: "Webfrage?", projectPath: "c:/dev/demo" }).id;
  token = newWebToken();
  server = createWebServer(ts.store, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  ts.cleanup();
});

describe("web server hardening (ADR-010)", () => {
  it("/ redirects to /spa/ forwarding the query (T1); token guard sits on /api/** (T6)", async () => {
    // Auflage T1: /?token= -> 302 mit Token in Location (sonst stirbt der
    // Lesezeichen-Einstieg). fetch würde folgen — manual, um 302 zu prüfen.
    const withToken = await fetch(url("/"), { redirect: "manual" });
    expect(withToken.status).toBe(302);
    expect(withToken.headers.get("location")).toBe(`/spa/?token=${token}`);

    // Auflage T6: / ohne Token jetzt 302 (nicht mehr 403) — der Redirect ist
    // tokenfrei; der Härtungs-Wächter (403) sitzt auf /api/**.
    expect((await fetch(url("/", false), { redirect: "manual" })).status).toBe(302);
    expect((await fetch(url("/api/search?q=x", false))).status).toBe(403);
  });

  it("rejects foreign Host headers on every route (DNS rebinding)", async () => {
    // fetch/undici überschreibt den Host-Header — rohes http.request nötig.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `/api/search?q=x&token=${token}`,
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects state-changing requests with foreign Origin", async () => {
    const res = await fetch(url("/api/done"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ id: itemId }),
    });
    expect(res.status).toBe(403);
    expect(ts.store.getItem(itemId)?.status).toBe("new");
  });

  it("accepts same-origin Origin and enforces JSON content-type (415)", async () => {
    const wrongType = await fetch(url("/api/done"), {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ id: itemId }),
    });
    expect(wrongType.status).toBe(415);
  });

  it("never sets CORS wildcard headers", async () => {
    const res = await fetch(url("/api/search?q=x"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("search returns JSON hits", async () => {
    const res = await fetch(url("/api/search?q=Replikation Postgres"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const { hits } = (await res.json()) as { hits: Array<{ uuid: string }> };
    expect(hits).toHaveLength(1);
    expect(hits[0]?.uuid).toBe("t-1");
  });

  it("answer + done roundtrip via POST (human answer)", async () => {
    const answer = await fetch(url("/api/answer"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      // Whitespace-Polster darf nicht in DB/FTS landen — gespeichert wird getrimmt.
      body: JSON.stringify({ id: itemId, answer: "  Antwort aus dem Web  " }),
    });
    expect(answer.status).toBe(200);
    const updated = ts.store.getItem(itemId);
    expect(updated?.status).toBe("answered");
    expect(updated?.answeredBy).toBe("human");
    expect(updated?.answer).toBe("Antwort aus dem Web");

    const done = await fetch(url("/api/done"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId }),
    });
    expect(done.status).toBe(200);
    expect(ts.store.getItem(itemId)?.status).toBe("done");
  });

  it("unknown id and broken JSON produce 404/400, not 500", async () => {
    const missing = await fetch(url("/api/done"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "i-fehlt" }),
    });
    expect(missing.status).toBe(404);
    const broken = await fetch(url("/api/answer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ kaputt",
    });
    expect(broken.status).toBe(400);
  });
});

// F10: Statusboard-Endpoint — Token-geschützt, liefert Projekte, Jetzt-dran
// und doctor-Checks in einem Aufruf.
describe("GET /api/status (F10)", () => {
  it("requires the token", async () => {
    expect((await fetch(url("/api/status", false))).status).toBe(403);
  });

  it("returns projects, next actions and doctor checks", async () => {
    // Eigenes Item: die Roundtrip-Tests oben haben "Webfrage?" bereits erledigt.
    ts.store.addItem({ type: "blocker", title: "Statusfrage offen", projectPath: "c:/dev/demo" });
    const res = await fetch(url("/api/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects[0].projectPath).toBe("c:/dev/demo");
    expect(body.nextActions.some((a) => a.title === "Statusfrage offen")).toBe(true);
    expect(Array.isArray(body.doctor)).toBe(true);
    expect(body.doctor.length).toBeGreaterThanOrEqual(5);
  });
});

// Launch-UI: Status-Wechsel für "später"/Undo — Allowlist, answered gesperrt.
describe("POST /api/update (UX-SPEC Quick-Actions)", () => {
  it("allows postponed/new/done, rejects answered and junk", async () => {
    const it2 = ts.store.addItem({ type: "question", title: "Update-Testfrage", projectPath: "c:/dev/demo" });
    const call = (status) => fetch(url("/api/update"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ id: it2.id, status }),
    });
    const ok = await call("postponed");
    expect(ok.status).toBe(200);
    expect((await ok.json()).item.status).toBe("postponed");
    const back = await call("new");
    expect(back.status).toBe(200);
    expect((await call("answered")).status).toBe(400);
    expect((await call("kaputt")).status).toBe(400);
  });
});

// Assist-Route (Team-System-Testplan): Happy Path per Mock-Injektion,
// Busy-Guard 429, kind-Validierung, Projekt-Filter auf /api/items.
describe("POST /api/assist + Projekt-Filter", () => {
  it("items honor the project param including global items", async () => {
    ts.store.addItem({ type: "fyi", title: "Fremdprojekt-Item", projectPath: "c:/dev/anderes" });
    ts.store.addItem({ type: "fyi", title: "Globales Item" });
    const res = await fetch(url("/api/items?project=" + encodeURIComponent("c:/dev/demo")));
    const body = await res.json();
    const titles = body.items.map((i) => i.title);
    expect(titles).toContain("Globales Item");
    expect(titles).not.toContain("Fremdprojekt-Item");
  });

  it("validates kind, maps unknown items to 404", async () => {
    const call = (payload) => fetch(url("/api/assist"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(payload),
    });
    expect((await call({ id: itemId, kind: "kaputt" })).status).toBe(400);
    expect((await call({ id: "i-fehlt", kind: "explain" })).status).toBe(404);
  });
});

describe("assist happy path + busy guard (eigener Server mit Mock-LLM)", () => {
  it("returns text from the injected mock and 429 while busy", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cockpit-webassist-"));
    const slow = join(dir, "slow.cjs");
    writeFileSync(slow, "setTimeout(()=>process.stdout.write('MOCK-ASSIST'),800);process.stdin.resume();", "utf8");
    const ts2 = makeTempStore("cockpit-webassist-db-");
    const id2 = ts2.store.addItem({ type: "question", title: "Assistfrage", projectPath: "c:/dev/x" }).id;
    const token2 = newWebToken();
    const srv = createWebServer(ts2.store, token2, {
      assistCmd: { cmd: process.execPath, baseArgs: [slow] },
      assistTimeoutMs: 10_000,
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address();
    const p2 = typeof addr === "object" && addr ? addr.port : 0;
    const call = () => fetch(`http://127.0.0.1:${p2}/api/assist?token=${token2}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${p2}` },
      body: JSON.stringify({ id: id2, kind: "explain" }),
    });
    try {
      const [first, second] = await Promise.all([call(), call()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 429]);
      const okRes = first.status === 200 ? first : second;
      expect((await okRes.json()).text).toBe("MOCK-ASSIST");
      const third = await call();
      expect(third.status).toBe(200);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      ts2.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// F7a: persistentes Token + "cockpit" als erlaubter hosts-Alias.
describe("persistent token + cockpit host alias", () => {
  it("loadOrCreateWebToken is stable across calls and base64url", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "cockpit-token-"));
    const prev = process.env.COCKPIT_HOME;
    process.env.COCKPIT_HOME = home;
    try {
      const { loadOrCreateWebToken } = await import("../src/web.js");
      const a = loadOrCreateWebToken();
      const b = loadOrCreateWebToken();
      expect(a).toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/); // base64url, redaction-faehig
      expect(readFileSync(join(home, "web-token"), "utf8").trim()).toBe(a);
    } finally {
      if (prev === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts Host cockpit:<port> and cockpit.localhost:<port>, still rejects foreign hosts", async () => {
    const { request } = await import("node:http");
    const status = (host) => new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: `/api/items?token=${token}`,
        headers: { host } }, (res) => resolve(res.statusCode));
      req.on("error", () => resolve(-1));
      req.end();
    });
    expect(await status(`cockpit:${port}`)).toBe(200);
    // U5: *.localhost-Alias funktioniert ohne hosts-Eintrag.
    expect(await status(`cockpit.localhost:${port}`)).toBe(200);
    expect(await status(`evil.example:${port}`)).toBe(403);
  });

  it("accepts POST Origin http://cockpit.localhost:<port> (U5)", async () => {
    const res = await fetch(url("/api/update"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://cockpit.localhost:${port}` },
      body: JSON.stringify({ id: "i-none", status: "done" }),
    });
    // Origin akzeptiert -> kein 403; unbekannte id -> 404 (nicht Origin-Block).
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });
});

describe("Deep-Link- und Viewer-Endpunkte (Inbox-Rework 09.07.)", () => {
  it("/api/item liefert das Item (mit projectSeq) per id; 404/400 sauber", async () => {
    const ok = await fetch(url(`/api/item?id=${itemId}`));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { item: { id: string; projectSeq?: number } };
    expect(body.item.id).toBe(itemId);
    expect(body.item.projectSeq).toBe(1);
    expect((await fetch(url("/api/item?id=i-gibtsnicht"))).status).toBe(404);
    expect((await fetch(url("/api/item?id="))).status).toBe(400);
    // Token-Wächter gilt auch hier.
    expect((await fetch(url(`/api/item?id=${itemId}`, false))).status).toBe(403);
  });

  it("/api/file ankert Relativpfade an der mitgegebenen Projektwurzel", async () => {
    // ts.dir als erfasste Projektwurzel registrieren + Datei anlegen.
    ts.store.insertTurn({
      uuid: "t-root",
      sessionId: "s-root",
      projectPath: ts.dir,
      role: "user",
      content: "x",
      timestamp: "2026-07-09T08:00:00Z",
    });
    mkdirSync(join(ts.dir, "docs"), { recursive: true });
    writeFileSync(join(ts.dir, "docs", "note.md"), "Hallo Anker", "utf8");

    const rel = await fetch(url(`/api/file?path=docs/note.md&project=${encodeURIComponent(ts.dir)}`));
    expect(rel.status).toBe(200);
    expect(((await rel.json()) as { content: string }).content).toBe("Hallo Anker");

    // Unbekannte Wurzel darf nie als Anker dienen.
    const unknown = await fetch(url("/api/file?path=docs/note.md&project=c:/nicht/erfasst"));
    expect(unknown.status).toBe(400);

    // Projekte, die NUR Items tragen (kein Turn erfasst), sind ebenfalls
    // gültige Anker — sonst wären deren Datei-Links grundsätzlich tot.
    const itemsRoot = join(ts.dir, "items-only-projekt");
    mkdirSync(join(itemsRoot, "docs"), { recursive: true });
    writeFileSync(join(itemsRoot, "docs", "i.md"), "Item-Wurzel", "utf8");
    ts.store.addItem({ type: "fyi", title: "nur-items", projectPath: itemsRoot });
    const viaItems = await fetch(url(`/api/file?path=docs/i.md&project=${encodeURIComponent(itemsRoot)}`));
    expect(viaItems.status).toBe(200);

    // Traversal-Disziplin bleibt: der Anker ändert den Startpunkt, der
    // inRoot-Check läuft weiterhin NACH resolve (Auflage T5).
    const escape = await fetch(url(`/api/file?path=../ausbruch.md&project=${encodeURIComponent(ts.dir)}`));
    expect(escape.status).toBe(403);
  });
});
