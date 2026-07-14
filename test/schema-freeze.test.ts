// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/schema.js";

// Backend-Review M3: Migrationen sind append-only. Eine bestehende Migration
// in-place zu ändern lässt Neu- und Bestandsinstallationen still divergieren —
// Bestands-DBs haben user_version schon hochgezählt und führen die geänderte
// Fassung nie aus. Dieser Test friert den Wortlaut ein: Schema-Änderungen
// bekommen eine NEUE Migration am Ende (plus neuen Hash hier), bestehende
// Einträge werden nie editiert.
const FROZEN_SHA256 = [
  "0b6487c7228b31c4703366aa165809567ed0655868b04b0c749b14ef021333e8", // v1: turns/items/events/backfill_files + FTS
  "bb4f36008ce0493d7a72b5029a920826951b021675637516d1ec633d99e42fa8", // v2: git_state (F10)
  "fc1c3fa0fc40c8f30401186d021ab623a674c7b1146fb83ca94c1855b482bfaf", // v3: project_settings (Paket 5)
  "6072b57ea6ca767488d6a004be0c1c3e02248e5b010db6f22f1c0c8dcb93cc96", // v4: project_settings.git_mode (Git-Modi)
  "94622c003c9c9eb2ac2bf15b0d43caec37cdfad531afa84cd46e32703ea932aa", // v5: env_specs + env_history (Env-Tab)
  "cd38e113f340bec8098fc1065d33db75af19a456b131dfe6e2125ea6bc4bec14", // v6: items.offered_at/dead + answer_offers (Zustellung v2)
  "af3eddeeee1b48da856c91780a313c74c73e3fbd836eae40600da96a998abbda", // v7: config_snapshots (Gedächtnis & Regeln, Versionshistorie)
];

describe("MIGRATIONS eingefroren (append-only)", () => {
  it("bestehende Migrationen sind byte-identisch zum eingefrorenen Stand", () => {
    const hashes = MIGRATIONS.map((m) => createHash("sha256").update(m).digest("hex"));
    expect(hashes.slice(0, FROZEN_SHA256.length)).toEqual(FROZEN_SHA256);
  });

  it("jede neue Migration wird hier mit eingefroren", () => {
    expect(MIGRATIONS.length).toBe(FROZEN_SHA256.length);
  });
});
