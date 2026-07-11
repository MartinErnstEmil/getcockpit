// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Minimal-Web-UI (ADR-010, Stretch M6): node:http + EINE statische Seite,
// Vanilla JS, keine Build-Kette. Härtung: Hard-Bind 127.0.0.1, Loopback-Token
// in der URL, Host-Allowlist auf ALLEN Routen (DNS-Rebinding), Origin-
// Allowlist auf state-changing Routen, Content-Type-Zwang, kein CORS-Header.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cockpitHome } from "./paths.js";
import { ASSIST_KINDS, ASSIST_LANGS, ASSIST_PERSONAS, runAssist, type AssistKind, type AssistLang, type AssistPersona } from "./assist.js";
import { runBudgetCheck } from "./claudemd.js";
import { configView, readViewerFile, resolveClaudeMdTarget } from "./config.js";
import { applySnippetsToFile, loadCatalog, resolveSnippetsByIds } from "./composer.js";
import { runStatusBrief } from "./statusbrief.js";
import { cmdDoctor, enableAllHooks, hooksGloballyDisabled } from "./lifecycle.js";
import type { ClaudeCmd } from "./standup.js";
import type { Store } from "./store.js";
import { decisionsView, portfolioView, reportView } from "./views.js";

export interface WebOptions {
  // Test-Injektion für /api/assist (Mock statt echtem claude-Binary).
  assistCmd?: ClaudeCmd;
  assistTimeoutMs?: number;
  // Wurzel der gebauten SPA (dist/web). Default aus import.meta.url; Tests
  // injizieren ein Temp-Verzeichnis, da `npm test` nur den Server baut.
  webRoot?: string;
}

export const WEB_DEFAULT_PORT = 7878;

// Doctor gehört nicht in den Poll-Hot-Path (Review M1): ein Lauf öffnet eine
// :memory:-DB (FTS5-Check), nimmt via BEGIN IMMEDIATE einen Schreib-Lock auf
// die echte DB und liest settings.json — die SPA pollt /api/status aber alle
// paar Sekunden und konkurrierte so mit den schreibenden Hook-Prozessen.
// Health ändert sich nicht sekündlich; 60 s Cache reicht.
const DOCTOR_TTL_MS = 60_000;
let doctorCache: {
  at: number;
  checks: Array<{ ok: boolean; label: string; fix: string }>;
  hooksDisabled: boolean;
} | null = null;

function cachedDoctor(): NonNullable<typeof doctorCache> {
  if (!doctorCache || Date.now() - doctorCache.at > DOCTOR_TTL_MS) {
    doctorCache = {
      at: Date.now(),
      // spawnChecks:false — die claude-Spawns (Binary/MCP) blockieren den
      // Single-Thread-Server sekundenlang und gehören nicht in den Poll-Pfad;
      // der CLI-doctor führt sie aus.
      checks: cmdDoctor({ spawnChecks: false }).map((c) => ({ ok: c.ok, label: c.label, fix: c.fix })),
      hooksDisabled: hooksGloballyDisabled(),
    };
  }
  return doctorCache;
}

// Gebaute SPA liegt in dist/web (Vite outDir); dieses Modul kompiliert nach
// dist/web.js — die Wurzel ist also das Geschwister-Verzeichnis "web".
function defaultWebRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "web");
}

// Explizite MIME-Map (Windows-Static-Serving, Risiko 5): kein Raten aus dem OS.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

