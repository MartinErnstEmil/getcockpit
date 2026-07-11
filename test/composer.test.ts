// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Config-Baukasten (U6): reiner Merger + Datei-Apply. Portiert aus cola;
// Tests decken Parser, In-place-Merge, Re-Apply-Dedup, Konflikte und den
// echten Katalog ab (gegen /snippets).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySnippetsToFile,
  checkConflicts,
  detectDuplicates,
  loadCatalog,
  mergeSnippetsInPlace,
  parseSnippetFile,
  resolveSnippetsByIds,
  type SnippetMeta,
} from "../src/composer.js";

function snip(over: Partial<SnippetMeta>): SnippetMeta {
  return {
    id: over.id ?? "f::t",
    file: over.file ?? "claude-md-base.txt",
    title: over.title ?? "T",
    target: "claude_md",
    section: over.section ?? "guidelines",
    priority: over.priority ?? 50,
    mode: over.mode ?? "write",
    tags: over.tags ?? [],
    conflicts: over.conflicts ?? [],
    body: over.body ?? "- rule",
    ...over,
  };
}

describe("composer parser + merger (U6)", () => {
  it("parses frontmatter blocks into snippet metas", () => {
    const raw = [
      "---",
      "title: Concise responses",
      "target: claude_md",
      "section: identity",
      "priority: 10",
      "tags: style, communication",
      "---",
      "- Prefer concise responses",
    ].join("\n");
    const out = parseSnippetFile(raw, "claude-md-base.txt");
    expect(out).toHaveLength(1);
    expect(out[0]!.section).toBe("identity");
    expect(out[0]!.mode).toBe("write");
    expect(out[0]!.tags).toEqual(["style", "communication"]);
    expect(out[0]!.id).toBe("claude-md-base.txt::concise-responses");
  });

  it("appends a new section, merges in place, and does not duplicate the heading on re-apply", () => {
    const a = snip({ id: "s::a", section: "guidelines", body: "- A" });
    const first = mergeSnippetsInPlace("# Rules\n", [a]);
    expect(first.appendedSections).toContain("guidelines");
    expect(first.content).toContain("## guidelines");
    expect(first.content).toContain("<!-- snippet: s::a -->");

    // Zweites Snippet derselben Section -> in-place, keine zweite Überschrift.
    const b = snip({ id: "s::b", section: "guidelines", body: "- B" });
    const second = mergeSnippetsInPlace(first.content, [b]);
    expect(second.modifiedSections).toContain("guidelines");
    expect(second.content.match(/## guidelines/g)).toHaveLength(1);

    // Re-Apply eines bereits vorhandenen Snippets wird per Marker erkannt.
    expect(detectDuplicates(second.content, [a])).toHaveLength(1);
    expect(detectDuplicates(second.content, [snip({ id: "s::neu" })])).toHaveLength(0);
  });

  it("flags two snippets in the same section+target as a conflict", () => {
    const conflicts = checkConflicts([
      snip({ id: "s::a", section: "conventions" }),
      snip({ id: "s::b", section: "conventions" }),
    ]);
    expect(conflicts.some((c) => c.kind === "duplicate_section")).toBe(true);
  });
});

describe("composer file apply (U6)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-composer-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry-run computes without writing; real apply writes and backs up", async () => {
    const target = join(dir, "CLAUDE.md");
    writeFileSync(target, "# Rules\n\nExisting.\n", "utf8");
    const picked = [snip({ id: "s::a", section: "guidelines", body: "- A" })];

    const dry = await applySnippetsToFile(target, picked, { dryRun: true });
    expect(dry.written).toBe(false);
    expect(dry.newChars).toBeGreaterThan(dry.existingChars);
    expect(readFileSync(target, "utf8")).toBe("# Rules\n\nExisting.\n"); // unverändert

    const real = await applySnippetsToFile(target, picked, {});
    expect(real.written).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("<!-- snippet: s::a -->");
    expect(existsSync(`${target}.bak`)).toBe(true);
    expect(readFileSync(`${target}.bak`, "utf8")).toBe("# Rules\n\nExisting.\n");
  });

  it("copy-mode snippets are never written to disk", async () => {
    const target = join(dir, "CLAUDE.md");
    const copyOnly = [snip({ id: "s::c", mode: "copy", target: "settings", body: "- copy" })];
    const real = await applySnippetsToFile(target, copyOnly, {});
    // writeOnly ist leer -> Datei bleibt leer (nur angelegt).
    expect(readFileSync(target, "utf8")).toBe("");
  });
});

describe("composer real catalog (U6)", () => {
  it("loads the shipped snippet catalog with stable ids", async () => {
    const catalog = await loadCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(10);
    expect(catalog.every((s) => s.id && s.title && s.section)).toBe(true);
    // Es gibt sowohl write- (claude_md) als auch copy-Snippets (settings/memory).
    expect(catalog.some((s) => s.mode === "write")).toBe(true);
    expect(catalog.some((s) => s.mode === "copy")).toBe(true);
    // Auflösung nach Ids funktioniert und trennt write/copy.
    const ids = catalog.slice(0, 3).map((s) => s.id);
    const resolved = resolveSnippetsByIds(catalog, [...ids, "gibts::nicht"]);
    expect(resolved.missing).toEqual(["gibts::nicht"]);
    expect(resolved.picked).toHaveLength(3);
  });
});
