// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Electron-Main (Desktop-Wrapper). Startet den Cockpit-Web-Backend IN-PROCESS
// (kein separater node.exe / kein Logon-Task noetig) und zeigt die bestehende
// SPA im BrowserWindow. Root-Paket ist ESM; diese Datei ist bewusst CJS
// (.cjs) und laedt die ESM-`dist` per dynamischem import().
const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// dist liegt neben electron/ (dev) bzw. entpackt im app-Verzeichnis (packaged,
// via asarUnpack). pathToFileURL, damit der ESM-Loader den Pfad auf Windows
// (Laufwerksbuchstabe/Backslashes) sauber aufloest.
function distUrl(file) {
  return pathToFileURL(path.join(__dirname, "..", "dist", file)).href;
}

async function loadBackend() {
  const [web, store, paths] = await Promise.all([
    import(distUrl("web.js")),
    import(distUrl("store.js")),
    import(distUrl("paths.js")),
  ]);
  return {
    createWebServer: web.createWebServer,
    loadOrCreateWebToken: web.loadOrCreateWebToken,
    port: web.WEB_DEFAULT_PORT,
    Store: store.Store,
    resolveDbPath: paths.resolveDbPath,
  };
}

// Guard: lauscht schon jemand (Alt-Instanz / Logon-Task)? Dann NICHT selbst
// binden — wir wiederverwenden den laufenden Server (gleiches persistentes
// Token aus ~/.cockpit/web-token), statt EADDRINUSE zu riskieren.
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

let server = null;
let store = null;

async function ensureBackend() {
  const be = await loadBackend();
  const token = be.loadOrCreateWebToken();
  if (await portInUse(be.port)) {
    return { token, port: be.port, started: false };
  }
  store = be.Store.open(be.resolveDbPath());
  server = be.createWebServer(store, token);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(be.port, "127.0.0.1", () => resolve());
  });
  return { token, port: be.port, started: true };
}

// Geordnete Einrichtung beim Start (setup.js): idempotent + selbstheilend. Der
// erste Start nach der Installation (Bundle noch nicht kopiert) registriert
// zusaetzlich den MCP-Server (spawnChecks) — spaetere Starts bleiben schnell.
// Ein harter Fehler oder gefundene Legacy-Hooks (needsAttention) leiten aufs
// /setup-Panel; sonst direkt in die SPA.
async function runSetupGate() {
  const [setup, paths] = await Promise.all([
    import(distUrl("setup.js")),
    import(distUrl("paths.js")),
  ]);
  const firstRun = !fs.existsSync(paths.hookBundleInstallPath());
  return setup.runSetup({ spawnChecks: firstRun });
}

async function createWindow() {
  const { token, port } = await ensureBackend();
  const report = await runSetupGate();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0e14",
    title: "Cockpit",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  // Externe Links (z. B. Doku) im echten Browser oeffnen, nie im App-Fenster.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}`)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const route = report.needsAttention ? "/setup" : "/";
  await win.loadURL(`http://127.0.0.1:${port}${route}?token=${token}`);
}

// Single-Instance: ein zweiter Start fokussiert das vorhandene Fenster.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow).catch((err) => {
    // Startfehler NIE verschlucken: sichtbarer Dialog + sauberer Exit.
    dialog.showErrorBox("Cockpit - Startfehler", String((err && err.stack) || err));
    app.quit();
  });
}

app.on("window-all-closed", () => {
  try {
    if (server) server.close();
  } catch { /* best-effort */ }
  try {
    if (store) store.close();
  } catch { /* best-effort */ }
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
