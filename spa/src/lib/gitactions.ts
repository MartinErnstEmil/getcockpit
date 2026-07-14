// Reine Ableitung der Git-Handlungsempfehlungen (Slice 1 des Git-Tab-Ausbaus).
// Kein DOM, kein React, kein LLM — die fünf Zustände sind endlich und
// deterministisch, damit der Kern-Nutzwert offline und sofort da ist (Review:
// Haiku ist nur die optionale Vertiefung). Testbar über spa-helpers.test.ts.
//
// Terminologie-Leitplanke (Review C3): das Wort "gesichert/ungesichert" ist
// verboten — es verschmilzt "liegt auf der Platte" mit "ist in Sicherheit".
// festhalten = committen (lokaler Akt); in Sicherheit bringen / hochladen =
// pushen (Backup-Akt). Auto-Sicherungen ersetzen NIE einen Commit.

export type GitActionKind = "dirty" | "unpushed" | "behind" | "no-upstream" | "snapshot-unmerged";

export interface GitAction {
  kind: GitActionKind;
  // warn = du solltest etwas tun; info = nur Hinweis, keine Dringlichkeit.
  severity: "warn" | "info";
  // Klartext-Titel (was ist los), ohne Git-Jargon.
  title: string;
  // Eine Zeile Konsequenz: was passiert, wenn du nichts tust bzw. es löst.
  detail: string;
  // Das exakte Kommando zum Kopieren — null, wenn ein Ein-Klick-Fix gefährlich
  // wäre (behind: Zusammenführen kann in Konflikte laufen, siehe Review K2).
  command: string | null;
  // Fertiger Prompt für die eigene Claude-Session (respektiert deren
  // Git-Disziplin-Regeln — der sichere Weg für Vibecoder, Review S2).
  sessionPrompt: string;
}

// Momentaufnahme des Git-Zustands, so wie GitPage ihn zusammenträgt. ahead/
// behind/upstream stehen erst NACH dem Live-Refresh fest; solange unbekannt
// (undefined) unterdrücken wir die davon abhängigen Hinweise, statt zu raten.
export interface GitActionInput {
  branch: string | null;
  dirtyFiles: number;
  // {ahead,behind} = Upstream bekannt; null = kein Upstream; undefined = noch
  // nicht live gelesen.
  aheadBehind: { ahead: number; behind: number } | null | undefined;
  // Auto-Sicherung enthält Arbeit, die NICHT in HEAD steckt (merge-base-Prüfung
  // im Server) — sonst wäre der Snapshot bereits eingeholt und irrelevant.
  snapshotUnmerged?: boolean;
}

// Branch-Fallback für Kommandos: ohne bekannten Branch nutzen wir HEAD, das in
// jedem git-Kontext auflösbar ist.
function branchRef(branch: string | null): string {
  return branch && branch !== "HEAD" ? branch : "HEAD";
}

// Leitet die sichtbaren Handlungskarten ab — Reihenfolge = Dringlichkeit.
// behind steht bewusst vorn: ein Remote-Vorsprung blockiert das Hochladen und
// ist der Fall, den ein Vibecoder am wenigsten allein lösen kann.
export function deriveGitActions(input: GitActionInput): GitAction[] {
  const actions: GitAction[] = [];
  const ab = input.aheadBehind;

  if (ab && ab.behind > 0) {
    const n = ab.behind;
    actions.push({
      kind: "behind",
      severity: "warn",
      title: `Auf dem Remote liegen ${n} Commit${n === 1 ? "" : "s"}, die du lokal nicht hast`,
      detail:
        "Das sauber mit deinem Stand zusammenzuführen kann knifflig werden (Konflikte) — überlass das am besten deiner Claude-Session.",
      command: null,
      sessionPrompt:
        "Auf dem Remote liegen Commits, die ich lokal noch nicht habe. Bitte führe sie sauber mit meinem Arbeitsstand zusammen (pull/rebase, prüfe vorher, ob es lokale Änderungen gibt) und erklär mir in einfachen Worten, was du tust und ob es Konflikte gab.",
    });
  }

  if (input.dirtyFiles > 0) {
    const n = input.dirtyFiles;
    actions.push({
      kind: "dirty",
      severity: "warn",
      title: `${n} Änderung${n === 1 ? "" : "en"} noch nicht festgehalten`,
      detail:
        "Diese Änderungen liegen nur im Arbeitsordner. Halte sie in einem Commit fest, damit sie zu deiner Historie gehören.",
      command: 'git add -A && git commit -m "…"',
      sessionPrompt:
        "Bitte halte meinen aktuellen Arbeitsstand in einem sauberen, in sich abgeschlossenen Commit fest (aussagekräftige Message, WARUM vor WAS) — aber nur, wenn alle Qualitäts-Gates grün sind. Wenn nicht, sag mir, was noch offen ist, statt zu committen.",
    });
  }

  if (ab && ab.ahead > 0) {
    const n = ab.ahead;
    actions.push({
      kind: "unpushed",
      severity: "warn",
      title: `${n} Commit${n === 1 ? "" : "s"} nur lokal — noch nicht in Sicherheit`,
      detail:
        "Diese Commits liegen nur auf deiner Platte. Lade sie hoch (push), dann sind sie gesichert und für andere Rechner sichtbar.",
      command: "git push",
      sessionPrompt:
        "Bitte lade meine lokalen Commits hoch (push), sofern alle Qualitäts-Gates grün sind. Falls etwas rot ist, pushe NICHT, sondern erklär mir kurz, was noch fehlt.",
    });
  }

  // Kein Upstream: nur zeigen, wenn wir es live wissen (ab === null) und ein
  // Branch existiert. Ohne Upstream können wir ahead nicht kennen — der Hinweis
  // ist der nötige erste Schritt, damit Hochladen überhaupt möglich wird.
  if (ab === null && input.branch) {
    const ref = branchRef(input.branch);
    actions.push({
      kind: "no-upstream",
      severity: "info",
      title: "Dieser Branch ist noch mit keinem Remote verbunden",
      detail:
        "Ohne Remote-Verbindung kann dein Stand nicht hochgeladen werden. Einmal verbinden, dann geht Hochladen künftig per Klick.",
      command: `git push -u origin ${ref}`,
      sessionPrompt:
        "Mein aktueller Branch hat noch keinen Upstream. Bitte richte einen passenden Remote-Upstream ein und lade den Branch hoch — sag mir vorher, wohin (welcher Remote) gepusht wird.",
    });
  }

  if (input.snapshotUnmerged) {
    actions.push({
      kind: "snapshot-unmerged",
      severity: "info",
      title: "Eine Auto-Sicherung enthält Arbeit, die nicht in deiner Historie steckt",
      detail:
        "Cockpit hat nach einer Session automatisch einen Sicherungs-Stand geparkt, der über deinen letzten Commit hinausgeht. Er ersetzt keinen Commit — hol ihn zurück oder verwirf ihn bewusst.",
      command: null,
      sessionPrompt:
        "Unter refs/cockpit/ liegt eine Auto-Sicherung mit Arbeit, die nicht in meinem aktuellen Stand ist. Bitte zeig mir, was darin steckt, und hilf mir zu entscheiden, ob ich sie zurückhole (und wie) oder gefahrlos verwerfen kann.",
    });
  }

  return actions;
}
