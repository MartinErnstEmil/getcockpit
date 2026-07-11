// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Config-Baukasten (U6): kuratierte Best-Practice-Snippets klickbar in eine
// CLAUDE.md mergen — In-place-Section-Merge, ID-Marker-Dedup, Konflikt-Erkennung.
// Portiert aus dem cola-V2-Composer (dev/cola, vision/15-composer-spec.md;
// Eigenbesitz, hier auf PolyForm-NC relizenziert). Reiner Merger + Datei-Apply;
// die Budget-Bewertung macht die SPA über die dry-run-Vorschau.
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SnippetMode = "write" | "copy";

export interface SnippetMeta {
  id: string;
  file: string;
  title: string;
  description?: string;
  target: string;
  section: string;
  priority: number;
  mode: SnippetMode;
  tags: string[];
  conflicts: string[];
  body: string;
}

export type ConflictKind = "explicit" | "duplicate_section";

export interface ConflictResult {
  kind: ConflictKind;
  ids: [string, string];
  message: string;
}

export const DEFAULT_TARGET = "claude_md";
export const DEFAULT_SECTION = "general";
export const DEFAULT_PRIORITY = 50;

export const SECTION_ORDER = [
  "identity",
  "context",
  "guidelines",
  "patterns",
  "conventions",
  "tools",
  "workflows",
  "constraints",
  "general",
] as const;

const SECTION_SET: ReadonlySet<string> = new Set(SECTION_ORDER);

const SECTION_HEADING_PREFIX = "## ";
const SECTION_SEPARATOR = "\n\n";

const SNIPPET_MARKER_RE = /<!--\s*snippet:\s*([^\s>][^>]*?)\s*-->/g;

function renderSnippetMarker(id: string): string {
  return `<!-- snippet: ${id} -->`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Standard-Trenner zwischen Snippets; Dateien können mit der Direktive
// `# cola-snippet-separator: <token>` auf einen anderen Trenner umstellen,
// damit Snippet-Bodies literal `---` enthalten dürfen (z. B. Skill-Templates,
// die YAML-Frontmatter zum Einfügen aufbauen). Die Direktivzeile wird entfernt.
const DEFAULT_SEPARATOR = "\n---\n";
const SEPARATOR_DIRECTIVE_RE = /^#\s*cola-snippet-separator:\s*(\S.*?)\s*(?:\r?\n|$)/;

function resolveSeparator(raw: string): { separator: string; openMarker: string; body: string } {
  const m = raw.match(SEPARATOR_DIRECTIVE_RE);
  if (!m) return { separator: DEFAULT_SEPARATOR, openMarker: "---", body: raw };
  const token = m[1]!;
  return { separator: `\n${token}\n`, openMarker: token, body: raw.slice(m[0].length) };
}

export function parseSnippetFile(raw: string, filename: string): SnippetMeta[] {
  const out: SnippetMeta[] = [];
  // YAML-artige Frontmatter, damit die Dateien in jedem Markdown-Viewer lesbar
  // sind. Jedes Snippet wechselt: OPEN, Frontmatter, OPEN, Body. CRLF wird
  // normalisiert, damit auf Windows geschriebene Dateien parsen.
  const normalized = raw.replace(/\r\n/g, "\n");
  const { separator, openMarker, body: input } = resolveSeparator(normalized);
  const openPrefix = `${openMarker}\n`;
  const blocks = input.split(separator);
  let i = 0;
  while (i < blocks.length) {
    const cur = blocks[i] ?? "";
    if (i === 0 && !cur.startsWith(openMarker)) {
      i += 1;
      continue;
    }
    const fmBlock = cur.startsWith(openPrefix) ? cur.slice(openPrefix.length) : cur;
    const body = blocks[i + 1] ?? "";
    const meta: Record<string, string> = {};
    for (const line of fmBlock.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) meta[m[1]!] = (m[2] ?? "").trim();
    }
    const title = meta.title ?? "(untitled)";
    const rawPriority = meta.priority ? Number(meta.priority) : DEFAULT_PRIORITY;
    const target = meta.target ?? DEFAULT_TARGET;
    out.push({
      id: `${filename}::${title}`.replace(/\s+/g, "-").toLowerCase(),
      file: filename,
      title,
      description: meta.description,
      target,
      section: meta.section ?? DEFAULT_SECTION,
      priority: Number.isFinite(rawPriority) ? rawPriority : DEFAULT_PRIORITY,
      mode: resolveMode(meta.mode, target),
      tags: parseListField(meta.tags),
      conflicts: parseListField(meta.conflicts),
      body: body.trim(),
    });
    i += 2;
  }
  return out;
}

export interface MergeResult {
  content: string;
  modifiedSections: string[];
  appendedSections: string[];
}

