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
