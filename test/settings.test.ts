// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Spezifikation konzeptionell aus dev/cola settings.test.ts: Multiplexer —
// fremde Hooks überleben jede cockpit-Operation byte-identisch.
import { describe, it, expect } from "vitest";
import {
  addCockpitHooks,
  hasCockpitHooks,
  hookCommand,
  removeCockpitHooks,
  serializeSettings,
  type ClaudeSettings,
} from "../src/settings.js";

const BUNDLE = "C:\\Users\\x\\.cockpit\\bin\\cockpit-hook.cjs";

describe("hookCommand", () => {
  it("quotes the path with forward slashes and disables node warnings", () => {
    expect(hookCommand(BUNDLE)).toBe('node --no-warnings "C:/Users/x/.cockpit/bin/cockpit-hook.cjs"');
  });
});

describe("addCockpitHooks / removeCockpitHooks", () => {
  const foreign = {
    matcher: ".*",
    hooks: [{ type: "command", command: "node \"C:/other/tool-hook.cjs\"" }],
  };

  it("adds entries for all three events, leaves foreign hooks untouched", () => {
    const before: ClaudeSettings = { hooks: { Stop: [foreign] }, model: "opus" };
    const { settings, added } = addCockpitHooks(before, BUNDLE);
    expect(added.sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(settings.hooks?.["Stop"]).toHaveLength(2);
    expect(settings.hooks?.["Stop"]?.[0]).toEqual(foreign);
    expect(settings["model"]).toBe("opus");
    // Original unverändert (pure function auf Klon).
    expect(before.hooks?.["Stop"]).toHaveLength(1);
  });

  it("is idempotent: double add keeps exactly one cockpit entry per event", () => {
    const once = addCockpitHooks({}, BUNDLE).settings;
    const twice = addCockpitHooks(once, BUNDLE).settings;
    expect(serializeSettings(twice)).toBe(serializeSettings(once));
    expect(twice.hooks?.["Stop"]).toHaveLength(1);
  });

  it("replaces an existing cockpit entry on path change instead of stacking", () => {
    const old = addCockpitHooks({}, "C:\\old\\cockpit-hook.cjs").settings;
    const { settings, replaced } = addCockpitHooks(old, BUNDLE);
    expect(replaced.sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(settings.hooks?.["Stop"]?.[0]?.hooks?.[0]?.command).toContain("C:/Users/x");
  });

  it("remove restores the exact original structure (byte-identical roundtrip)", () => {
    const original: ClaudeSettings = {
      hooks: { Stop: [foreign] },
      permissions: { deny: ["Read(//etc/**)"] },
    };
    const rawBefore = serializeSettings(original);
    const installed = addCockpitHooks(original, BUNDLE).settings;
    const { settings: restored, removed } = removeCockpitHooks(installed);
    expect(removed.sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(serializeSettings(restored)).toBe(rawBefore);
  });

  it("remove on empty settings drops the empty hooks object entirely", () => {
    const installed = addCockpitHooks({}, BUNDLE).settings;
    const { settings: restored } = removeCockpitHooks(installed);
    expect(serializeSettings(restored)).toBe(serializeSettings({}));
  });

  it("hasCockpitHooks reports per event", () => {
    const installed = addCockpitHooks({}, BUNDLE).settings;
    expect(hasCockpitHooks(installed)).toEqual({
      UserPromptSubmit: true,
      Stop: true,
      SessionStart: true,
    });
    expect(hasCockpitHooks({})).toEqual({
      UserPromptSubmit: false,
      Stop: false,
      SessionStart: false,
    });
  });
});
