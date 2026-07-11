// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Phase 1 (PLAN-PRD §7.1, §10A): Static-Serving der SPA-Shell unter /spa/**.
// Tokenfrei (Shell trägt keine Daten), MIME-Map, encodierter Traversal -> 404
// (Auflage T5), SPA-Fallback, Härtungs-Wächter (/spa/** 200, /api/** 403).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer, newWebToken } from "../src/web.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;
let server: Server;
let port: number;
let token: string;
let webRoot: string;

beforeAll(async () => {
  ts = makeTempStore("cockpit-spa-static-");
  webRoot = mkdtempSync(join(tmpdir(), "cockpit-spa-web-"));
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Cockpit SPA</title><div id=root></div>", "utf8");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log('spa');", "utf8");
  token = newWebToken();
  server = createWebServer(ts.store, token, { webRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  ts.cleanup();
  rmSync(webRoot, { recursive: true, force: true });
});

const at = (path: string) => `http://127.0.0.1:${port}${path}`;

describe("SPA static serving (/spa/**)", () => {
  it("serves index.html tokenfree with correct MIME and no-referrer", async () => {
    const res = await fetch(at("/spa/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("Cockpit SPA");
  });

  it("serves hashed assets with the JS MIME type, tokenfree", async () => {
    const res = await fetch(at("/spa/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("falls back to index.html for extensionless client routes", async () => {
    const res = await fetch(at("/spa/inbox"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cockpit SPA");
  });

  it("returns 404 for a missing asset that has an extension", async () => {
    expect((await fetch(at("/spa/assets/missing.js"))).status).toBe(404);
  });

  it("rejects encoded traversal (%2e%2e%2f) with 404", async () => {
    const res = await fetch(at("/spa/%2e%2e%2fweb.js"));
    expect(res.status).toBe(404);
  });

  it("never sets a CORS wildcard on static responses", async () => {
    const res = await fetch(at("/spa/"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("hardening guard: shell tokenfree, api token-gated (Risiko 1)", () => {
  it("/spa/** without token is 200, /api/** without token is 403", async () => {
    expect((await fetch(at("/spa/"))).status).toBe(200);
    expect((await fetch(at("/api/status"))).status).toBe(403);
    expect((await fetch(at("/api/items"))).status).toBe(403);
  });

  it("rejects foreign Host on /spa/** too (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/spa/", headers: { Host: "evil.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", () => resolve(-1));
      req.end();
    });
    expect(status).toBe(403);
  });
});
