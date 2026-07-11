// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Treiber für CLI/MCP: better-sqlite3 (DECISIONS.md D2). Pragmas und
// user_version-Migrationen laufen bei jedem Open (ADR-003/004).
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { MIGRATIONS, PRAGMAS } from "./schema.js";

export function openDb(filePath: string): Database.Database {
  if (filePath !== ":memory:") ensurePrivateDir(dirname(filePath));
  const fresh = filePath !== ":memory:" && !existsSync(filePath);
  const db = new Database(filePath);
  for (const p of PRAGMAS) db.pragma(p);
  migrate(db);
  if (fresh) tryChmod(filePath, 0o600);
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

// ~/.cockpit/ gehört nur dem aktuellen User (PRD F4): POSIX 700, auf Windows
// icacls (Vererbung kappen, nur aktueller User). Best-effort mit Warnung —
// ein Rechte-Fehler darf das Produkt nicht stoppen, aber nie still bleiben.
function ensurePrivateDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return;
  try {
    const user = userInfo().username;
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], {
      stdio: "ignore",
    });
  } catch (err) {
    console.error(`[cockpit] Warnung: Windows-ACL für ${dir} nicht gesetzt: ${String(err)}`);
  }
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (err) {
    console.error(`[cockpit] Warnung: chmod ${path} fehlgeschlagen: ${String(err)}`);
  }
}
