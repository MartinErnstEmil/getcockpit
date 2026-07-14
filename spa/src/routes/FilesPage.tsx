import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DEFAULT_ACTIVE_DAYS } from "@/lib/scope";
import { useScope } from "@/lib/useScope";
import { useComposerApply, useConfig, useConfigDetail, useConfigSnapshot, useFile, useSnippets, useWriteFile } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { fileHref, vscHref } from "@/lib/linkify";
import { cn, shortName } from "@/lib/utils";
import type { ComposerApplyResult, ConfigDiff, ConfigEntry, ConfigKind, ConfigSnapshotMeta, SnippetMeta } from "@/api/types";

// /files — "Gedächtnis & Regeln" (cola2-Config-Struktur beibehalten): je
// Projekt die CLAUDE.md mit Zeichen-Budget und Git-Diff. Mit ?path= der interne
// Datei-Viewer, mit ?compose= der Config-Baukasten (U6).
export default function FilesPage() {
  const [params] = useSearchParams();
  const path = params.get("path");
  const compose = params.get("compose");
  if (compose !== null) return <ComposerPane target={compose} />;
  if (path) return <FileViewer path={path} line={Number(params.get("line")) || null} project={params.get("project")} />;
  return <ConfigOverview />;
}

// Dateiname je Art — bewusst genau die echten Basenamen (Wiedererkennung).
const KIND_LABEL: Record<ConfigKind, string> = {
  "claude-md": "CLAUDE.md",
  "memory-md": "MEMORY.md",
  settings: "settings.json",
};

interface ProjectGroup {
  key: string;
  projectPath: string | null;
  label: string;
  entries: ConfigEntry[];
  hasExisting: boolean;
  nearFull: boolean;
}

// nahe am Limit = Overview-Schwelle (unter 10% frei) ODER drueber.
function isNearFull(e: ConfigEntry): boolean {
  return e.budget != null && e.remaining != null && e.remaining < e.budget * 0.1;
}

// Sortierung: Global zuerst; dann Projekte mit knappem Budget vor dem Rest.
function sortGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return [...groups].sort((a, b) => {
    if (a.projectPath === null) return -1;
    if (b.projectPath === null) return 1;
    if (a.nearFull !== b.nearFull) return a.nearFull ? -1 : 1;
    return a.label.localeCompare(b.label, "de");
  });
}

// Flache Config-Liste nach Projekt gruppieren, Reihenfolge aus dem Server
// beibehalten (Global zuerst). null-projectPath = global.
function groupByProject(entries: ConfigEntry[]): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  const byKey = new Map<string, ProjectGroup>();
  for (const e of entries) {
    const key = e.projectPath ?? "__global__";
    let g = byKey.get(key);
    if (!g) {
      g = { key, projectPath: e.projectPath, label: e.projectPath ? shortName(e.projectPath) : "Global", entries: [], hasExisting: false, nearFull: false };
      byKey.set(key, g);
      groups.push(g);
    }
    g.entries.push(e);
    if (e.exists) g.hasExisting = true;
    if (isNearFull(e)) g.nearFull = true;
  }
  return groups;
}

