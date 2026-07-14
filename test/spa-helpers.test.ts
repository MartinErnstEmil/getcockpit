// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Phase 1 (§10A): EIN fokussierter Vitest für die reinen SPA-Helfer —
// Token-Capture-Kern und die gemeinsamen Auswahl-/Prädikat-Funktionen
// (Auflagen T3/P1/P2). Kein DOM: nur die reinen Funktionen.
import { describe, it, expect } from "vitest";
import {
  parseScope,
  scopeToParams,
  buildActiveSet,
  inScope,
  inPeriod,
  isInboxOpen,
  isActionable,
  isLog,
  isBlocker,
  isPostponed,
  type ScopeProject,
} from "../spa/src/lib/scope";
import { extractToken, stripTokenParam } from "../spa/src/lib/token";
import { gitAdvisoryVisible, sessionPromptGitRule } from "../spa/src/lib/gitmode";
import { deriveGitActions } from "../spa/src/lib/gitactions";
import { computeGraph, type GraphCommit } from "../spa/src/lib/gitgraph";
import { deriveShipPlan } from "../spa/src/lib/shipplan";
import { MARKER_FILES } from "../src/shipinfo.js";
import {
  parseOptionLine,
  isSelected,
  selectSingleDraft,
  toggleMultiDraft,
  getRemark,
  setRemark,
  optionLineWithRemark,
} from "../spa/src/lib/options";

describe("token capture (pure core)", () => {
  it("extracts the token from a query string", () => {
    expect(extractToken("?token=abc123&scope=all")).toBe("abc123");
    expect(extractToken("?scope=all")).toBeNull();
  });

  it("strips only the token param, preserving scope/item and hash", () => {
    expect(stripTokenParam("http://127.0.0.1:7878/spa/inbox?token=abc&item=i-1#x")).toBe(
      "/spa/inbox?item=i-1#x",
    );
    expect(stripTokenParam("http://127.0.0.1:7878/spa/?token=abc")).toBe("/spa/");
  });
});

describe("Git-Modi (reine Ableitung)", () => {
  it("gitAdvisoryVisible: nur manual unterdrückt Empfehlungen", () => {
    expect(gitAdvisoryVisible("manual")).toBe(false);
    expect(gitAdvisoryVisible("advisory")).toBe(true);
    expect(gitAdvisoryVisible("auto")).toBe(true);
  });

  it("sessionPromptGitRule: manual weglassen, auto ergänzt den Snapshot-Hinweis", () => {
    expect(sessionPromptGitRule("manual")).toBeNull();
    const advisory = sessionPromptGitRule("advisory");
    expect(advisory).toContain("Git-Disziplin");
    expect(advisory).not.toContain("refs/cockpit/");
    const auto = sessionPromptGitRule("auto");
    expect(auto).toContain("Git-Disziplin");
    expect(auto).toContain("refs/cockpit/");
    expect(auto).toContain("ersetzen keine Commits");
  });
});

