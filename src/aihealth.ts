// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// KI-Gesundheit / Fehlerdiagnose (Briefing/Assist-Timeouts). Zwei Fragen: Ist
// Claude Code erreichbar, und stauen sich alte `claude`-Sitzungen, die neue
// KI-Aufrufe ausbremsen? Der Nutzer kann die alten (seit >= 18 h laufenden)
// Sitzungen auf Knopfdruck beenden. Best-effort: jeder Fehler endet in leeren
// Werten, nie in einem Absturz. Terminiert AUSSCHLIESSLICH `claude`-Prozesse.
import { execFileSync } from "node:child_process";

// "Stale" = Prozess läuft seit >= 18 h. Echte Tastatur-Inaktivität lässt sich
// aus einer Prozess-Momentaufnahme nicht messen; die Laufzeit ist der ehrliche
// Näherungswert für "vergessenes Terminal", und der Mensch bestätigt die Liste.
const STALE_MINUTES = 18 * 60;
const PROBE_TIMEOUT_MS = 5000;

export interface AiHealth {
  claudeInstalled: boolean;
  claudeVersion: string | null;
  // Laufende `claude`-Prozesse insgesamt und davon die seit >= 18 h laufenden.
  runningSessions: number;
  staleSessions: number;
  staleThresholdHours: number;
}

interface ClaudeProc {
  pid: number;
  ageMinutes: number;
}

// Alle laufenden `claude`-Prozesse mit ihrem Alter. Plattform-spezifisch:
// Windows über PowerShell (Get-Process + StartTime), POSIX über `ps`.
function listClaudeProcs(): ClaudeProc[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // Alter in Minuten direkt in PowerShell rechnen (kein Datumsparsing
          // in Node); StartTime kann für Fremdprozesse werfen -> try/catch je Zeile.
          "Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, [int]((Get-Date)-$_.StartTime).TotalMinutes } catch {} }",
        ],
        { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      );
      return parseProcLines(out);
    }
    // POSIX: etimes = verstrichene Sekunden seit Start.
    const out = execFileSync("ps", ["-Ao", "pid=,etimes=,comm="], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    return out
      .split(/\r?\n/)
      .filter((l) => /(^|\/)claude$/i.test(l.trim().split(/\s+/)[2] ?? ""))
      .map((l) => {
        const [pid = "", etimes = ""] = l.trim().split(/\s+/);
        return { pid: Number(pid), ageMinutes: Math.floor(Number(etimes) / 60) };
      })
      .filter(validProc);
  } catch {
    return [];
  }
}

function parseProcLines(out: string): ClaudeProc[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid = "", age = ""] = l.split(/\s+/);
      return { pid: Number(pid), ageMinutes: Number(age) };
    })
    .filter(validProc);
}

function validProc(p: ClaudeProc): boolean {
  return Number.isInteger(p.pid) && p.pid > 0 && Number.isFinite(p.ageMinutes) && p.ageMinutes >= 0;
}

// Claude-Code-Version, wenn das Binary auf dem PATH erreichbar ist. Auf Windows
// über die Shell (findet claude.exe via PATH); Argument ist konstant, keine
// Injection. null = nicht installiert / nicht erreichbar.
function claudeVersion(): string | null {
  try {
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: process.platform === "win32",
    }).trim();
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? (out.split(/\r?\n/)[0] || null);
  } catch {
    return null;
  }
}

export function getAiHealth(): AiHealth {
  const version = claudeVersion();
  const procs = listClaudeProcs();
  return {
    claudeInstalled: version !== null,
    claudeVersion: version,
    runningSessions: procs.length,
    staleSessions: procs.filter((p) => p.ageMinutes >= STALE_MINUTES).length,
    staleThresholdHours: STALE_MINUTES / 60,
  };
}

// Beendet die seit >= 18 h laufenden `claude`-Prozesse. process.kill wirkt
// plattformübergreifend (auf Windows = TerminateProcess). Fehler (schon weg /
// kein Zugriff) werden ignoriert. Nur `claude`-Prozesse — der Cockpit-Server
// (node/electron) taucht in der Liste nie auf.
export function terminateStaleClaude(): { terminated: number } {
  const stale = listClaudeProcs().filter((p) => p.ageMinutes >= STALE_MINUTES);
  let terminated = 0;
  for (const p of stale) {
    try {
      process.kill(p.pid, "SIGKILL");
      terminated++;
    } catch {
      // Prozess bereits beendet oder kein Zugriff — nicht fatal.
    }
  }
  return { terminated };
}
