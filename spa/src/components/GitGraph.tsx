import { useMemo } from "react";
import { computeGraph } from "@/lib/gitgraph";
import { ageText } from "@/lib/utils";
import type { GitGraphCommit } from "@/api/types";

// Commit-Graph-Darstellung (Slice 2): reine Lane-Zuweisung aus gitgraph.ts,
// hier nur SVG-Layout. Ein absolut positioniertes SVG links zeichnet Kanten +
// Punkte; rechts sitzt je Commit eine Textzeile gleicher Höhe. Kein externes
// Diagramm-Lib (KISS, und Artifacts/CSP-frei ist hier egal — dies ist die SPA).

const ROW_H = 36;
const COL_W = 22;
const DOT_R = 5;
const PAD_X = 14;
// Farbpalette je Spalte — bewusst wenige, in Hell/Dunkel brauchbare Töne.
const LANE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6"];
const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]!;

// Kürzt eine Ref-Dekoration auf das Wesentliche: "HEAD -> main" zeigt "main",
// interne Snapshot-Refs als "wip".
function refLabel(ref: string): string {
  const r = ref.replace(/^HEAD -> /, "");
  if (r.startsWith("refs/cockpit/")) return "Auto-Sicherung";
  if (r.startsWith("tag: ")) return r.slice(5);
  return r;
}

export default function GitGraph({ commits }: { commits: GitGraphCommit[] }) {
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const rowOf = useMemo(() => new Map(graph.nodes.map((n) => [n.sha, n.row])), [graph]);

  const graphW = PAD_X * 2 + Math.max(0, graph.width - 1) * COL_W;
  const totalH = commits.length * ROW_H;
  const x = (lane: number) => PAD_X + lane * COL_W;
  const y = (row: number) => row * ROW_H + ROW_H / 2;

  return (
    <div className="relative overflow-x-auto" style={{ minHeight: totalH }}>
      <svg
        className="pointer-events-none absolute left-0 top-0"
        width={graphW}
        height={totalH}
        aria-hidden="true"
      >
        {graph.edges.map((e, i) => {
          const yf = y(rowOf.get(e.fromSha) ?? 0);
          if (e.toSha === null) {
            // Elter außerhalb des Fensters: gestrichelter Stummel nach unten.
            const xf = x(e.fromLane);
            return (
              <path
                key={`stub-${i}`}
                d={`M ${xf} ${yf} L ${xf} ${yf + ROW_H * 0.7}`}
                stroke={laneColor(e.fromLane)}
                strokeWidth={2}
                strokeDasharray="3 3"
                fill="none"
              />
            );
          }
          const yt = y(rowOf.get(e.toSha) ?? 0);
          const xf = x(e.fromLane);
          const xt = x(e.toLane);
          return (
            <path
              key={`edge-${i}`}
              d={`M ${xf} ${yf} C ${xf} ${yf + ROW_H / 2} ${xt} ${yt - ROW_H / 2} ${xt} ${yt}`}
              stroke={laneColor(e.toLane)}
              strokeWidth={2}
              fill="none"
            />
          );
        })}
        {graph.nodes.map((n) => {
          const isHead = (commits[n.row]?.refs ?? []).some((r) => r.startsWith("HEAD"));
          return (
            <circle
              key={n.sha}
              cx={x(n.lane)}
              cy={y(n.row)}
              r={isHead ? DOT_R + 1.5 : DOT_R}
              fill={laneColor(n.lane)}
              stroke={isHead ? "var(--ds-ground, #fff)" : "none"}
              strokeWidth={isHead ? 2 : 0}
            />
          );
        })}
      </svg>
      <div style={{ paddingLeft: graphW }}>
        {commits.map((c) => (
          <div
            key={c.sha}
            className="flex items-center gap-2 overflow-hidden text-xs"
            style={{ height: ROW_H }}
          >
            <span className="shrink-0 font-mono text-ink-2">{c.sha.slice(0, 7)}</span>
            {c.refs.map((r) => (
              <span
                key={r}
                className="shrink-0 rounded-full bg-secondary-container px-1.5 text-[10px]"
                title={r}
              >
                {refLabel(r)}
              </span>
            ))}
            <span className="truncate text-ink">{c.subject}</span>
            <span className="ml-auto shrink-0 font-mono text-ink-2" title={c.at}>
              {ageText(c.at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