// In-place Section-Management: existiert eine `## section`-Überschrift, werden
// die Snippet-Bodies ans Ende dieser Section eingefügt (vor der nächsten `## `
// oder EOF); sonst wird die Section mit frischer Überschrift ans Datei-Ende
// gehängt. Re-Apply verdoppelt die `## section`-Überschrift nicht.
export function mergeSnippetsInPlace(existing: string, picked: SnippetMeta[]): MergeResult {
  if (picked.length === 0) return { content: existing, modifiedSections: [], appendedSections: [] };
  const grouped = new Map<string, SnippetMeta[]>();
  for (const s of picked) {
    const arr = grouped.get(s.section) ?? [];
    arr.push(s);
    grouped.set(s.section, arr);
  }
  for (const arr of grouped.values()) arr.sort((a, b) => a.priority - b.priority);

  const unknownSections = [...grouped.keys()].filter((sec) => !SECTION_SET.has(sec));
  const orderedSections = [...SECTION_ORDER, ...unknownSections];

  let content = existing;
  const modifiedSections: string[] = [];
  const appendedSections: string[] = [];

  for (const sec of orderedSections) {
    const arr = grouped.get(sec);
    if (!arr) continue;
    const renderedBlocks = arr.map((s) => `${renderSnippetMarker(s.id)}\n${s.body}`).join(SECTION_SEPARATOR);
    const headerIdx = findSectionHeaderIndex(content, sec);
    if (headerIdx === -1) {
      const sep = content.trim() === "" ? "" : `${content.trimEnd()}${SECTION_SEPARATOR}`;
      content = `${sep}${SECTION_HEADING_PREFIX}${sec}\n\n${renderedBlocks}\n`;
      appendedSections.push(sec);
    } else {
      const sectionEnd = findNextSectionIndex(content, headerIdx);
      const before = content.slice(0, sectionEnd).trimEnd();
      const after = sectionEnd === content.length ? "" : content.slice(sectionEnd);
      content = `${before}${SECTION_SEPARATOR}${renderedBlocks}\n${after.startsWith("\n") ? "" : "\n"}${after}`;
      modifiedSections.push(sec);
    }
  }
  return { content, modifiedSections, appendedSections };
}

function findSectionHeaderIndex(content: string, section: string): number {
  const re = new RegExp(`^${escapeRegex(SECTION_HEADING_PREFIX)}${escapeRegex(section)}\\s*$`, "im");
  const m = re.exec(content);
  return m ? m.index : -1;
}

function findNextSectionIndex(content: string, fromIdx: number): number {
  const re = /\n##\s+/g;
  re.lastIndex = fromIdx + 1;
  const m = re.exec(content);
  return m ? m.index : content.length;
}

export interface FilterOpts {
  query?: string;
  tags?: Iterable<string>;
  category?: string;
  target?: string;
}

// Reiner prädikatbasierter Filter über den Katalog. Leerer Filter lässt alles
// durch. Tag-Filter ist OR; query trifft Titel/Beschreibung/Tags (case-insens.).
export function filterSnippets(snippets: SnippetMeta[], opts: FilterOpts): SnippetMeta[] {
  const tagSet = new Set(opts.tags ?? []);
  const needle = opts.query?.trim().toLowerCase() ?? "";
  const { category, target } = opts;
  if (tagSet.size === 0 && needle === "" && !category && !target) return snippets;
  return snippets.filter((s) => {
    if (category && !matchesCategory(s, category)) return false;
    if (target && s.target !== target) return false;
    if (tagSet.size > 0 && !s.tags.some((t) => tagSet.has(t))) return false;
    if (needle === "") return true;
    return (
      s.title.toLowerCase().includes(needle) ||
      (s.description ?? "").toLowerCase().includes(needle) ||
      s.tags.some((t) => t.toLowerCase().includes(needle))
    );
  });
}

function matchesCategory(s: SnippetMeta, category: string): boolean {
  return s.file.startsWith(`${category}/`) || s.file === `${category}.txt` || s.file.startsWith(`${category}-`);
}

// Snippets, die laut ID-Marker bereits in der Datei stehen (Re-Apply-Schutz).
export function detectDuplicates(existing: string, picked: SnippetMeta[]): SnippetMeta[] {
  const present = new Set<string>();
  for (const m of existing.matchAll(SNIPPET_MARKER_RE)) present.add(m[1]!);
  return picked.filter((s) => present.has(s.id));
}

