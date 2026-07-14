// Reine Lane-Zuweisung für den Commit-Graphen (Slice 2). Kein DOM — eine pure
// Funktion {sha, parents[]}[] -> Spalten + Kanten, getestet mit Fixtures
// (linear, branch+merge, octopus, mehrere Wurzeln, Snapshot ins Innere). Der
// riskanteste Teil laut Plumbing-Review, deshalb bewusst simpel und belegt.
//
// ANNAHME: die Eingabe ist topo-order (jeder Elter steht NACH allen seinen
// Kindern) — der Server liefert `git log --topo-order`. Ohne diese Garantie
// bricht die Zuweisung, daher liest der Server sie nie in Commit-Datums-Ordnung.
//
// Modell: "Tracks" sind vertikale Spuren. Jeder Track ist auf genau einen noch
// nicht gesehenen Commit reserviert (den Elter, den ein bereits gezeichnetes
// Kind erwartet). Ein Commit belegt den Track, der auf ihn reserviert war;
// mehrere solche Tracks (mehrere Kinder) laufen in ihm zusammen. Danach wird
// sein erster Elter im selben Track weitergeführt (Mainline bleibt in Spalte),
// weitere Eltern bekommen freie Tracks. Kanten sind schlicht Kind->Elter — das
// deckt Merges (mehrere Eltern) und Wurzeln (keine Eltern) natürlich ab.

export interface GraphCommit {
  sha: string;
  parents: string[];
}

export interface GraphNode {
  sha: string;
  parents: string[];
  // Spalte (0-basiert), in der der Commit-Punkt sitzt.
  lane: number;
  // Zeilenindex = Position in der Eingabe (topo-order).
  row: number;
}

export interface GraphEdge {
  fromSha: string;
  // Elter-Sha; null, wenn der Elter außerhalb des geladenen Fensters liegt
  // (Cap erreicht) — die UI zeichnet dann einen kurzen "Historie geht weiter"-Stummel.
  toSha: string | null;
  fromLane: number;
  // Spalte des Elters bzw. — bei abgeschnittenem Elter — die Spalte, in der der
  // Strang weiterläuft (dieselbe wie fromLane).
  toLane: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Anzahl belegter Spalten (für die SVG-Breite).
  width: number;
}

// Erste freie (null) Spur oder eine neue am Ende.
function allocLane(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null);
  if (free !== -1) return free;
  lanes.push(null);
  return lanes.length - 1;
}

export function computeGraph(commits: GraphCommit[]): Graph {
  const lanes: (string | null)[] = []; // lanes[i] = erwarteter Elter-Sha | null
  const laneOf = new Map<string, number>();
  const nodes: GraphNode[] = [];

  commits.forEach((c, row) => {
    // Track finden, der auf diesen Commit reserviert war; sonst neuen belegen
    // (Commit ist ein Tip/Branch-Head, den noch kein Kind erwartet hat).
    let my = lanes.indexOf(c.sha);
    if (my === -1) my = allocLane(lanes);
    laneOf.set(c.sha, my);
    nodes.push({ sha: c.sha, parents: c.parents, lane: my, row });

    // Alle Reservierungen auf diesen Commit auflösen (zusammenlaufende Kinder),
    // inkl. der eigenen Spur — sie wird gleich für den ersten Elter neu belegt.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) lanes[i] = null;

    // Eltern auf Spuren legen. Ein bereits woanders reservierter Elter bleibt
    // dort (die Kante wird diagonal) — das hält die Spaltenzahl klein.
    c.parents.forEach((p, k) => {
      if (lanes.includes(p)) return; // schon reserviert -> nichts tun
      if (k === 0 && lanes[my] === null) lanes[my] = p; // Mainline in der Spalte halten
      else lanes[allocLane(lanes)] = p;
    });
  });

  // lanes wächst nur (freie Slots werden per indexOf(null) wiederverwendet, nie
  // entfernt) -> die Endlänge IST die maximale Spaltenzahl, kein Mitzählen nötig.
  const width = Math.max(1, lanes.length);

  // Kanten Kind->Elter. Elter im Fenster -> echte Spalte; sonst Stummel in der
  // Spalte des Kindes (Historie läuft dort nach unten weiter).
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const p of n.parents) {
      const toLane = laneOf.get(p);
      edges.push({
        fromSha: n.sha,
        toSha: toLane === undefined ? null : p,
        fromLane: n.lane,
        toLane: toLane === undefined ? n.lane : toLane,
      });
    }
  }

  return { nodes, edges, width };
}
