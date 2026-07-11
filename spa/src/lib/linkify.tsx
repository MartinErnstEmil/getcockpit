import { Link } from "react-router-dom";

// Erwähnte Dateipfade klickbar machen (Vorstufe interner Viewer): erkennt
// Windows- (c:/x/y.ts, C:\x\y.ts) und relative Pfade (src/foo.ts:42) in
// Freitext und verlinkt sie auf den Viewer unter /files?path=…&line=….
// Bewusst konservativ: mindestens ein Verzeichnis-Separator UND eine
// Datei-Endung, damit Prosa mit Punkten nicht zerhackt wird.

const PATH_RE =
  /(?:[A-Za-z]:[\\/]|~[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g;

const ABS_RE = /^(?:[A-Za-z]:[\\/]|~[\\/]|[\\/])/;

// Relativpfade brauchen den Projektkontext des Items — der Server ankert sie
// sonst an seiner cwd und liefert 404 oder die falsche Datei (Kollision).
export function fileHref(path: string, line?: number, project?: string | null): string {
  const p = new URLSearchParams({ path });
  if (line != null) p.set("line", String(line));
  if (project && !ABS_RE.test(path)) p.set("project", project);
  return `/files?${p.toString()}`;
}

// Raw-Ansicht (Verlauf): Dateipfade öffnen direkt in VS Code. Relativpfade
// werden client-seitig gegen die Projektwurzel der Session aufgelöst —
// vscode://file/ braucht absolute Pfade.
export function vscHref(path: string, project?: string | null, line?: number): string {
  let p = path.replace(/\\/g, "/");
  if (!ABS_RE.test(p) && project) p = `${project.replace(/\/+$/, "")}/${p}`;
  return `vscode://file/${p}${line != null ? `:${line}` : ""}`;
}

function linkifyWith(
  text: string,
  render: (raw: string, path: string, line: number | undefined, key: string) => React.ReactNode,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[0];
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const lineMatch = /^(.*?):(\d+)$/.exec(raw);
    const path = lineMatch ? lineMatch[1]! : raw;
    const line = lineMatch ? Number(lineMatch[2]) : undefined;
    nodes.push(render(raw, path, line, `${idx}-${raw}`));
    last = idx + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function linkifyPaths(text: string, project?: string | null): React.ReactNode[] {
  return linkifyWith(text, (raw, path, line, key) => (
    <Link key={key} to={fileHref(path, line, project)} className="text-accent underline decoration-dotted">
      {raw}
    </Link>
  ));
}

export function linkifyPathsVsc(text: string, project?: string | null): React.ReactNode[] {
  return linkifyWith(text, (raw, path, line, key) => (
    <a key={key} href={vscHref(path, project, line)} title="In VS Code öffnen" className="text-accent underline decoration-dotted">
      {raw}
    </a>
  ));
}