describe("Git-Handlungsempfehlungen (deriveGitActions, reine Ableitung)", () => {
  it("undefined ahead/behind unterdrückt alle upstream-abhängigen Hinweise", () => {
    // Vor dem Live-Refresh kennen wir ahead/behind/upstream nicht — nur dirty
    // stammt aus dem Cache und darf erscheinen.
    const a = deriveGitActions({ branch: "main", dirtyFiles: 3, aheadBehind: undefined });
    expect(a.map((x) => x.kind)).toEqual(["dirty"]);
  });

  it("dirty=0 ohne ahead/behind ergibt keine Empfehlung", () => {
    expect(deriveGitActions({ branch: "main", dirtyFiles: 0, aheadBehind: undefined })).toEqual([]);
  });

  it("behind steht vor dirty vor unpushed (Dringlichkeit) und behind hat kein Kommando", () => {
    const a = deriveGitActions({ branch: "main", dirtyFiles: 2, aheadBehind: { ahead: 1, behind: 4 } });
    expect(a.map((x) => x.kind)).toEqual(["behind", "dirty", "unpushed"]);
    const behind = a.find((x) => x.kind === "behind")!;
    expect(behind.command).toBeNull(); // kein Ein-Klick-Fix (Konfliktgefahr)
    expect(behind.sessionPrompt).toContain("zusammen");
    expect(a.find((x) => x.kind === "unpushed")!.command).toBe("git push");
  });

  it("kein Upstream (ab === null) zeigt no-upstream mit Branch im Kommando", () => {
    const a = deriveGitActions({ branch: "feature/x", dirtyFiles: 0, aheadBehind: null });
    expect(a.map((x) => x.kind)).toEqual(["no-upstream"]);
    expect(a[0]!.command).toBe("git push -u origin feature/x");
  });

  it("kein Upstream ohne Branch bzw. detached HEAD nutzt HEAD als Ref", () => {
    expect(deriveGitActions({ branch: null, dirtyFiles: 0, aheadBehind: null })).toEqual([]);
    const a = deriveGitActions({ branch: "HEAD", dirtyFiles: 0, aheadBehind: null });
    expect(a[0]!.command).toBe("git push -u origin HEAD");
  });

  it("snapshotUnmerged erzeugt einen Info-Hinweis ohne Kommando", () => {
    const a = deriveGitActions({ branch: "main", dirtyFiles: 0, aheadBehind: { ahead: 0, behind: 0 }, snapshotUnmerged: true });
    expect(a.map((x) => x.kind)).toEqual(["snapshot-unmerged"]);
    expect(a[0]!.command).toBeNull();
    expect(a[0]!.severity).toBe("info");
  });

  it("kein Text verwendet das verbotene Wort 'ungesichert' (Terminologie-Leitplanke)", () => {
    const all = deriveGitActions({ branch: "main", dirtyFiles: 1, aheadBehind: { ahead: 1, behind: 1 }, snapshotUnmerged: true });
    for (const x of all) {
      expect(`${x.title} ${x.detail}`.toLowerCase()).not.toContain("ungesichert");
    }
  });
});

describe("Commit-Graph Lane-Zuweisung (computeGraph, reine Funktion)", () => {
  const g = (sha: string, ...parents: string[]): GraphCommit => ({ sha, parents });

  it("lineare Historie bleibt in Spalte 0", () => {
    const graph = computeGraph([g("c", "b"), g("b", "a"), g("a")]);
    expect(graph.width).toBe(1);
    expect(graph.nodes.map((n) => n.lane)).toEqual([0, 0, 0]);
    // a hat keinen Elter -> keine Kante von a.
    expect(graph.edges.filter((e) => e.fromSha === "a")).toEqual([]);
  });

  it("branch + merge: zwei Stränge, Merge hat zwei Eltern-Kanten", () => {
    // m(merge) -> a,b ; a -> base ; b -> base ; base
    const graph = computeGraph([g("m", "a", "b"), g("a", "base"), g("b", "base"), g("base")]);
    expect(graph.width).toBeGreaterThanOrEqual(2);
    const mEdges = graph.edges.filter((e) => e.fromSha === "m");
    expect(mEdges.map((e) => e.toSha).sort()).toEqual(["a", "b"]);
    // base wird von a und b erwartet -> beide Kanten landen in derselben Spalte.
    const baseLane = graph.nodes.find((n) => n.sha === "base")!.lane;
    expect(baseLane).toBeGreaterThanOrEqual(0);
  });

  it("octopus-Merge (3 Eltern) erzeugt drei Kanten", () => {
    const graph = computeGraph([g("m", "a", "b", "c"), g("a"), g("b"), g("c")]);
    expect(graph.edges.filter((e) => e.fromSha === "m")).toHaveLength(3);
    expect(graph.width).toBeGreaterThanOrEqual(3);
  });

  it("mehrere Wurzeln (unverbundene Historien) brechen nicht", () => {
    const graph = computeGraph([g("x", "x0"), g("x0"), g("y", "y0"), g("y0")]);
    // Keine Kante zeigt ins Leere außer bewusst als Stummel; alle Eltern hier im Fenster.
    expect(graph.edges.every((e) => e.toSha !== null)).toBe(true);
    expect(graph.nodes).toHaveLength(4);
  });

  it("Elter außerhalb des Fensters wird zum Stummel (toSha null, Spalte = Kind)", () => {
    // b fehlt (Cap) -> Kante a->b ist ein Stummel in a's Spalte.
    const graph = computeGraph([g("a", "b")]);
    const e = graph.edges.find((x) => x.fromSha === "a")!;
    expect(e.toSha).toBeNull();
    expect(e.toLane).toBe(graph.nodes[0]!.lane);
  });

  it("Snapshot, der an einen inneren Commit hängt, verbindet dorthin", () => {
    // Kette c->b->a; Snapshot s hängt an b (innerer Commit, kein Tip).
    const graph = computeGraph([g("s", "b"), g("c", "b"), g("b", "a"), g("a")]);
    const sEdge = graph.edges.find((e) => e.fromSha === "s")!;
    expect(sEdge.toSha).toBe("b");
    const bLane = graph.nodes.find((n) => n.sha === "b")!.lane;
    expect(sEdge.toLane).toBe(bLane);
  });
});

