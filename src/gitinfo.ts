// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Git-Zustand eines Projekts einsammeln (PRD F10). Best-effort und knapp
// budgetiert: läuft auch im Stop-Hook (2-s-Gesamtbudget) — jede Teiloperation
// hat 300 ms, jeder Fehler (kein Repo, kein git-Binary) liefert null.
import { execFileSync } from "node:child_process";
import type { GitStateInput } from "./schema.js";

const GIT_TIMEOUT_MS = 300;
const RECENT_COMMITS = 5;
// Eigenes Budget für die LIVE-Abfragen des Git-Tabs (Log/Graph). Sie laufen im
// Web-Request, NICHT im 2-s-Stop-Hook — die 300 ms von oben würden `git log`
// genau auf den großen Repos abwürgen, wo der Graph am nützlichsten ist
// (Plumbing-Review C2). Trennung ist bewusst.
const GIT_LIVE_TIMEOUT_MS = 5000;
// Feldtrenner 0x1f: taucht weder in Sha/Datum/Ref-Namen noch in einer
// (einzeiligen) Commit-Subject auf — anders als ein Leerzeichen.
const US = "\x1f";

function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
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

// Vorsprung/Rückstand zum Upstream (Git-Tab, live auf Abruf — bewusst NICHT im
// git_state-Cache: das Schema ist eingefroren, und der Wert veraltet ohnehin
// mit jedem fetch/push). Kein Netzwerkzugriff — verglichen wird gegen den
// lokal bekannten Remote-Stand. null = kein Upstream konfiguriert / kein Repo.
export function collectAheadBehind(cwd: string): { ahead: number; behind: number } | null {
  try {
    const out = git(cwd, ["rev-list", "--count", "--left-right", "@{u}...HEAD"]);
    const [behind = "0", ahead = "0"] = out.split(/\s+/);
    return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
  } catch {
    return null;
  }
}

// Jüngster Auto-Snapshot-Ref (Git-Modi, mode='auto'): der Git-Tab zeigt ihn
// live auf Abruf (wie ahead/behind, bewusst nicht im Cache). null = noch kein
// Snapshot / kein Repo. --sort=-refname nutzt die chronologische Ref-Benennung
// (wip-YYYYMMDD-HHmm); creatordate = Datum des Snapshot-Commits. Trenner ist
// ein Leerzeichen — for-each-ref expandiert (anders als git log) KEIN %x1f, und
// weder Ref-Namen noch iso-strict-Daten enthalten Leerzeichen.
export function collectLastSnapshot(
  cwd: string,
): { ref: string; at: string; unmerged: boolean } | null {
  try {
    // objectname (Sha) mit auslesen, um die "steckt die Arbeit schon in HEAD?"-
    // Frage beantworten zu können (US-Trenner, da Ref-Namen kein 0x1f enthalten).
    const out = git(cwd, [
      "for-each-ref",
      "--sort=-refname",
      "--count=1",
      `--format=%(refname:short)${US}%(creatordate:iso-strict)${US}%(objectname)`,
      "refs/cockpit/",
    ]);
    if (!out) return null;
    const [ref = "", at = "", sha = ""] = out.split(US);
    if (!ref) return null;
    return { ref, at, unmerged: sha ? snapshotUnmerged(cwd, sha) : false };
  } catch {
    return null;
  }
}

// Enthält der Snapshot Arbeit, die NICHT in HEAD steckt? `merge-base
// --is-ancestor <snap> HEAD` -> Exit 0 = Snapshot ist Vorfahr von HEAD (bereits
// eingeholt, nichts zu tun), Exit 1 = Snapshot hat unvereinigte Commits.
// execFileSync wirft bei Exit != 0 — Status 1 ist hier das ERWARTETE Signal,
// jeder andere Fehler zählt fail-open als "nichts zu tun" (Plumbing-Review S1).
function snapshotUnmerged(cwd: string, snapSha: string): boolean {
  try {
    git(cwd, ["merge-base", "--is-ancestor", snapSha, "HEAD"]);
    return false; // Exit 0: Vorfahr -> bereits in HEAD
  } catch (err) {
    return (err as { status?: number }).status === 1;
  }
}

export interface GitLogEntry {
  sha: string;
  at: string;
  subject: string;
}

// Flache Commit-Liste der aktuellen Branch-Historie (aufklappbare Karte). Volle
// Seite (== limit) -> hasMore=true, damit die UI ehrlich "es gibt ältere" zeigen
// kann. null = kein Repo/Fehler.
export function collectGitLog(
  cwd: string,
  opts: { limit: number } = { limit: 30 },
): { commits: GitLogEntry[]; hasMore: boolean } | null {
  const limit = Math.max(1, Math.min(opts.limit || 30, 200));
  try {
    const out = git(
      cwd,
      ["log", `--max-count=${limit}`, "HEAD", `--format=%H${US}%cI${US}%s`],
      GIT_LIVE_TIMEOUT_MS,
    );
    const commits = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha = "", at = "", subject = ""] = line.split(US);
        return { sha, at, subject };
      });
    return { commits, hasMore: commits.length === limit };
  } catch {
    return null;
  }
}

export interface GitGraphCommit {
  sha: string;
  parents: string[];
  at: string;
  subject: string;
  // Ref-Namen an diesem Commit ("HEAD -> main", "origin/main", "refs/cockpit/…").
  refs: string[];
}

// Commit-Graph über die echten Refs (Branches/Remotes/Tags), optional inkl. der
// Auto-Snapshots. NIE bare --all (das zöge die bis zu 20 refs/cockpit-Stummel
// immer mit); --topo-order ist Pflicht, sonst bricht die Lane-Zuweisung bei
// Uhr-Schieflage (Plumbing-Review C1). %P = VOLLE Elter-Shas, %D = Ref-Dekoration.
export function collectGitGraph(
  cwd: string,
  opts: { limit: number; snapshots?: boolean } = { limit: 200 },
): { commits: GitGraphCommit[]; limitHit: boolean } | null {
  const limit = Math.max(1, Math.min(opts.limit || 200, 500));
  const scope = ["--branches", "--remotes", "--tags"];
  if (opts.snapshots) scope.push("--glob=refs/cockpit/*");
  try {
    const out = git(
      cwd,
      ["log", "--topo-order", `--max-count=${limit}`, ...scope, `--format=%H${US}%P${US}%cI${US}%D${US}%s`],
      GIT_LIVE_TIMEOUT_MS,
    );
    const lines = out.split(/\r?\n/).filter(Boolean);
    const commits = lines.map((line) => {
      const [sha = "", parents = "", at = "", decoration = "", subject = ""] = line.split(US);
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        at,
        subject,
        refs: decoration ? decoration.split(", ").filter(Boolean) : [],
      };
    });
    return { commits, limitHit: commits.length === limit };
  } catch {
    return null;
  }
}
