import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

// Version + Repo-URL aus der Root-package.json (eine Quelle der Wahrheit; kein
// Duplikat im SPA-Code) — als Compile-Zeit-Konstanten im Bundle.
const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as {
  version: string;
  homepage?: string;
};

// base:"/spa/" -> asset URLs become /spa/assets/*, matched 1:1 by the static
// server in web.ts. outDir ../dist/web with emptyOutDir clears only dist/web,
// so it never collides with the tsc server output in dist/. Packaging rides on
// the existing files:["dist"] entry. (PLAN-PRD §2)
export default defineConfig({
  base: "/spa/",
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __REPO_URL__: JSON.stringify(rootPkg.homepage ?? ""),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    // Dev-Proxy: der Vite-Dev-Server reicht /api an den echten cockpit-Server
    // durch (Default-Port 7878), damit `vite dev` gegen echte Daten läuft.
    proxy: {
      "/api": "http://127.0.0.1:7878",
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
