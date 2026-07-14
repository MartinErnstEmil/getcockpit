// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Bundles the hook entry into a single zero-dependency CJS file (DECISIONS.md D2).
// The bundle must be copyable to ~/.cockpit/bin/ without node_modules, so only
// node builtins (node:sqlite) may remain external.
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const ENTRY = "src/hooks/entry.ts";
const OUT = "dist/hooks/cockpit-hook.cjs";

if (!existsSync(ENTRY)) {
  console.log(`[build-hooks] ${ENTRY} not present yet (pre-M4) — skipping bundle`);
  process.exit(0);
}

// Version in den Banner stanzen (Setup-Selbstheilung): das installierte Bundle
// unter ~/.cockpit/bin trägt sonst keine Kennung, und der App-Start kann nicht
// entscheiden, ob es älter als das mitgelieferte ist. Quelle = package.json
// (der Bump-Ort); parsed via installedHookVersion() in setup.ts wieder heraus.
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  banner: { js: `#!/usr/bin/env node\n// cockpit-hook-version: ${version}` },
});
console.log(`[build-hooks] bundled ${ENTRY} -> ${OUT}`);