// Statisches Ausliefern der SPA-Shell unter /spa/** — tokenfrei (die Shell
// trägt keine Daten; localhost-Bind + Host-Allowlist bleiben, PLAN-PRD §2).
// Traversal-Guard: decode -> resolve-within-root; encodierte Punkte (%2e%2e)
// überleben `new URL` als Segment und werden hier abgefangen (Auflage T5).
// Literale ../ hat `new URL` bereits wegnormalisiert.
function serveStatic(res: ServerResponse, pathname: string, webRoot: string): void {
  const root = resolve(webRoot);
  const rel = pathname.slice("/spa".length); // "" | "/..." (führendes /spa raus)
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return sendJson(res, 400, { error: "ungültiger Pfad" });
  }
  const requested = resolve(root, "." + (decoded || "/"));
  if (requested !== root && !requested.startsWith(root + sep)) {
    return sendJson(res, 404, { error: "not found" });
  }

  // SPA-Fallback: exakt /spa(/) oder eine Client-Route ohne Datei-Endung ->
  // index.html. Fehlende Datei MIT Endung (z. B. verlorenes Asset) -> 404.
  const isFile = requested !== root && existsSync(requested) && statSync(requested).isFile();
  const ext = extname(requested);
  let filePath: string;
  if (isFile) {
    filePath = requested;
  } else if (ext === "" ) {
    filePath = join(root, "index.html");
  } else {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!existsSync(filePath)) return sendJson(res, 404, { error: "not found" });

  const mime = MIME[extname(filePath)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": mime };
  // Referrer-Policy auf HTML (kein Token je in die URL geleakt, §2).
  if (extname(filePath) === ".html") headers["Referrer-Policy"] = "no-referrer";
  res.writeHead(200, headers);
  res.end(readFileSync(filePath));
}

export function newWebToken(): string {
  // base64url (drei Zeichenklassen): läge das Token je in Text, greift die
  // Entropie-Redaction — Hex läge unter der Schwelle (PRD F7a).
  return randomBytes(18).toString("base64url");
}

// Persistentes Token (PRD F7a): stabil über Serverstarts, damit Lesezeichen
// und der Briefing-Link nicht bei jedem Start sterben. Datei liegt im
// privaten ~/.cockpit (POSIX 700 / Windows-ACL nur aktueller User).
export function loadOrCreateWebToken(): string {
  const path = join(cockpitHome(), "web-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    // fällt durch zur Neuerzeugung
  }
  const token = newWebToken();
  mkdirSync(cockpitHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  return token;
}

function hostAllowed(host: string | undefined, port: number): boolean {
  // "cockpit" ist als hosts-Datei-Alias erlaubt (http://cockpit:7878): eine
  // Single-Label-Domain existiert im öffentlichen DNS nicht — DNS-Rebinding
  // käme immer mit einem fremden Host-Header, nie mit "cockpit".
  // "cockpit.localhost" (U5): Browser lösen *.localhost per RFC 6761 IMMER auf
  // Loopback auf — die schöne URL funktioniert damit OHNE hosts-Eintrag, und
  // DNS-Rebinding bleibt ausgeschlossen (Server bindet ohnehin nur 127.0.0.1).
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `cockpit:${port}` ||
    host === `cockpit.localhost:${port}` ||
    (port === 80 && ["127.0.0.1", "localhost", "cockpit", "cockpit.localhost"].includes(host ?? ""))
  );
}

function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // same-origin fetch ohne Origin-Header
  // http://cockpit:<port> und http://cockpit.localhost:<port> ergänzt (Auflage
  // T4 / U5): die beworbenen Aliasse blockierten sonst alle POST von der
  // stabilen URL aus.
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://cockpit:${port}` ||
    origin === `http://cockpit.localhost:${port}`
  );
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > maxBytes) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

