// Reine Ableitungslogik für die Git-Modi (Migration v4). Kein DOM, kein React —
// testbar über spa-helpers.test.ts. Drei Konsumenten teilen sie: OverviewPage
// (Empfehlungen), GitPage (Hinweiszeilen) und BriefingPage (Session-Prompt).

// advisory/auto zeigen Git-Empfehlungen; manual heißt "nur anzeigen, keine
// Empfehlungen" — die Transparenz-Daten (Branch, dirty, Commits) bleiben davon
// unberührt, es entfällt nur die wertende Hinweiszeile.
export function gitAdvisoryVisible(mode: string): boolean {
  return mode !== "manual";
}

// Git-Regel im autonomen Session-Prompt, modusabhängig (ohne Nummer — der
// Aufrufer nummeriert die Regelliste). manual: keine Regel; advisory: die
// Basisregel; auto: Basisregel + Snapshot-Hinweis (Snapshots ersetzen keine
// Commits). Fortsetzungszeilen sind mit 3 Leerzeichen unter das "N. " eingerückt.
export function sessionPromptGitRule(mode: string): string | null {
  if (mode === "manual") return null;
  const base =
    "Git-Disziplin: EIN kleiner, in sich abgeschlossener Commit je Paket\n" +
    "   (aussagekräftige Message, WARUM vor WAS) — nie mit roten Gates\n" +
    "   committen. Am Session-Ende: push, wenn alle Gates grün sind; sonst\n" +
    "   NICHT pushen und stattdessen ein blocker-Item mit dem Grund anlegen.";
  if (mode === "auto") {
    return (
      base +
      "\n   Auto-Snapshots sichern den Stand nach jeder Session unter\n" +
      "   refs/cockpit/ — sie ersetzen keine Commits."
    );
  }
  return base;
}