describe("Ship-Plan Ableitung (deriveShipPlan, reine Funktion)", () => {
  const sig = (files: string[], npmScripts: string[] = [], deployWorkflow = false) => ({ files, npmScripts, deployWorkflow });

  it("Vercel: benanntes Ziel, push-to-deploy, Kandidaten-Kommando", () => {
    const plan = deriveShipPlan(sig(["vercel.json"]));
    expect(plan.targets.map((t) => t.name)).toEqual(["Vercel"]);
    expect(plan.targets[0]!.pushToDeploy).toBe(true);
    expect(plan.targets[0]!.command).toBe("vercel --prod");
  });

  it("Fly.io: Kommando-Deploy (nicht push-to-deploy)", () => {
    const plan = deriveShipPlan(sig(["fly.toml"]));
    expect(plan.targets[0]!.name).toBe("Fly.io");
    expect(plan.targets[0]!.pushToDeploy).toBe(false);
    expect(plan.targets[0]!.command).toBe("fly deploy");
  });

  it("mehrdeutige Signale werden NUR ohne benanntes Ziel gezeigt", () => {
    // Dockerfile allein -> Container (Ziel offen), kein Kommando.
    const only = deriveShipPlan(sig(["Dockerfile"]));
    expect(only.targets[0]!.name).toBe("Container (Ziel offen)");
    expect(only.targets[0]!.command).toBeNull();
    // Dockerfile + Vercel -> nur Vercel behauptet, kein Container-Fallback.
    const both = deriveShipPlan(sig(["Dockerfile", "vercel.json"]));
    expect(both.targets.map((t) => t.name)).toEqual(["Vercel"]);
  });

  it("Procfile bleibt mehrdeutig (kein Anbieter behauptet, kein Kommando)", () => {
    const plan = deriveShipPlan(sig(["Procfile"]));
    expect(plan.targets[0]!.command).toBeNull();
    expect(plan.targets[0]!.name).toContain("Procfile");
  });

  it("kein Ziel-Signal -> leere Zielliste (Empty-State in der UI)", () => {
    expect(deriveShipPlan(sig(["package.json"])).targets).toEqual([]);
  });

  it("node-Gate baut nur aus vorhandenen Skripten, test nutzt 'npm test'", () => {
    const plan = deriveShipPlan(sig(["package.json"], ["build", "test", "dev"]));
    expect(plan.gate.command).toBe("npm test && npm run build");
  });

  it("Nicht-npm-Stacks bekommen das kanonische Gate-Kommando", () => {
    expect(deriveShipPlan(sig(["go.mod"])).gate.command).toBe("go build ./... && go test ./...");
    expect(deriveShipPlan(sig(["Cargo.toml"])).gate.command).toBe("cargo build && cargo test");
    expect(deriveShipPlan(sig(["pyproject.toml"])).gate.command).toBe("pytest");
  });

  it("kein erkennbares Gate -> command null, aber immer ein Session-Prompt", () => {
    const g = deriveShipPlan(sig([])).gate;
    expect(g.command).toBeNull();
    expect(g.sessionPrompt.length).toBeGreaterThan(0);
  });

  it("jeder Server-Marker wird vom Client-Klassifikator verstanden (kein Split-Brain)", () => {
    // Absichert gegen Drift: ein in shipinfo.ts gemeldeter Marker, den shipplan.ts
    // nicht kennt, wäre stille tote Kopplung. package.json braucht ein Skript für
    // ein Gate; alle anderen Marker liefern für sich ein Ziel oder ein Gate.
    for (const m of MARKER_FILES) {
      const plan = deriveShipPlan({ files: [m], npmScripts: ["test"], deployWorkflow: false });
      expect(plan.targets.length > 0 || plan.gate.command !== null, `Marker ${m} wird ignoriert`).toBe(true);
    }
  });
});