export function createWebServer(store: Store, token: string, webOpts: WebOptions = {}): Server {
  const webRoot = webOpts.webRoot ?? defaultWebRoot();
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  // Concurrency-Guard (Review-Auflage): maximal EIN laufender LLM-Call —
  // der Single-Thread-Server darf nie hinter parallelen Spawns verschwinden.
  let assistBusy = false;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : WEB_DEFAULT_PORT;
    if (!hostAllowed(req.headers.host, port)) return sendJson(res, 403, { error: "host not allowed" });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    // Browser fordern favicon ohne Token an — 204 statt 403-Konsolenrauschen.
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Reihenfolge Host -> Static -> Token (PLAN-PRD §2): die SPA-Shell unter
    // /spa/** ist tokenfrei; ALLE /api/** bleiben token- und origin-geschützt.
    if (req.method === "GET" && (url.pathname === "/spa" || url.pathname.startsWith("/spa/"))) {
      return serveStatic(res, url.pathname, webRoot);
    }
    // Root-Redirect (Auflagen T1/T6): / -> 302 /spa/ MIT Query-Forwarding
    // (+ url.search), sonst stirbt der Lesezeichen-Einstieg /?token=. Tokenfrei
    // wie die Shell — der Härtungs-Wächter (403) sitzt auf /api/**.
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { Location: "/spa/" + url.search });
      res.end();
      return;
    }
    const given = url.searchParams.get("token") ?? req.headers["x-cockpit-token"];
    if (given !== token) return sendJson(res, 403, { error: "missing or wrong token" });

    if (req.method === "GET" && url.pathname === "/api/search") {
      const hits = store.searchTurns(url.searchParams.get("q") ?? "", {
        project: url.searchParams.get("project") ?? undefined,
        role: url.searchParams.get("role") ?? undefined,
        limit: 50,
      });
      store.recordEvent({ eventType: "search", payload: { via: "web", hits: hits.length } });
      return sendJson(res, 200, { hits });
    }
    if (req.method === "GET" && url.pathname === "/api/items") {
      const items = store.listItems({
        status: url.searchParams.get("status") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        limit: 200,
      });
      return sendJson(res, 200, { items });
    }
    // Einzelnes Item unabhängig von Auswahl/Status/Cap (Deep-Link ?item= muss
    // die Karte immer öffnen können; Präfix-Match wie in der CLI).
    if (req.method === "GET" && url.pathname === "/api/item") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return sendJson(res, 400, { error: "id fehlt" });
      const item = store.getItem(id);
      if (!item) return sendJson(res, 404, { error: "Item nicht gefunden" });
      return sendJson(res, 200, { item });
    }
    if (req.method === "GET" && url.pathname === "/api/decisions") {
      const decisions = decisionsView(store, {
        project: url.searchParams.get("project") ?? undefined,
        all: url.searchParams.get("all") === "1",
      });
      return sendJson(res, 200, { decisions });
    }
    // U2: Kommentare einer Entscheidung (append-only aus dem Events-Log).
    if (req.method === "GET" && url.pathname === "/api/decision-comments") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return sendJson(res, 400, { error: "id fehlt" });
      return sendJson(res, 200, { comments: store.listDecisionComments(id) });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const view = portfolioView(store, {
        project: url.searchParams.get("project") ?? undefined,
      });
      const { checks: doctor, hooksDisabled } = cachedDoctor();
      // dismissedHints (Auflage T2): welche Onboarding-Hinweise dauerhaft
      // ausgeblendet sind — Zustand aus DB-Events, nicht localStorage.
      const dismissedHints = store.listDismissedHints();
      store.recordEvent({ eventType: "status", payload: { via: "web" } });
      return sendJson(res, 200, { ...view, doctor, hooksDisabled, dismissedHints });
    }
    // Projekte-Verwaltung (Paket 5): alle Projekte inkl. archivierter.
    if (req.method === "GET" && url.pathname === "/api/projects") {
      return sendJson(res, 200, { projects: store.projectAdminList() });
    }
    // Verlauf (Phase 5): Session-Liste + Raw-Turns einer Session.
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = store.listSessions({
        project: url.searchParams.get("project") ?? undefined,
        limit: 200,
      });
      return sendJson(res, 200, { sessions });
    }
    if (req.method === "GET" && url.pathname === "/api/turns") {
      const session = url.searchParams.get("session") ?? "";
      if (!session) return sendJson(res, 400, { error: "session fehlt" });
      const turns = store.listSessionTurns(session, { limit: 1000 });
      return sendJson(res, 200, { turns });
    }
    // Verlauf B (Meilensteine): Ereignisse dieser Session zum Einweben.
    if (req.method === "GET" && url.pathname === "/api/session-markers") {
      const session = url.searchParams.get("session") ?? "";
      if (!session) return sendJson(res, 400, { error: "session fehlt" });
      return sendJson(res, 200, { markers: store.listSessionMarkers(session) });
    }
    if (req.method === "GET" && url.pathname === "/api/report") {
      const daysRaw = Number(url.searchParams.get("days"));
      const days = reportView(store, {
        project: url.searchParams.get("project") ?? undefined,
        days: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined,
      });
      return sendJson(res, 200, { days });
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      const entries = configView(store, {
        project: url.searchParams.get("project") ?? undefined,
      });
      return sendJson(res, 200, { entries });
    }
    // Config-Baukasten (U6): kuratierter Snippet-Katalog (mit Bodies — klein
    // genug, spart einen zweiten Call für die Vorschau).
    if (req.method === "GET" && url.pathname === "/api/composer/snippets") {
      const snippets = await loadCatalog();
      return sendJson(res, 200, { snippets });
    }
    // Interner Datei-Viewer (Vorstufe): nur Pfade unter erfassten Projekt-
    // Wurzeln, Secret-Basenamen gesperrt (config.ts) — Guard sitzt im Reader.
    if (req.method === "GET" && url.pathname === "/api/file") {
      const p = url.searchParams.get("path") ?? "";
      if (!p) return sendJson(res, 400, { error: "path fehlt" });
      const r = readViewerFile(store, p, url.searchParams.get("project") ?? undefined);
      if (!r.ok) return sendJson(res, r.status, { error: r.error });
      return sendJson(res, 200, { file: r.file, content: r.content, truncated: r.truncated });
    }
    if (req.method === "POST") return handlePost(req, res, url, port);
    return sendJson(res, 404, { error: "not found" });
  }

  async function handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    port: number,
  ): Promise<void> {
    if (!originAllowed(req.headers.origin, port)) {
      return sendJson(res, 403, { error: "origin not allowed" });
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.startsWith("application/json")) {
      return sendJson(res, 415, { error: "Content-Type application/json erforderlich" });
    }
    let body: { id?: string; answer?: string; eventType?: string; payload?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }

    // /api/events trägt keine id — vor dem id-Zwang behandeln. eventType-
    // Allowlist ["hint_dismiss"], gleiche POST-Härtung (Auflage T2), Dedup vor
    // Insert (Auflage T8). Onboarding-Zustand lebt in DB-Events (Entscheidung 5).
    if (url.pathname === "/api/events") {
      const eventType = body.eventType ?? "";
      if (eventType === "hint_dismiss") {
        const payload = (body.payload ?? {}) as { hint?: string };
        const hint = typeof payload.hint === "string" ? payload.hint : "";
        if (!hint) return sendJson(res, 400, { error: "hint fehlt" });
        if (!store.hasHintDismiss(hint)) {
          store.recordEvent({ eventType: "hint_dismiss", payload: { hint } });
        }
        return sendJson(res, 200, { ok: true });
      }
      // A/B-Messung der Karten-Assists: welche Variante wurde gezeigt bzw.
      // übernommen. Payload wird auf bekannte String-Felder reduziert.
      if (eventType === "assist_ab" || eventType === "assist_adopt") {
        const p = (body.payload ?? {}) as { itemId?: string; variant?: string; kind?: string };
        store.recordEvent({
          eventType,
          payload: {
            itemId: typeof p.itemId === "string" ? p.itemId.slice(0, 64) : "",
            variant: typeof p.variant === "string" ? p.variant.slice(0, 32) : "",
            kind: typeof p.kind === "string" ? p.kind.slice(0, 32) : "",
          },
        });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 400, { error: "eventType nicht erlaubt" });
    }

    // Projekt-Briefing (LLM, teilt den Single-Flight-Guard mit den Assists —
    // es läuft immer nur EIN LLM-Spawn). Trägt project statt id, daher vor
    // dem id-Zwang. Degradiert fail-open auf den Rohbericht (mode: "raw").
    if (url.pathname === "/api/brief") {
      const project = (body as { project?: string }).project ?? "";
      if (!project) return sendJson(res, 400, { error: "project fehlt" });
      if (assistBusy) return sendJson(res, 429, { error: "Ein KI-Lauf ist bereits aktiv — kurz warten." });
      assistBusy = true;
      try {
        const brief = await runStatusBrief(store, {
          project,
          claudeCmd: webOpts.assistCmd,
          timeoutMs: webOpts.assistTimeoutMs,
        });
        store.recordEvent({ eventType: "brief", projectPath: project, payload: { mode: brief.mode } });
        return sendJson(res, 200, brief);
      } finally {
        assistBusy = false;
      }
    }

    // CLAUDE.md-Budget-Quellen-Check (Nachtrag 10.07.): Websearch-LLM prüft die
    // Anthropic-Doku. Teilt den Single-Flight-Guard. EHRLICHKEIT: erfindet nie
    // einen Wert — der Guard sitzt in runBudgetCheck.
    if (url.pathname === "/api/claudemd-check") {
      if (assistBusy) return sendJson(res, 429, { error: "Ein KI-Lauf ist bereits aktiv — kurz warten." });
      assistBusy = true;
      try {
        const result = await runBudgetCheck({ claudeCmd: webOpts.assistCmd, timeoutMs: webOpts.assistTimeoutMs });
        store.recordEvent({ eventType: "claudemd_check", payload: { found: result.found } });
        return sendJson(res, 200, result);
      } finally {
        assistBusy = false;
      }
    }

    // Projekte-Verwaltung (Paket 5): Capture-Toggle, Archiv-Toggle, Löschen.
    // Tragen project statt id, daher vor dem id-Zwang. Origin-Guard + JSON gelten.
    if (url.pathname === "/api/project-capture" || url.pathname === "/api/project-archive") {
      const project = (body as { project?: string }).project ?? "";
      const on = (body as { enabled?: boolean; archived?: boolean });
      if (!project) return sendJson(res, 400, { error: "project fehlt" });
      if (url.pathname === "/api/project-capture") {
        store.setCapture(project, on.enabled === true);
      } else {
        store.setArchived(project, on.archived === true);
      }
      store.recordEvent({ eventType: "project_settings", projectPath: project, payload: { path: url.pathname, ...on } });
      return sendJson(res, 200, { projects: store.projectAdminList() });
    }
    if (url.pathname === "/api/project-delete") {
      const project = (body as { project?: string }).project ?? "";
      // Doppelte Bestätigung: der Client zeigt zwei Dialoge, der Server verlangt
      // das explizite confirm-Flag als Guard gegen versehentliches Löschen.
      if (!project) return sendJson(res, 400, { error: "project fehlt" });
      if ((body as { confirm?: boolean }).confirm !== true) {
        return sendJson(res, 400, { error: "confirm erforderlich" });
      }
      const report = store.purge(project);
      store.recordEvent({ eventType: "project_delete", projectPath: project, payload: report });
      return sendJson(res, 200, { report, projects: store.projectAdminList() });
    }

    // Config-Baukasten Apply (U6): Snippets in eine CLAUDE.md mergen. Trägt
    // project statt id (daher vor dem id-Zwang). SICHER: der Zielpfad wird
    // serverseitig aus dem Projekt-Selektor aufgelöst (nie Rohpfad vom Client);
    // dryRun liefert nur die Vorschau. copy-Snippets werden nie geschrieben.
    if (url.pathname === "/api/composer/apply") {
      const b = body as { project?: string; snippetIds?: string[]; dryRun?: boolean };
      const ids = Array.isArray(b.snippetIds) ? b.snippetIds.filter((s) => typeof s === "string") : [];
      if (ids.length === 0) return sendJson(res, 400, { error: "snippetIds fehlen" });
      const target = resolveClaudeMdTarget(store, b.project);
      if (!target) return sendJson(res, 400, { error: "unbekanntes Projekt" });
      const catalog = await loadCatalog();
      const resolved = resolveSnippetsByIds(catalog, ids);
      const result = await applySnippetsToFile(target, resolved.writeOnly, { dryRun: b.dryRun === true });
      if (!b.dryRun) {
        store.recordEvent({ eventType: "composer_apply", projectPath: b.project ?? "", payload: { ids, target } });
      }
      return sendJson(res, 200, {
        target,
        written: result.written,
        existingChars: result.existingChars,
        newChars: result.newChars,
        newContent: result.newContent,
        modifiedSections: result.modifiedSections,
        appendedSections: result.appendedSections,
        missing: resolved.missing,
        copyOnly: resolved.copyOnly,
      });
    }

    // Banner-Klickpfad: disableAllHooks aus der settings.json entfernen —
    // dieselbe Chirurgie wie init/uninstall, wirkt ab der nächsten Session.
    if (url.pathname === "/api/hooks-enable") {
      const result = enableAllHooks();
      doctorCache = null; // Banner/Doctor sofort aktualisieren
      store.recordEvent({ eventType: "hooks_enable", payload: { changed: result.changed } });
      return sendJson(res, 200, result);
    }

    if (!body.id) return sendJson(res, 400, { error: "id fehlt" });

    if (url.pathname === "/api/assist") {
      const kind = (body as { kind?: string }).kind ?? "";
      if (!(ASSIST_KINDS as readonly string[]).includes(kind)) {
        return sendJson(res, 400, { error: "kind nicht erlaubt" });
      }
      // Persona aus den Nutzer-Einstellungen (Expertenlevel); unbekannte Werte
      // fallen still auf den Default zurück statt den Call platzen zu lassen.
      const personaRaw = (body as { persona?: string }).persona ?? "";
      const persona = (ASSIST_PERSONAS as readonly string[]).includes(personaRaw)
        ? (personaRaw as AssistPersona)
        : undefined;
      // Ausgabesprache aus der Oberfläche (U3); unbekannte Werte -> Default.
      const langRaw = (body as { lang?: string }).lang ?? "";
      const lang = (ASSIST_LANGS as readonly string[]).includes(langRaw)
        ? (langRaw as AssistLang)
        : undefined;
      if (assistBusy) return sendJson(res, 429, { error: "Ein Assist läuft bereits — kurz warten." });
      assistBusy = true;
      try {
        const result = await runAssist(store, {
          itemId: body.id,
          kind: kind as AssistKind,
          persona,
          lang,
          claudeCmd: webOpts.assistCmd,
          timeoutMs: webOpts.assistTimeoutMs,
        });
        if (!result.ok) {
          return sendJson(res, result.code === "not-found" ? 404 : 502, { error: result.error });
        }
        return sendJson(res, 200, { text: result.text });
      } finally {
        assistBusy = false;
      }
    }
    if (url.pathname === "/api/answer") {
      if (!body.answer?.trim()) return sendJson(res, 400, { error: "answer fehlt" });
      const item = store.answerItem(body.id, body.answer, "human");
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: "item not found" });
    }
    // Entwurf serverseitig sichern (Paket A): persistiert die Antwort, ohne sie
    // zuzustellen. Getrennt von /api/answer, damit answered exklusiv beim
    // Zustell-Pfad bleibt (answered_by!). Die Zustellung erfolgt danach über
    // /api/answer mit demselben (ggf. bearbeiteten) Text.
    if (url.pathname === "/api/draft") {
      if (!body.answer?.trim()) return sendJson(res, 400, { error: "answer fehlt" });
      const item = store.saveDraft(body.id, body.answer);
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: "item not found" });
    }
    if (url.pathname === "/api/done") {
      const item = store.updateItem(body.id, { status: "done" });
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: "item not found" });
    }
    // Status-Wechsel für "später" und Undo (UX-SPEC §2.7): nur unkritische
    // Zustände — answered bleibt exklusiv beim Antwort-Pfad (answered_by!).
    if (url.pathname === "/api/update") {
      const status = (body as { status?: string }).status ?? "";
      if (!["new", "in_progress", "postponed", "done"].includes(status)) {
        return sendJson(res, 400, { error: "status nicht erlaubt" });
      }
      const item = store.updateItem(body.id, { status });
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: "item not found" });
    }
    // U2: Kommentar an eine Entscheidung anhängen (Events-Log, keine Migration).
    if (url.pathname === "/api/decision-comment") {
      const text = (body as { text?: string }).text ?? "";
      if (!text.trim()) return sendJson(res, 400, { error: "text fehlt" });
      if (!store.getItem(body.id)) return sendJson(res, 404, { error: "item not found" });
      store.addDecisionComment(body.id, text);
      return sendJson(res, 200, { comments: store.listDecisionComments(body.id) });
    }
    // U2: Entscheidung archivieren/wiederherstellen ('archived'-Tag).
    if (url.pathname === "/api/decision-archive") {
      const archived = (body as { archived?: boolean }).archived === true;
      const item = store.setItemArchived(body.id, archived);
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: "item not found" });
    }
    // U2: Entscheidung revidieren — neue Entscheidung löst die alte per
    // parent_id ab (Supersede-Kette). body.id = Elter.
    if (url.pathname === "/api/decision-revise") {
      const title = (body as { title?: string }).title ?? "";
      const answer = (body as { answer?: string }).answer ?? "";
      if (!title.trim()) return sendJson(res, 400, { error: "title fehlt" });
      if (!answer.trim()) return sendJson(res, 400, { error: "answer fehlt" });
      const item = store.reviseDecision(body.id, title, answer);
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: "item not found" });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  return server;
}
