// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Gemeinsames Test-Setup: echter Store auf echter Datei-DB in %TEMP%.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

export interface TempStore {
  store: Store;
  dir: string;
  cleanup: () => void;
}

export function makeTempStore(prefix = "cockpit-test-"): TempStore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // cleanup geht über ts.store (nicht die Closure-Variable), damit Tests den
  // Store reopenen und reassignen dürfen; close() ist in better-sqlite3 idempotent.
  const ts: TempStore = {
    store: Store.open(join(dir, "cockpit.db")),
    dir,
    cleanup: () => {
      ts.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ts;
}
