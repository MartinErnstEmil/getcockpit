// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Git-Zustand eines Projekts einsammeln (PRD F10). Best-effort und knapp
// budgetiert: läuft auch im Stop-Hook (2-s-Gesamtbudget) — jede Teiloperation
// hat 300 ms, jeder Fehler (kein Repo, kein git-Binary) liefert null.
import { execFileSync } from "node:child_process";
import type { GitStateInput } from "./schema.js";

const GIT_TIMEOUT_MS = 300;
const RECENT_COMMITS = 5;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Null = kein Git-Repo / git fehlt / Budget gerissen — der Aufrufer lässt die
// Git-Sektion dann einfach weg (Fail-open, ARD §1.5).
export function collectGitState(cwd: string): GitStateInput | null {
  let headSha: string;
  let branch: string;
  try {
    headSha = git(cwd, ["rev-parse", "HEAD"]);
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return null;
  }
  let dirtyFiles = 0;
  try {
    const porcelain = git(cwd, ["status", "--porcelain"]);
    dirtyFiles = porcelain ? porcelain.split("\n").length : 0;
  } catch {
    // status kann auf riesigen Repos das Budget reißen — HEAD-Infos reichen.
  }
  let recentCommits: GitStateInput["recentCommits"] = [];
  try {
    const log = git(cwd, ["log", `-${RECENT_COMMITS}`, "--format=%H%x1f%cI%x1f%s"]);
    recentCommits = log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", at = "", subject = ""] = line.split("\x1f");
        return { sha, at, subject };
      });
  } catch {
    // dito: Commits sind nice-to-have im Cache.
  }
  return {
    projectPath: cwd,
    headSha,
    branch,
    dirtyFiles,
    lastCommitAt: recentCommits[0]?.at ?? null,
    recentCommits,
  };
}
