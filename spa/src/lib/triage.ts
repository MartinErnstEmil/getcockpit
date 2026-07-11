// Parser für den triage-Assist (assist.ts): Haiku liefert JSON mit Erklärung,
// Antwortart und vorformulierten Optionen. LLM-Ausgabe ist unzuverlässig —
// Zäune abstreifen, strikt validieren, bei Mist null (die UI zeigt dann den
// Rohtext als einfache Erklärung).

export interface TriageOption {
  label: string;
  text: string;
}

export interface Triage {
  explanation: string;
  answerType: "yesno" | "options" | "free";
  options: TriageOption[];
}

export function parseTriage(raw: string): Triage | null {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced?.[1]) text = fenced[1];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const explanation = typeof d["explanation"] === "string" ? d["explanation"].trim() : "";
  const answerType = d["answerType"];
  if (!explanation) return null;
  if (answerType !== "yesno" && answerType !== "options" && answerType !== "free") return null;
  const options: TriageOption[] = [];
  if (Array.isArray(d["options"])) {
    for (const o of d["options"] as unknown[]) {
      if (typeof o !== "object" || o === null) continue;
      const oo = o as Record<string, unknown>;
      if (typeof oo["label"] === "string" && typeof oo["text"] === "string" && oo["label"].trim()) {
        options.push({ label: oo["label"].trim().slice(0, 60), text: oo["text"].trim() });
      }
    }
  }
  // yesno/options ohne brauchbare Optionen degradiert zu "free" statt kaputter Buttons.
  const effective = options.length >= 2 ? answerType : "free";
  return { explanation, answerType: effective, options: effective === "free" ? [] : options.slice(0, 4) };
}

// A/B-Variante (SWOT vs. Pro/Contra) deterministisch aus der Item-Id: stabil
// pro Item, hälftig über den Bestand — Events assist_ab/assist_adopt messen,
// welche Variante öfter übernommen wird.
export function abVariant(itemId: string): "swot" | "pros-cons" {
  let h = 0;
  for (let i = 0; i < itemId.length; i++) h = (h * 31 + itemId.charCodeAt(i)) | 0;
  return (h & 1) === 0 ? "swot" : "pros-cons";
}