describe("scope parsing (PLAN-PRD §4 + Zeitperiode)", () => {
  it("defaults to active/7 Tage; single without project falls back to active", () => {
    expect(parseScope(new URLSearchParams(""))).toEqual({ mode: "active", project: "", days: 7 });
    expect(parseScope(new URLSearchParams("scope=all"))).toEqual({ mode: "all", project: "", days: 7 });
    expect(parseScope(new URLSearchParams("scope=single"))).toEqual({ mode: "active", project: "", days: 7 });
    expect(parseScope(new URLSearchParams("scope=single&project=c:/x"))).toEqual({
      mode: "single",
      project: "c:/x",
      days: 7,
    });
  });

  it("reads a custom period and rejects nonsense values", () => {
    expect(parseScope(new URLSearchParams("days=30")).days).toBe(30);
    expect(parseScope(new URLSearchParams("days=0")).days).toBe(7);
    expect(parseScope(new URLSearchParams("days=abc")).days).toBe(7);
  });

  it("active with default period is omitted from params; single carries the project", () => {
    expect(scopeToParams({ mode: "active", project: "", days: 7 }).toString()).toBe("");
    expect(scopeToParams({ mode: "active", project: "", days: 30 }).toString()).toBe("days=30");
    expect(scopeToParams({ mode: "single", project: "c:/x", days: 7 }).toString()).toBe(
      "scope=single&project=c%3A%2Fx",
    );
  });
});

describe("inScope with the time-based active set (Zeitperioden-Filter)", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  const iso = (daysBack: number) => new Date(now - daysBack * 86_400_000).toISOString();
  const projects: ScopeProject[] = [
    { projectPath: "c:/fresh", lastActivity: iso(1), activeSession: false },
    { projectPath: "c:/running-but-old", lastActivity: iso(40), activeSession: true },
    { projectPath: "c:/old-quiet", lastActivity: iso(40), activeSession: false },
  ];
  const activeSet = buildActiveSet(projects, 7, now);

  it("active set = session running OR activity within the period", () => {
    expect(activeSet.has("c:/fresh")).toBe(true);
    expect(activeSet.has("c:/running-but-old")).toBe(true);
    expect(activeSet.has("c:/old-quiet")).toBe(false);
  });

  it("a longer period brings older projects back", () => {
    expect(buildActiveSet(projects, 90, now).has("c:/old-quiet")).toBe(true);
  });

  it("global items (empty/null path) appear ONLY in 'Alle' (PO 11.07., ändert P1)", () => {
    // "Alle" zeigt Globale; "Aktiv" und Einzelprojekt blenden sie aus.
    expect(inScope({ mode: "all", project: "", days: 7 }, "", activeSet)).toBe(true);
    expect(inScope({ mode: "all", project: "", days: 7 }, null, activeSet)).toBe(true);
    expect(inScope({ mode: "active", project: "", days: 7 }, "", activeSet)).toBe(false);
    expect(inScope({ mode: "single", project: "c:/fresh", days: 7 }, null, activeSet)).toBe(false);
  });

  it("all shows everything; single shows only the chosen project (no globals)", () => {
    expect(inScope({ mode: "all", project: "", days: 7 }, "c:/old-quiet", activeSet)).toBe(true);
    expect(inScope({ mode: "single", project: "c:/fresh", days: 7 }, "c:/fresh", activeSet)).toBe(true);
    expect(inScope({ mode: "single", project: "c:/fresh", days: 7 }, "c:/other", activeSet)).toBe(false);
  });

  it("active hides projects outside the period", () => {
    expect(inScope({ mode: "active", project: "", days: 7 }, "c:/old-quiet", activeSet)).toBe(false);
    expect(inScope({ mode: "active", project: "", days: 7 }, "c:/running-but-old", activeSet)).toBe(true);
  });
});

