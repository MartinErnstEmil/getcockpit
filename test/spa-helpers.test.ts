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
