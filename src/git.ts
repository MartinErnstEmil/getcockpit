// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { execFileSync } from "node:child_process";

// Best-effort: Nicht-Git-Verzeichnisse und fehlendes git-Binary liefern null;
// ein Item ohne Git-Stempel ist besser als ein geplatzter add_item-Call.
export function getGitContext(cwd: string): { sha: string; branch: string } | null {
  const run = (args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    return { sha: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) };
  } catch {
    return null;
  }
}