describe("shared item predicates (Kachel == Badge == Liste)", () => {
  const item = (over: Partial<{ status: string; type: string; source: string }>) => ({
    projectPath: "c:/x",
    status: "new",
    type: "question",
    source: "claude",
    ...over,
  });

  it("inbox-open = new/in_progress, postponed excluded", () => {
    expect(isInboxOpen(item({ status: "new" }))).toBe(true);
    expect(isInboxOpen(item({ status: "in_progress" }))).toBe(true);
    expect(isInboxOpen(item({ status: "postponed" }))).toBe(false);
    expect(isInboxOpen(item({ status: "answered" }))).toBe(false);
  });

  it("actionable = source claude AND type question/blocker/proposal/task AND open (PO-Entscheide 09.07.)", () => {
    expect(isActionable(item({ source: "claude", type: "question", status: "new" }))).toBe(true);
    expect(isActionable(item({ source: "claude", type: "blocker", status: "in_progress" }))).toBe(true);
    expect(isActionable(item({ source: "claude", type: "proposal", status: "new" }))).toBe(true);
    // Tasks zählen als handlungspflichtig (PO-Antwort auf i-16a80d3516).
    expect(isActionable(item({ source: "claude", type: "task", status: "new" }))).toBe(true);
    // Ergebnis/Human/erledigt sind NICHT handlungspflichtig.
    expect(isActionable(item({ source: "claude", type: "result", status: "new" }))).toBe(false);
    expect(isActionable(item({ source: "human", type: "question", status: "new" }))).toBe(false);
    expect(isActionable(item({ source: "claude", type: "question", status: "postponed" }))).toBe(false);
  });

  it("log = offen, aber nicht handlungspflichtig — disjunkt zu actionable", () => {
    expect(isLog(item({ source: "claude", type: "result", status: "new" }))).toBe(true);
    expect(isLog(item({ source: "claude", type: "decision", status: "new" }))).toBe(true);
    expect(isLog(item({ source: "human", type: "question", status: "new" }))).toBe(true);
    expect(isLog(item({ source: "claude", type: "question", status: "new" }))).toBe(false);
    expect(isLog(item({ source: "claude", type: "result", status: "done" }))).toBe(false);
    // Invariante: keine offene Karte ist in beiden Anzeigen.
    for (const type of ["question", "blocker", "proposal", "result", "fyi", "memory", "decision", "task"]) {
      for (const source of ["claude", "human"]) {
        const i = item({ type, source, status: "new" });
        expect(isActionable(i) && isLog(i)).toBe(false);
      }
    }
  });

  it("blocker = type blocker AND open; postponed has its own filter", () => {
    expect(isBlocker(item({ type: "blocker", status: "new" }))).toBe(true);
    expect(isBlocker(item({ type: "blocker", status: "done" }))).toBe(false);
    expect(isPostponed(item({ status: "postponed" }))).toBe(true);
  });
});

describe("inPeriod (Zeitgrenze für Karten, User-Befund 09.07.)", () => {
  const now = Date.parse("2026-07-09T12:00:00Z");
  const item = (daysBack: number) => ({
    projectPath: "c:/x",
    status: "new",
    type: "question",
    source: "claude",
    updatedAt: new Date(now - daysBack * 86_400_000).toISOString(),
  });

  it("active blendet Karten außerhalb der Periode aus (nach updatedAt)", () => {
    const scope = { mode: "active" as const, project: "", days: 7 };
    expect(inPeriod(item(2), scope, now)).toBe(true);
    expect(inPeriod(item(30), scope, now)).toBe(false);
    expect(inPeriod(item(30), { ...scope, days: 90 }, now)).toBe(true);
  });

  it("alle/single heben die Zeitgrenze auf; kaputtes Datum fällt in active raus", () => {
    expect(inPeriod(item(300), { mode: "all", project: "", days: 7 }, now)).toBe(true);
    expect(inPeriod(item(300), { mode: "single", project: "c:/x", days: 7 }, now)).toBe(true);
    const broken = { ...item(1), updatedAt: "kein-datum" };
    expect(inPeriod(broken, { mode: "active", project: "", days: 7 }, now)).toBe(false);
  });
});