function ConfigOverview() {
  const { scope } = useScope();
  const q = useConfig(scope);
  const [filter, setFilter] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);

  const entries = useMemo(() => q.data?.entries ?? [], [q.data]);
  const allGroups = useMemo(() => sortGroups(groupByProject(entries)), [entries]);
  const configured = useMemo(() => allGroups.filter((g) => g.hasExisting), [allGroups]);
  const emptyCount = allGroups.length - configured.length;
  const overBudget = entries.filter((e) => e.exists && e.remaining != null && e.remaining < 0).length;

  const base = showEmpty ? allGroups : configured;
  const f = filter.trim().toLowerCase();
  const shown = f ? base.filter((g) => g.label.toLowerCase().includes(f) || (g.projectPath ?? "").toLowerCase().includes(f)) : base;

  if (q.error) return <div className="p-5"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <ConfigSkeleton />;

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="text-[15px] font-semibold">
        Gedächtnis & Regeln
        <span className="ml-2 text-xs font-normal text-ink-2">CLAUDE.md · MEMORY.md · settings.json — Budget, Diff & Verlauf je Datei</span>
      </h2>
      <p className="mt-1 text-xs text-ink-2">
        {configured.length} mit Konfiguration · {emptyCount} ohne
        {overBudget > 0 && <span className="text-crit"> · {overBudget} über Budget</span>}
      </p>

      <div className="my-3 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(ev) => setFilter(ev.target.value)}
          placeholder="Projekt filtern…"
          aria-label="Projekt filtern"
          className="ds-field !w-56 !py-1 text-sm"
        />
        {emptyCount > 0 && (
          <button
            type="button"
            onClick={() => setShowEmpty((s) => !s)}
            aria-pressed={showEmpty}
            className="ds-btn-ghost border border-line !px-3 text-xs"
          >
            {showEmpty ? "Projekte ohne Konfiguration ausblenden" : `Alle anzeigen (${emptyCount} ohne Konfiguration)`}
          </button>
        )}
      </div>

      {allGroups.length === 0 ? (
        <p className="italic text-ink-2">Keine Projekte erfasst.</p>
      ) : shown.length === 0 ? (
        <p className="italic text-ink-2">Kein Projekt passt zum Filter „{filter}".</p>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((g) => <ConfigGroupCard key={g.key} g={g} />)}
        </div>
      )}
    </div>
  );
}

// Distinkter Ladezustand (kein „leer"-Signal für eine gleich gefüllte Liste).
function ConfigSkeleton() {
  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5" aria-busy="true" aria-label="Lädt Konfiguration">
      <div className="mb-4 h-4 w-64 animate-pulse bg-surface-container" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="ds-card px-4 py-3">
            <div className="mb-3 h-4 w-40 animate-pulse bg-surface-container" />
            <div className="h-3 w-full max-w-[420px] animate-pulse bg-surface-container" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigGroupCard({ g }: { g: ProjectGroup }) {
  return (
    <div className="ds-card px-4 py-3">
      {/* Sticky-Header: bleibt beim Scrollen langer Gruppen sichtbar. */}
      <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-baseline gap-2 border-b border-line bg-surface px-4 pb-2 text-sm font-semibold">
        {g.label}
        {g.nearFull && <span className="ds-tag bg-crit/15 text-crit">Budget knapp</span>}
      </div>
      <div className="flex flex-col divide-y divide-line">
        {g.entries.map((e) => <ConfigFileRow key={e.file} e={e} />)}
      </div>
    </div>
  );
}

function ConfigFileRow({ e }: { e: ConfigEntry }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const composeTarget = e.projectPath ?? "global";
  const detailId = `detail-${e.file}`;
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="ds-tag">{KIND_LABEL[e.kind]}</span>
        {/* read-only ist ein erwarteter Info-Zustand, kein Warnsignal: neutral. */}
        {!e.editable && <span className="ds-tag">read-only</span>}
        {e.exists ? (
          <Link to={fileHref(e.file)} className="font-mono text-xs text-accent underline decoration-dotted">{e.file}</Link>
        ) : (
          <span className="font-mono text-xs text-ink-2">
            {e.file} — {e.kind === "claude-md" ? "noch keine, anlegen ▸" : "nicht vorhanden"}
          </span>
        )}
        {e.exists && (
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            aria-expanded={open}
            aria-controls={detailId}
            className="ds-btn-ghost border border-line !px-2.5 text-xs"
          >
            {open ? "Details ausblenden" : e.historyCount > 1 ? `Details · Verlauf (${e.historyCount})` : "Details"}
          </button>
        )}
        {e.kind === "claude-md" && (
          <button
            type="button"
            onClick={() => navigate(`/files?compose=${encodeURIComponent(composeTarget)}`)}
            className="ds-btn-ghost border border-line ml-auto !px-3 text-xs"
          >
            Baukasten öffnen
          </button>
        )}
      </div>
      {e.exists && e.budget != null && e.remaining != null && <BudgetBar chars={e.chars} budget={e.budget} remaining={e.remaining} />}
      {e.exists && e.budget == null && (
        <div className="mt-1.5 text-xs text-ink-2">{e.chars.toLocaleString("de-DE")} Zeichen</div>
      )}
      {open && <div id={detailId}><DetailPanel file={e.file} /></div>}
    </div>
  );
}

