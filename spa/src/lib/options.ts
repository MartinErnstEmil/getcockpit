// Klickbare Antwort-Optionen in Item-Texten: Zeilen der Form "( ) Text"
// (Einfachauswahl — Klick ersetzt das Antwortfeld) oder "[ ] Text"
// (Mehrfachauswahl — Klick toggelt die Zeile im Antwortfeld). Wie bei den
// KI-Assists gilt: Klick füllt NUR das Antwortfeld, Senden bleibt beim
// Menschen. Reine Funktionen — der fokussierte Vitest importiert sie direkt.

export type OptionKind = "single" | "multi";

export interface OptionLine {
  kind: OptionKind;
  text: string;
}

const SINGLE_RE = /^\(\s?\)\s+(.+)$/;
const MULTI_RE = /^\[\s?\]\s+(.+)$/;

export function parseOptionLine(line: string): OptionLine | null {
  const trimmed = line.trim();
  const single = SINGLE_RE.exec(trimmed);
  if (single) return { kind: "single", text: single[1]!.trim() };
  const multi = MULTI_RE.exec(trimmed);
  if (multi) return { kind: "multi", text: multi[1]!.trim() };
  return null;
}

// Zeile "gehört" zu einer Option, wenn sie mit deren Text BEGINNT — auch nach
// manueller Nachbearbeitung im Antwortfeld (angehängte Bemerkung). Sonst
// bleibt eine editierte ( )-Zeile beim Wechsel der Einfachauswahl stehen
// (Bug 10.07.: zwei Alternativ-Optionen nebeneinander im Feld).
function lineIsOption(line: string, text: string): boolean {
  const t = line.trim();
  return t === text || t.startsWith(text);
}

export function isSelected(draft: string, opt: OptionLine): boolean {
  return draft.split("\n").some((l) => lineIsOption(l, opt.text));
}

// Einfachauswahl: ersetzt nur die ANDEREN ( )-Zeilen derselben Karte im
// Antwortfeld — bereits angehakte [ ]-Zeilen und Freitext bleiben stehen,
// damit ( ) und [ ] in einer Karte kombinierbar sind. Erneuter Klick auf
// die gewählte Option wählt ab.
export function selectSingleDraft(draft: string, text: string, allSingle: string[]): string {
  const wasSelected = draft.split("\n").some((l) => lineIsOption(l, text));
  const rest = draft
    .split("\n")
    .filter((l) => l.trim() !== "" && !allSingle.some((s) => lineIsOption(l, s)));
  if (!wasSelected) rest.push(text);
  return rest.join("\n");
}

// Mehrfachauswahl: Zeile rein/raus, übrige Zeilen unangetastet.
export function toggleMultiDraft(draft: string, text: string): string {
  const lines = draft.split("\n").filter((l) => l.trim() !== "");
  const idx = lines.findIndex((l) => lineIsOption(l, text));
  if (idx >= 0) {
    lines.splice(idx, 1);
  } else {
    lines.push(text);
  }
  return lines.join("\n");
}

// Options-Bemerkungen (Paket A, Antwort-Flow v2): eine Notiz hängt als Suffix
// an der Options-Zeile ("<Text> — Bemerkung: <Notiz>"). Der Options-Text bleibt
// Präfix der Zeile, daher greifen lineIsOption/isSelected/selectSingleDraft
// unverändert — eine Bemerkung darf die Auswahl NIE brechen.
const REMARK_SEP = " — Bemerkung: ";

export function optionLineWithRemark(text: string, remark: string): string {
  // Nur eine LEERE Bemerkung (nach trim) fällt auf den reinen Optionstext
  // zurück; eine nicht-leere wird UNGETRIMMT gespeichert. Das alte
  // `remark.trim()` als Speicherwert fraß bei jedem Tastendruck die Leertaste
  // ("wort " -> "wort"), sodass sich Wörter nie trennen ließen (Bug 11.07.).
  return remark.trim() === "" ? text : `${text}${REMARK_SEP}${remark}`;
}

// Bemerkung einer im Antwortfeld stehenden Option lesen (leer, wenn keine).
export function getRemark(draft: string, text: string): string {
  const line = draft.split("\n").find((l) => lineIsOption(l, text));
  if (!line) return "";
  const idx = line.indexOf(REMARK_SEP);
  // Roher Slice ohne trim — sonst verschwindet das gerade getippte Leerzeichen
  // wieder aus dem kontrollierten Eingabefeld.
  return idx >= 0 ? line.slice(idx + REMARK_SEP.length) : "";
}

// Bemerkung an die Options-Zeile setzen/ersetzen/entfernen. No-op, wenn die
// Option nicht (mehr) ausgewählt ist — Bemerkungen hängen an der Auswahl.
export function setRemark(draft: string, text: string, remark: string): string {
  const lines = draft.split("\n");
  const idx = lines.findIndex((l) => lineIsOption(l, text));
  if (idx < 0) return draft;
  lines[idx] = optionLineWithRemark(text, remark);
  return lines.join("\n");
}
