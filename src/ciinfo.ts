// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Ship-Tab Slice 2/3: LIVE-CI-Status über die `gh`-CLI. Bewusste Abweichung vom
// "local-first, kein Netz": nur auf ausdrücklichen Klick, mit dem BESTEHENDEN
// gh-Login des Nutzers (Cockpit speichert KEINEN Token). Härtung (Reviews):
//   - async execFile (promisify) statt execFileSync -> blockiert den
//     Single-Thread-Server NICHT während des Netz-Roundtrips.
//   - shell:false, feste Argument-Arrays, runId als Number -> keine Injection.
//   - GH_PROMPT_DISABLED/GIT_TERMINAL_PROMPT=0 -> gh hängt nie an einem Prompt.
//   - Fail-open: fehlt gh/Login/Netz, endet es in einem ehrlichen Zustand, nie
//     in einem Absturz oder einem falschen "grün".
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "./gitinfo.js";

const pExecFile = promisify(execFile);
const GH_TIMEOUT_MS = 8000; // Netz-Roundtrip; großzügiger als das Git-Budget.

export type CiState =
  | "no-gh" // gh nicht installiert
  | "no-auth" // gh nicht eingeloggt
  | "no-remote" // kein origin-Remote
  | "non-github" // Remote ist nicht GitHub
  | "unpushed" // HEAD nicht gepusht -> CI kennt ihn nicht
  | "no-run" // gepusht, aber kein Lauf für diesen Commit
  | "running" // Lauf läuft noch
  | "passed" // grün
  | "failed"; // gestoppt

export interface CiStatus {
  state: CiState;
  headSha: string;
  workflowName?: string;
  url?: string;
  // databaseId des fehlgeschlagenen Laufs — Eingang für die Log-Übersetzung (Slice 3).
  runId?: number;
  // Host bei non-github (für die Klartext-Meldung).
  host?: string;
}

// Roh-Lauf aus `gh run list --json ...`.
export interface GhRun {
  headSha: string;
  status: string; // "completed" | "in_progress" | "queued" | ...
  conclusion: string | null; // "success" | "failure" | "cancelled" | ...
  workflowName: string;
  url: string;
  databaseId: number;
}

const FAILED_CONCLUSIONS = ["failure", "cancelled", "timed_out", "startup_failure", "action_required"];

// Reine Klassifikation (testbar ohne gh): ordnet die Läufe dem lokalen HEAD zu
// und leitet den ehrlichen Zustand ab. ahead>0 ohne Lauf = "noch nicht gepusht"
// (nicht "kaputt"); failed schlägt running, damit ein bereits roter Pflicht-Job
// nicht hinter laufenden versteckt wird.
export function classifyCiRuns(
  runs: GhRun[],
  headSha: string,
  aheadBehind: { ahead: number; behind: number } | null,
): CiStatus {
  const matching = runs.filter((r) => r.headSha === headSha);
  if (matching.length === 0) {
    return { state: aheadBehind && aheadBehind.ahead > 0 ? "unpushed" : "no-run", headSha };
  }
  const failed = matching.find((r) => r.conclusion !== null && FAILED_CONCLUSIONS.includes(r.conclusion));
  if (failed) {
    return { state: "failed", headSha, workflowName: failed.workflowName, url: failed.url, runId: failed.databaseId };
  }
  const running = matching.find((r) => r.status !== "completed");
  if (running) {
    return { state: "running", headSha, workflowName: running.workflowName, url: running.url };
  }
  const r0 = matching[0]!;
  return { state: "passed", headSha, workflowName: r0.workflowName, url: r0.url };
}

async function gh(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await pExecFile("gh", args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      // Nie interaktiv werden (kein hängender Auth-/Update-Prompt).
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: (err as { stdout?: string }).stdout ?? "" };
  }
}

// gh-Präsenz ändert sich während einer Session nicht — einmal prüfen, merken.
let ghPresent: boolean | null = null;
async function ghAvailable(): Promise<boolean> {
  if (ghPresent === null) ghPresent = (await gh(process.cwd(), ["--version"])).ok;
  return ghPresent;
}

// `gh auth token` ist ein LOKALER Check (kein Netz): Exit 0 = eingeloggt. Der
// Token-stdout wird verworfen und nie geloggt.
async function ghAuthed(cwd: string): Promise<boolean> {
  return (await gh(cwd, ["auth", "token"])).ok;
}

function originUrl(cwd: string): string | null {
  try {
    return git(cwd, ["remote", "get-url", "origin"], 1000) || null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  const m = /(?:https?:\/\/|@)([^/:]+)/.exec(url);
  return m?.[1] ?? "einem anderen Host";
}

// Ganzer Ablauf, auf Abruf. Reihenfolge nutzt die billigen lokalen Checks zuerst
// (Präsenz, Remote, Login) und geht erst dann ins Netz (run list).
export async function collectCiStatus(
  cwd: string,
  headSha: string,
  aheadBehind: { ahead: number; behind: number } | null,
): Promise<CiStatus> {
  if (!(await ghAvailable())) return { state: "no-gh", headSha };
  const url = originUrl(cwd);
  if (!url) return { state: "no-remote", headSha };
  if (!/github\.com/i.test(url)) return { state: "non-github", headSha, host: hostOf(url) };
  if (!(await ghAuthed(cwd))) return { state: "no-auth", headSha };
  const res = await gh(cwd, ["run", "list", "--limit", "20", "--json", "headSha,status,conclusion,workflowName,url,databaseId"]);
  if (!res.ok) return { state: "no-run", headSha }; // fail-open (Netz/API-Fehler)
  try {
    return classifyCiRuns(JSON.parse(res.stdout) as GhRun[], headSha, aheadBehind);
  } catch {
    return { state: "no-run", headSha };
  }
}

// Fehler-Log des Laufs für die Haiku-Übersetzung (Slice 3). Auf die letzten ~8k
// Zeichen gekürzt — dort steht der eigentliche Fehler, und der Prompt bleibt klein.
export async function fetchFailedLog(cwd: string, runId: number): Promise<string | null> {
  const res = await gh(cwd, ["run", "view", String(runId), "--log-failed"]);
  const out = res.stdout.trim();
  if (!res.ok || !out) return null;
  const MAX = 8000;
  return out.length > MAX ? out.slice(-MAX) : out;
}