function BudgetBar({ chars, budget, remaining }: { chars: number; budget: number; remaining: number }) {
  const over = remaining < 0;
  const pct = Math.min(100, Math.round((chars / budget) * 100));
  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="h-1.5 w-48 bg-surface-container">
        <div className={cn("h-full", over ? "bg-crit" : pct > 80 ? "bg-warn" : "bg-ok")} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("text-xs tabular-nums", over ? "font-semibold text-crit" : "text-ink-2")}>
        {chars.toLocaleString("de-DE")} / {budget.toLocaleString("de-DE")} Zeichen
        {over ? ` · ${Math.abs(remaining).toLocaleString("de-DE")} drüber` : ` · ${remaining.toLocaleString("de-DE")} frei`}
      </span>
    </div>
  );
}

// --- Detail (lazy) ----------------------------------------------------------
// Beim Aufklappen einer Zeile geholt: uncommitted-Git-Diff + Versions-Zeitleiste.
// Beides erst hier (nicht im Overview), damit /api/config keine git-Spawns macht.

function DetailPanel({ file }: { file: string }) {
  const q = useConfigDetail(file);
  if (q.error) return <div className="mt-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <div className="mt-2 text-xs text-ink-2">Details laden…</div>;
  const snaps = q.data?.snapshots ?? [];
  return (
    <div className="mt-2 flex flex-col gap-2">
      <UncommittedDiff diff={q.data?.diff ?? null} />
      {snaps.length > 0 && <Timeline snaps={snaps} />}
    </div>
  );
}

function UncommittedDiff({ diff }: { diff: ConfigDiff | null }) {
  if (!diff) return <div className="text-xs italic text-ink-2">kein Git-Repo — ungesicherte Änderungen nicht ermittelbar</div>;
  if (diff.untracked) return <div className="text-xs text-warn">nicht in Git erfasst — gesamte Datei zählt als „neu"</div>;
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return <div className="text-xs text-ink-2">keine ungesicherten Änderungen seit dem letzten Commit</div>;
  }
  return (
    <div className="max-h-56 overflow-y-auto border border-line bg-ground px-3 py-2 font-mono text-xs leading-relaxed">
      <div className="mb-1 text-ink-2">ungesichert seit letztem Commit: +{diff.added.length} / −{diff.removed.length} Zeilen</div>
      {diff.removed.map((l, i) => <div key={`r${i}`} className="whitespace-pre-wrap text-crit">− {l}</div>)}
      {diff.added.map((l, i) => <div key={`a${i}`} className="whitespace-pre-wrap text-ok">+ {l}</div>)}
    </div>
  );
}

// --- Versionshistorie (v7) --------------------------------------------------
// Zeitleiste der erfassten Stände; Klick zeigt den Diff zum Vorgänger.

function Timeline({ snaps }: { snaps: ConfigSnapshotMeta[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="border border-line bg-ground px-3 py-2">
      <div className="mb-1.5 text-xs text-ink-2">
        {snaps.length} erfasste {snaps.length === 1 ? "Version" : "Versionen"} (neueste zuerst)
        {snaps.length > 1 && " — auf einen Stand klicken zeigt den Diff zum Vorgänger:"}
      </div>
      <div className="flex flex-col gap-0.5">
        {snaps.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSelected((cur) => (cur === s.id ? null : s.id))}
            aria-pressed={selected === s.id}
            className={cn("flex items-baseline gap-3 px-2 py-1 text-left text-xs hover:bg-hl", selected === s.id && "bg-hl")}
          >
            <span className="tabular-nums text-ink-1">{new Date(s.at).toLocaleString("de-DE")}</span>
            <span className="tabular-nums text-ink-2">{s.chars.toLocaleString("de-DE")} Zeichen</span>
          </button>
        ))}
      </div>
      {selected != null && <SnapshotDiff id={selected} />}
    </div>
  );
}