// Konflikte zwischen ausgewählten Snippets: explizit (Frontmatter conflicts:)
// oder gleiche section+target (Duplicate-Section-Hinweis). Jedes Paar einmal.
export function checkConflicts(picked: SnippetMeta[]): ConflictResult[] {
  const out: ConflictResult[] = [];
  const byId = new Map(picked.map((s) => [s.id, s]));
  const seenPairs = new Set<string>();

  for (const a of picked) {
    const seenForA = new Set<string>();
    for (const otherId of a.conflicts) {
      if (otherId === a.id || seenForA.has(otherId)) continue;
      seenForA.add(otherId);
      if (!byId.has(otherId)) continue;
      const key = pairKey(a.id, otherId);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const [first, second] = orderIds(a.id, otherId);
      out.push({ kind: "explicit", ids: [first, second], message: `${first} widerspricht ${second}` });
    }
  }

  const buckets = new Map<string, SnippetMeta[]>();
  for (const s of picked) {
    const k = `${s.target}::${s.section}`;
    const arr = buckets.get(k) ?? [];
    arr.push(s);
    buckets.set(k, arr);
  }
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const a = arr[i]!;
        const b = arr[j]!;
        const key = pairKey(a.id, b.id);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const [first, second] = orderIds(a.id, b.id);
        out.push({
          kind: "duplicate_section",
          ids: [first, second],
          message: `${first} und ${second} zielen beide auf ${a.target} :: ${a.section}`,
        });
      }
    }
  }
  return out;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function orderIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function resolveMode(raw: string | undefined, target: string): SnippetMode {
  if (raw === "write" || raw === "copy") return raw;
  return target === DEFAULT_TARGET ? "write" : "copy";
}

function parseListField(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const balanced = trimmed.startsWith("[") && trimmed.endsWith("]");
  const inner = balanced ? trimmed.slice(1, -1) : trimmed;
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

// --- Katalog-Laden + Datei-Apply -------------------------------------------

// Snippet-Verzeichnis relativ zum kompilierten Modul (dist/composer.js ->
// ../snippets = repo/snippets; via files:["snippets"] auch im npm-Paket).
export function defaultSnippetDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "snippets");
}

interface CatalogCache {
  key: string;
  value: SnippetMeta[];
}
const catalogCache: CatalogCache = { key: "", value: [] };

// Katalog laden, mtime-gekeyt gecacht. Fehlt das Verzeichnis, leeres Array.
export async function loadCatalog(dir: string = defaultSnippetDir()): Promise<SnippetMeta[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".txt")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const stats = await Promise.all(files.map((f) => fs.stat(join(dir, f))));
  const cacheKey = files.map((f, i) => `${f}:${stats[i]!.mtimeMs}`).join("|");
  if (cacheKey === catalogCache.key) return catalogCache.value;
  const contents = await Promise.all(files.map((f) => fs.readFile(join(dir, f), "utf8")));
  const all: SnippetMeta[] = [];
  for (let i = 0; i < files.length; i += 1) all.push(...parseSnippetFile(contents[i]!, files[i]!));
  catalogCache.key = cacheKey;
  catalogCache.value = all;
  return all;
}

export interface ResolvedSnippets {
  picked: SnippetMeta[];
  missing: string[];
  writeOnly: SnippetMeta[];
  copyOnly: SnippetMeta[];
}

export function resolveSnippetsByIds(catalog: SnippetMeta[], ids: string[]): ResolvedSnippets {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const picked: SnippetMeta[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) picked.push(s);
    else missing.push(id);
  }
  return {
    picked,
    missing,
    writeOnly: picked.filter((s) => s.mode === "write"),
    copyOnly: picked.filter((s) => s.mode === "copy"),
  };
}

export interface ApplyResult {
  written: boolean;
  existingChars: number;
  newContent: string;
  newChars: number;
  modifiedSections: string[];
  appendedSections: string[];
}

// Datei lesen (fehlend = leer), write-Snippets mergen, optional schreiben.
// Vor dem Schreiben eine `.bak`-Kopie des Vorher-Stands (Wiederherstellung),
// da hier in die echte CLAUDE.md des Nutzers geschrieben wird.
export async function applySnippetsToFile(
  targetPath: string,
  picked: SnippetMeta[],
  opts: { dryRun?: boolean } = {},
): Promise<ApplyResult> {
  let existing = "";
  try {
    existing = await fs.readFile(targetPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const merge = mergeSnippetsInPlace(existing, picked.filter((s) => s.mode === "write"));
  if (!opts.dryRun) {
    await fs.mkdir(dirname(targetPath), { recursive: true });
    if (existing !== "") await fs.writeFile(`${targetPath}.bak`, existing, "utf8");
    await fs.writeFile(targetPath, merge.content, "utf8");
  }
  return {
    written: !opts.dryRun,
    existingChars: existing.length,
    newContent: merge.content,
    newChars: merge.content.length,
    modifiedSections: merge.modifiedSections,
    appendedSections: merge.appendedSections,
  };
}
