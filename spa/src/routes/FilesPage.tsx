import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DEFAULT_ACTIVE_DAYS } from "@/lib/scope";
import { useScope } from "@/lib/useScope";
import { useComposerApply, useConfig, useFile, useSnippets, useWriteFile } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import { fileHref, vscHref } from "@/lib/linkify";
import { cn, shortName } from "@/lib/utils";
import type { ComposerApplyResult, ConfigEntry, SnippetMeta } from "@/api/types";

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

function ConfigOverview() {
  const { scope } = useScope();
  const q = useConfig(scope);

  if (q.error) return <div className="p-5"><ErrorBox error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isLoading) return <EmptyState title="Lädt…" />;
  const entries = q.data?.entries ?? [];

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 text-[15px] font-semibold">
        Gedächtnis & Regeln
        <span className="ml-2 text-xs font-normal text-ink-2">CLAUDE.md je Projekt · Zeichen-Budget · ungesicherte Änderungen (Git-Diff)</span>
      </h2>
      {entries.length === 0 ? (
        <p className="italic text-ink-2">Keine Projekte erfasst.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((e) => <ConfigCard key={e.file} e={e} />)}
        </div>
      )}
    </div>
  );
}

function ConfigCard({ e }: { e: ConfigEntry }) {
  const navigate = useNavigate();
  const over = e.remaining < 0;
  const pct = Math.min(100, Math.round((e.chars / e.budget) * 100));
  const composeTarget = e.projectPath ?? "global";
  return (
    <div className="ds-card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold">{e.projectPath ? shortName(e.projectPath) : "Global"}</span>
        {e.exists ? (
          <Link to={fileHref(e.file)} className="font-mono text-xs text-accent underline decoration-dotted">{e.file}</Link>
        ) : (
          <span className="font-mono text-xs text-ink-2">{e.file} — keine CLAUDE.md</span>
        )}
        <button
          type="button"
          onClick={() => navigate(`/files?compose=${encodeURIComponent(composeTarget)}`)}
          className="ds-btn-ghost border border-line ml-auto !px-3 text-xs"
        >
          Baukasten öffnen
        </button>
      </div>
      {e.exists && (
        <>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 w-48 bg-surface-container">
              <div className={cn("h-full", over ? "bg-crit" : pct > 80 ? "bg-warn" : "bg-ok")} style={{ width: `${pct}%` }} />
            </div>
            <span className={cn("text-xs tabular-nums", over ? "font-semibold text-crit" : "text-ink-2")}>
              {e.chars.toLocaleString("de-DE")} / {e.budget.toLocaleString("de-DE")} Zeichen
              {over ? ` · ${Math.abs(e.remaining).toLocaleString("de-DE")} drüber` : ` · ${e.remaining.toLocaleString("de-DE")} frei`}
            </span>
          </div>
          <DiffBlock e={e} />
        </>
      )}
    </div>
  );
}

function DiffBlock({ e }: { e: ConfigEntry }) {
  if (!e.diff) return <div className="mt-1.5 text-xs italic text-ink-2">kein Git-Repo — Diff nicht ermittelbar</div>;
  if (e.diff.untracked) return <div className="mt-1.5 text-xs text-warn">nicht in Git erfasst — gesamte Datei ist „neu"</div>;
  if (e.diff.added.length === 0 && e.diff.removed.length === 0) {
    return <div className="mt-1.5 text-xs text-ink-2">keine ungesicherten Änderungen</div>;
  }
  return (
    <div className="mt-2 max-h-56 overflow-y-auto border border-line bg-ground px-3 py-2 font-mono text-xs leading-relaxed">
      <div className="mb-1 text-ink-2">ungesichert seit letztem Commit: +{e.diff.added.length} / −{e.diff.removed.length} Zeilen</div>
      {e.diff.removed.map((l, i) => <div key={`r${i}`} className="whitespace-pre-wrap text-crit">− {l}</div>)}
      {e.diff.added.map((l, i) => <div key={`a${i}`} className="whitespace-pre-wrap text-ok">+ {l}</div>)}
    </div>
  );
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
  // den vollen Inhalt durch den gekürzten ersetzen (Datenverlust).
  const canEdit = !!q.data?.file && !q.data.truncated;

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
  const entry = (configQ.data?.entries ?? []).find((e) => (project ? e.projectPath === project : e.projectPath === null));
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