function SnapshotDiff({ id }: { id: number }) {
  const q = useConfigSnapshot(id);
  if (q.error) return <div className="mt-2"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <div className="mt-2 text-xs text-ink-2">Diff lädt…</div>;
  if (!q.data) return null;
  if (q.data.prevContent === null) {
    return <div className="mt-2 text-xs italic text-ink-2">Erster erfasster Stand — kein Vorgänger zum Vergleichen.</div>;
  }
  const rows = lineDiff(q.data.prevContent, q.data.content);
  if (rows.every((r) => r.t === " ")) {
    return <div className="mt-2 text-xs text-ink-2">Keine Zeilenänderung gegenüber dem Vorgänger.</div>;
  }
  return (
    <div className="mt-2 max-h-72 overflow-auto border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed">
      {renderHunks(rows)}
    </div>
  );
}

// Änderungen MIT etwas Kontext: unveränderte Zeilen fern jeder Änderung werden zu
// einem „N Zeilen"-Marker zusammengefasst, statt den Diff kontextlos zu zeigen.
const DIFF_CONTEXT = 2;
function renderHunks(rows: DiffLine[]): ReactNode {
  // Ein Durchlauf: jede Änderung markiert ihr Kontextfenster [i-CTX, i+CTX] als
  // sichtbar (statt für jede Zeile alle Zeilen zu scannen, O(n) statt O(n^2)).
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.t === " ") return;
    for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(rows.length - 1, i + DIFF_CONTEXT); k++) keep[k] = true;
  });
  const out: ReactNode[] = [];
  let skipped = 0;
  const flush = (key: string) => {
    if (skipped > 0) out.push(<div key={key} className="select-none text-ink-2">··· {skipped} unveränderte {skipped === 1 ? "Zeile" : "Zeilen"}</div>);
    skipped = 0;
  };
  rows.forEach((r, i) => {
    if (!keep[i]) { skipped++; return; }
    flush(`s${i}`);
    const cls = r.t === "+" ? "text-ok" : r.t === "-" ? "text-crit" : "text-ink-2";
    out.push(<div key={i} className={cn("whitespace-pre-wrap", cls)}>{r.t} {r.text}</div>);
  });
  flush("s-end");
  return out;
}

type DiffLine = { t: " " | "+" | "-"; text: string };

// Kompakter LCS-Zeilendiff zweier Versionen. Bei sehr großen Dateien (O(n·m)
// Speicher) auf eine grobe Anhängen/Entfernen-Sicht ausweichen, statt zu blockieren.
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length > 2000 || B.length > 2000) {
    return [...A.map((t): DiffLine => ({ t: "-", text: t })), ...B.map((t): DiffLine => ({ t: "+", text: t }))];
  }
  const dp = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) out.push({ t: " ", text: A[i++]! }), j++;
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: "-", text: A[i++]! });
    else out.push({ t: "+", text: B[j++]! });
  }
  while (i < A.length) out.push({ t: "-", text: A[i++]! });
  while (j < B.length) out.push({ t: "+", text: B[j++]! });
  return out;
}