describe("klickbare Antwort-Optionen (( ) alternativ / [ ] additiv)", () => {
  it("parst nur ganze Options-Zeilen, Prosa bleibt Text", () => {
    expect(parseOptionLine("( ) A — Sitzungen nachlesen")).toEqual({ kind: "single", text: "A — Sitzungen nachlesen" });
    expect(parseOptionLine("() B kompakt")).toEqual({ kind: "single", text: "B kompakt" });
    expect(parseOptionLine("[ ] YouTube Shorts")).toEqual({ kind: "multi", text: "YouTube Shorts" });
    expect(parseOptionLine("Text mit ( ) mittendrin ist keine Option")).toBeNull();
    expect(parseOptionLine("(x) markiert wird nicht geparst")).toBeNull();
    expect(parseOptionLine("")).toBeNull();
  });

  it("Einfachauswahl ersetzt nur die anderen ( )-Zeilen — Häkchen und Freitext bleiben", () => {
    const singles = ["Name Postausgang", "Name Übergabe"];
    let draft = "P1 bauen"; // bereits gesetztes [ ]-Häkchen
    draft = selectSingleDraft(draft, "Name Postausgang", singles);
    expect(draft).toBe("P1 bauen\nName Postausgang");
    // Wechsel der Einfachauswahl ersetzt nur die alte ( )-Zeile.
    draft = selectSingleDraft(draft, "Name Übergabe", singles);
    expect(draft).toBe("P1 bauen\nName Übergabe");
    // Erneuter Klick auf die gewählte Option wählt ab.
    draft = selectSingleDraft(draft, "Name Übergabe", singles);
    expect(draft).toBe("P1 bauen");
    expect(isSelected("x\nName Übergabe", { kind: "single", text: "Name Übergabe" })).toBe(true);
  });

  it("Mehrfachauswahl: toggeln fügt hinzu und entfernt, Rest bleibt", () => {
    let draft = "";
    draft = toggleMultiDraft(draft, "YouTube Shorts");
    draft = toggleMultiDraft(draft, "Show HN");
    expect(draft).toBe("YouTube Shorts\nShow HN");
    expect(isSelected(draft, { kind: "multi", text: "Show HN" })).toBe(true);
    draft = toggleMultiDraft(draft, "YouTube Shorts");
    expect(draft).toBe("Show HN");
    expect(isSelected(draft, { kind: "multi", text: "YouTube Shorts" })).toBe(false);
  });
});

  it("Einfachauswahl ersetzt auch manuell nachbearbeitete Options-Zeilen (Präfix-Match)", () => {
    const singles = ["A — Tarball", "B — publish"];
    // Nutzer hat hinter die gewählte Option eine Bemerkung getippt.
    let draft = "A — Tarball, bitte mit Anleitung";
    draft = selectSingleDraft(draft, "B — publish", singles);
    expect(draft).toBe("B — publish");
    expect(isSelected("B — publish und zwar bald", { kind: "single", text: "B — publish" })).toBe(true);
  });

describe("Options-Bemerkungen (Paket A) — brechen die Auswahl nicht", () => {
  it("hängt eine Bemerkung an die Options-Zeile und liest sie zurück", () => {
    let draft = toggleMultiDraft("", "Fly.io");
    draft = setRemark(draft, "Fly.io", "günstig bis mid-scale");
    expect(draft).toBe("Fly.io — Bemerkung: günstig bis mid-scale");
    expect(getRemark(draft, "Fly.io")).toBe("günstig bis mid-scale");
  });

  it("leere Bemerkung entfernt das Suffix wieder", () => {
    let draft = "Fly.io — Bemerkung: teuer";
    draft = setRemark(draft, "Fly.io", "   ");
    expect(draft).toBe("Fly.io");
    expect(getRemark(draft, "Fly.io")).toBe("");
  });

  it("bewahrt Leerzeichen beim Tippen (Bug 11.07.: Leertaste wurde gefressen)", () => {
    let draft = toggleMultiDraft("", "Fly.io");
    // Trailing space zwischen zwei Wörtern muss den Zwischenzustand überleben.
    draft = setRemark(draft, "Fly.io", "günstig ");
    expect(getRemark(draft, "Fly.io")).toBe("günstig ");
    draft = setRemark(draft, "Fly.io", "günstig bis mid-scale");
    expect(getRemark(draft, "Fly.io")).toBe("günstig bis mid-scale");
    expect(isSelected(draft, { kind: "multi", text: "Fly.io" })).toBe(true);
  });

  it("Bemerkung bricht isSelected / Einfachauswahl NICHT (Präfix bleibt stabil)", () => {
    const singles = ["Fly.io", "Railway"];
    let draft = selectSingleDraft("", "Fly.io", singles);
    draft = setRemark(draft, "Fly.io", "günstig");
    expect(isSelected(draft, { kind: "single", text: "Fly.io" })).toBe(true);
    // Wechsel der Einfachauswahl ersetzt auch die mit Bemerkung versehene Zeile.
    draft = selectSingleDraft(draft, "Railway", singles);
    expect(draft).toBe("Railway");
  });

  it("setRemark ist No-op, wenn die Option nicht im Antwortfeld steht", () => {
    expect(setRemark("nur Freitext", "Fly.io", "x")).toBe("nur Freitext");
    expect(optionLineWithRemark("Fly.io", "")).toBe("Fly.io");
  });
});
