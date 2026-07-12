// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Auto-Snapshot des Arbeitsstands nach einer Session (Git-Modi, mode='auto').
// Leitplanken (PO-Proposal i-c21aef276d): NIE HEAD/Index/Worktree bewegen, NIE
// auf den Arbeitsbranch committen, NIE pushen, NIE force. Der Trick: ein
// TEMPORÄRER Index (GIT_INDEX_FILE) — der echte .git/index bleibt unberührt.
// Fail-open wie gitinfo.ts: jeder Fehler/Timeout endet in einer hooks.log-Zeile
// (über den log-Callback), erzeugt keinen Snapshot und wirft nie nach außen.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Knapp budgetiert (der Stop-Hook hat ~2 s gesamt): `git add -A` darf auf
// großen Worktrees etwas länger, der Rest ist billig.
const ADD_TIMEOUT_MS = 1000;
const STEP_TIMEOUT_MS = 300;
// Aufbewahrung: die letzten 20 Snapshot-Refs, ältere räumt derselbe Lauf weg.
const KEEP_REFS = 20;
const REF_PREFIX = "refs/cockpit/wip-";

function git(cwd: string, args: string[], indexFile: string, timeoutMs: number): string {
  return execFileSync("git", args, {
    cwd,
    // Der temporäre Index ist der Kern der Zusicherung — read-tree/add/write-tree
    // stagen ausschließlich hier hinein, der echte Index wird nie angefasst.
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// YYYYMMDD-HHmm (lokale Wanduhr) — lexikografisch = chronologisch, damit die
// Prune-Sortierung ohne Datumsparsing auskommt.
function refStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Nach erfolgreichem update-ref: alle Snapshot-Refs auflisten und die ältesten
// löschen, bis KEEP_REFS bleiben. Eigener Fehlerpfad — Prune darf den bereits
// erzeugten Snapshot nicht kaputt machen.
function pruneSnapshots(cwd: string, indexFile: string, log: (msg: string) => void): void {
  try {
    const out = git(cwd, ["for-each-ref", "--format=%(refname)", "refs/cockpit/"], indexFile, STEP_TIMEOUT_MS);
    const refs = out.split("\n").filter((r) => r.startsWith(REF_PREFIX)).sort();
    for (let i = 0; i < refs.length - KEEP_REFS; i++) {
      git(cwd, ["update-ref", "-d", refs[i]!], indexFile, STEP_TIMEOUT_MS);
    }
  } catch (err) {
    log(`auto-snapshot prune: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Erzeugt einen Snapshot-Commit unter refs/cockpit/wip-<Zeit> aus dem aktuellen
// Worktree (inkl. ungetrackter Dateien via `git add -A`), OHNE HEAD/Index/
// Worktree zu verändern. Rückgabe: {ref, sha} bei neuem Snapshot; null bei
// keinem Repo/keinem Commit, unverändertem Stand (Dedupe) oder Fehler.
export function takeAutoSnapshot(
  cwd: string,
  sessionId: string,
  log: (msg: string) => void,
  now: Date = new Date(),
): { ref: string; sha: string } | null {
  const indexFile = join(tmpdir(), `cockpit-snap-${process.pid}-${Date.now()}.idx`);
  try {
    let headTree: string;
    try {
      // Kein Repo / kein git / unborn HEAD (kein Commit) → stiller Skip.
      headTree = git(cwd, ["rev-parse", "HEAD^{tree}"], indexFile, STEP_TIMEOUT_MS);
    } catch {
      return null;
    }
    git(cwd, ["read-tree", "HEAD"], indexFile, STEP_TIMEOUT_MS);
    git(cwd, ["add", "-A"], indexFile, ADD_TIMEOUT_MS);
    const tree = git(cwd, ["write-tree"], indexFile, STEP_TIMEOUT_MS);
    // Dedupe: identisch zum HEAD-Tree = nichts Ungesichertes → kein Snapshot.
    if (tree === headTree) return null;
    const msg = `cockpit auto-snapshot ${now.toISOString()} (session ${sessionId})`;
    const sha = git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", msg], indexFile, STEP_TIMEOUT_MS);
    const ref = `${REF_PREFIX}${refStamp(now)}`;
    git(cwd, ["update-ref", ref, sha], indexFile, STEP_TIMEOUT_MS);
    pruneSnapshots(cwd, indexFile, log);
    return { ref, sha };
  } catch (err) {
    log(`auto-snapshot: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    // Temporären Index (und ein evtl. verwaistes Lock) best-effort entfernen.
    for (const f of [indexFile, `${indexFile}.lock`]) {
      try {
        rmSync(f, { force: true });
      } catch {
        // Aufräumen ist best-effort — %TEMP% wird ohnehin geleert.
      }
    }
  }
}