function FileViewer({ path, line, project }: { path: string; line: number | null; project: string | null }) {
  const q = useFile(path, project);
  const write = useWriteFile();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  if (q.error) return <div className="p-5"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  const content = q.data?.content ?? "";
  const lines = content.split("\n");
  // Gekürzte Dateien (>512 KB) dürfen NICHT editiert werden — Speichern würde
  // den vollen Inhalt durch den gekürzten ersetzen (Datenverlust). Ob eine Datei
  // schreibbar ist, entscheidet ALLEIN der Server (q.data.writable) — die SPA
  // kopiert die Deny-Liste nicht mehr nach.
  const canEdit = !!q.data?.file && !q.data.truncated && (q.data?.writable ?? false);

  const startEdit = () => { setDraft(content); setEditing(true); setSaved(false); };
  const save = () => {
    if (!q.data?.file) return;
    // Der AUFGELÖSTE Absolutpfad geht zurück — nicht der (evtl. veraltete)
    // Anfrage-Pfad; so trifft das Schreiben exakt die angezeigte Datei.
    write.mutate({ path: q.data.file, content: draft }, {
      onSuccess: () => { setEditing(false); setSaved(true); void q.refetch(); setTimeout(() => setSaved(false), 2500); },
    });
  };

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 flex flex-wrap items-baseline gap-2 text-[15px] font-semibold">
        <Link to="/files" className="text-accent underline">Gedächtnis & Regeln</Link>
        {/* Pfad klickbar: öffnet die Datei direkt in VS Code (vscode://file/…)
            — file://-Links blockiert der Browser von http-Seiten aus. */}
        {q.data?.file && (
          <a
            href={vscHref(q.data.file, project, line ?? undefined)}
            title="In VS Code öffnen"
            className="font-mono text-xs font-normal text-accent underline decoration-dotted"
          >
            {q.data.file}
          </a>
        )}
        {q.data?.truncated && <span className="ds-tag">gekürzt auf 512 KB</span>}
        {!editing && canEdit && (
          <button type="button" onClick={startEdit} className="ds-btn-ghost border border-line ml-auto !px-3 text-xs">
            Bearbeiten
          </button>
        )}
        {saved && <span className="ml-auto text-xs text-ok">Gespeichert.</span>}
      </h2>

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="ds-field min-h-[60vh] w-full resize-y font-mono text-xs leading-relaxed"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={write.isPending} onClick={save} className="ds-btn-primary">
              {write.isPending ? "Speichert…" : "Speichern"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="ds-btn-ghost border border-line">
              Abbrechen
            </button>
            {write.isError && (
              <span className="text-xs text-crit">
                {write.error instanceof Error ? write.error.message : "Fehler"} — erneut versuchen.
              </span>
            )}
            <span className="ml-auto text-xs text-ink-2">Vorher-Stand wird als Backup in ~/.cockpit gesichert.</span>
          </div>
        </div>
      ) : (
        <>
          <div className="ds-card overflow-x-auto px-0 py-2 font-mono text-xs leading-relaxed">
            {lines.map((l, i) => (
              <div key={i} className={cn("flex gap-3 px-3", line === i + 1 && "bg-hl")}>
                <span className="w-10 shrink-0 select-none text-right tabular-nums text-ink-2">{i + 1}</span>
                <span className="whitespace-pre-wrap">{l}</span>
              </div>
            ))}
          </div>
          {q.data?.truncated && (
            <p className="mt-2 text-xs text-warn">
              Datei ist gekürzt angezeigt (über 512 KB) — Bearbeiten ist deaktiviert, um Datenverlust zu vermeiden.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// --- Config-Baukasten (U6) --------------------------------------------------
// Kuratierte Best-Practice-Snippets klickbar in die CLAUDE.md mergen. Alleinstellung
// im Cockpit: die Vorschau zeigt VOR dem Schreiben, was das Zeichen-Budget kostet.

const STARTER_FILE = "claude-md-base.txt"; // "Empfohlenes Starter-Set" für Vibecoder
const SNIPPET_MARKER_RE = /<!--\s*snippet:\s*([^\s>][^>]*?)\s*-->/g;

function markerIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const m of content.matchAll(SNIPPET_MARKER_RE)) ids.add(m[1]!);
  return ids;
}

function ComposerPane({ target }: { target: string }) {
  const project = target === "global" ? "" : target;
  const snippetsQ = useSnippets();
  const configQ = useConfig({ mode: "all", project: "", days: DEFAULT_ACTIVE_DAYS });
  const preview = useComposerApply();
  const doApply = useComposerApply();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [previewData, setPreviewData] = useState<ComposerApplyResult | null>(null);

  const all = snippetsQ.data?.snippets ?? [];
  const entry = (configQ.data?.entries ?? []).find(
    (e) => e.kind === "claude-md" && (project ? e.projectPath === project : e.projectPath === null),
  );
  const budget = entry?.budget ?? 10_000;
  const fileQ = useFile(entry?.exists ? entry.file : null);
  const existingIds = useMemo(() => markerIds(fileQ.data?.content ?? ""), [fileQ.data?.content]);

  const writeSnippets = all.filter((s) => s.mode === "write");
  const copySnippets = all.filter((s) => s.mode === "copy");
  const filtered = filterByQuery(writeSnippets, query);

  // Duplicate-Section-Hinweis (client-seitig): mehrere gewählte Snippets in
  // derselben Section — kein Fehler, nur ein Hinweis (wie cola checkConflicts).
  const dupSections = useMemo(() => sectionsWithMultiple([...selected], writeSnippets), [selected, writeSnippets]);

  const idsKey = [...selected].sort().join(",");
  useEffect(() => {
    if (selected.size === 0) { setPreviewData(null); return; }
    preview.mutate({ project, snippetIds: [...selected], dryRun: true }, { onSuccess: setPreviewData });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, project]);

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectStarter = () => setSelected(new Set(writeSnippets.filter((s) => s.file === STARTER_FILE).map((s) => s.id)));

  const applyNow = () => {
    if (!entry) return;
    if (!window.confirm(`Ausgewählte Regeln in ${entry.file} schreiben? Der bisherige Stand wird als .bak gesichert.`)) return;
    doApply.mutate({ project, snippetIds: [...selected], dryRun: false }, {
      onSuccess: () => { setSelected(new Set()); setPreviewData(null); void fileQ.refetch(); },
    });
  };

  if (snippetsQ.error) return <div className="p-5"><ErrorBox error={snippetsQ.error} onRetry={() => void snippetsQ.refetch()} /></div>;
  if (snippetsQ.isLoading) return <EmptyState title="Lädt…" />;

  const newPct = previewData ? Math.min(100, Math.round((previewData.newChars / budget) * 100)) : 0;
  const over = previewData ? previewData.newChars > budget : false;

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-1 flex flex-wrap items-baseline gap-2 text-[15px] font-semibold">
        <Link to="/files" className="text-accent underline">Gedächtnis & Regeln</Link>
        <span>Baukasten · {project ? shortName(project) : "Global"}</span>
        {entry && <span className="font-mono text-xs font-normal text-ink-2">{entry.file}</span>}
      </h2>
      <p className="mb-3 max-w-[74ch] text-xs text-ink-2">
        Kuratierte Best-Practice-Regeln auswählen und in die CLAUDE.md schreiben. Die Vorschau zeigt vorab,
        was die Auswahl das Zeichen-Budget kostet. Regeln werden per Abschnitt eingefügt; bereits vorhandene
        werden erkannt und nicht doppelt geschrieben.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Regeln durchsuchen…"
          className="ds-field !w-64 !py-1 text-sm"
        />
        <button type="button" onClick={selectStarter} className="ds-btn-ghost border border-line !px-3 text-xs">
          Empfohlenes Starter-Set
        </button>
        {selected.size > 0 && (
          <button type="button" onClick={() => setSelected(new Set())} className="ds-btn-ghost !px-3 text-xs text-ink-2">
            Auswahl leeren ({selected.size})
          </button>
        )}
      </div>

      {previewData && (
        <div className="ds-card mb-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">Vorschau</span>
            <div className="h-1.5 w-48 bg-surface-container">
              <div className={cn("h-full", over ? "bg-crit" : newPct > 80 ? "bg-warn" : "bg-ok")} style={{ width: `${newPct}%` }} />
            </div>
            <span className={cn("text-xs tabular-nums", over ? "font-semibold text-crit" : "text-ink-2")}>
              {previewData.existingChars.toLocaleString("de-DE")} → {previewData.newChars.toLocaleString("de-DE")} / {budget.toLocaleString("de-DE")} Zeichen
              {" "}(+{(previewData.newChars - previewData.existingChars).toLocaleString("de-DE")})
            </span>
          </div>
          {over && <p className="mt-1 text-xs text-crit">Über Budget — du kannst trotzdem schreiben, aber die Regeln kosten dann in jeder Session mehr Kontext.</p>}
          {dupSections.length > 0 && (
            <p className="mt-1 text-xs text-warn">Mehrere Regeln im selben Abschnitt ({dupSections.join(", ")}) — Absicht? Sie werden zusammengeführt.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={doApply.isPending || !entry} onClick={applyNow} className="ds-btn-primary">
              {doApply.isPending ? "Schreibt…" : "In CLAUDE.md schreiben"}
            </button>
            {doApply.isSuccess && !doApply.isPending && <span className="text-xs text-ok">Geschrieben — Vorher-Stand als .bak gesichert.</span>}
            {doApply.isError && <span className="text-xs text-crit">Konnte nicht geschrieben werden — erneut versuchen.</span>}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {filtered.length === 0 ? (
          <p className="italic text-ink-2">Keine passenden Regeln.</p>
        ) : (
          filtered.map((s) => (
            <SnippetRow key={s.id} s={s} checked={selected.has(s.id)} inFile={existingIds.has(s.id)} onToggle={() => toggle(s.id)} />
          ))
        )}
      </div>

      {copySnippets.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-1 text-sm font-semibold">Vorlagen zum Kopieren</h3>
          <p className="mb-2 max-w-[74ch] text-xs text-ink-2">
            Für settings.json, MEMORY.md und Skills schreibt der Baukasten nicht automatisch (diese Dateien pflegt
            Cockpit bzw. Claude Code selbst) — hier zum Kopieren und manuellen Einfügen.
          </p>
          <div className="flex flex-col gap-1.5">
            {copySnippets.map((s) => <CopyRow key={s.id} s={s} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SnippetRow({ s, checked, inFile, onToggle }: { s: SnippetMeta; checked: boolean; inFile: boolean; onToggle: () => void }) {
  return (
    <label className={cn("ds-card flex cursor-pointer items-start gap-3 px-4 py-2.5", checked && "border-accent bg-accent/5")}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{s.title}</span>
          <span className="ds-tag">{s.section}</span>
          {inFile && <span className="ds-tag bg-ok/15 text-ok">schon in Datei</span>}
        </span>
        {s.description && <span className="block text-xs text-ink-2">{s.description}</span>}
      </span>
    </label>
  );
}

function CopyRow({ s }: { s: SnippetMeta }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard kann blockiert sein — still bleiben, Body steht in der Karte.
    }
  };
  return (
    <div className="ds-card flex items-start gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{s.title}</span>
          <span className="ds-tag">{s.target}</span>
        </span>
        {s.description && <span className="block text-xs text-ink-2">{s.description}</span>}
      </span>
      <button type="button" onClick={() => void copy()} className="ds-btn-ghost border border-line shrink-0 !px-3 text-xs">
        {copied ? "Kopiert!" : "Kopieren"}
      </button>
    </div>
  );
}

function filterByQuery(snippets: SnippetMeta[], query: string): SnippetMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return snippets;
  return snippets.filter((s) =>
    s.title.toLowerCase().includes(q) ||
    (s.description ?? "").toLowerCase().includes(q) ||
    s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

function sectionsWithMultiple(selectedIds: string[], snippets: SnippetMeta[]): string[] {
  const byId = new Map(snippets.map((s) => [s.id, s]));
  const counts = new Map<string, number>();
  for (const id of selectedIds) {
    const s = byId.get(id);
    if (s) counts.set(s.section, (counts.get(s.section) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([sec]) => sec);
}
