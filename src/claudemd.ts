// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CLAUDE.md-Budget-Quellen-Check (Nachtrag 10.07.): ein Websearch-LLM-Lauf
// prüft, ob Anthropic einen OFFIZIELLEN Zahlwert für die CLAUDE.md-Größe
// publiziert. EHRLICHKEIT ist bindend: Stand 10.07. gibt es KEINEN (nur die
// qualitative Empfehlung "keep it concise"). Der Check darf niemals einen Wert
// erfinden — ein Wert gilt nur als gefunden, wenn das Modell eine konkrete Zahl
// MIT anthropic.com-Quelle liefert; alles andere fällt sauber auf die Heuristik
// zurück und sagt das ehrlich.
import { runClaude, type ClaudeCmd } from "./standup.js";

export interface BudgetCheckResult {
  checkedAt: string;
  found: boolean;
  value: number | null;
  unit: "chars" | "tokens" | null;
  sourceUrl: string | null;
  note: string;
}

const HEURISTIC_NOTE =
  'Kein offizieller Zahlwert von Anthropic gefunden (die Empfehlung bleibt "keep it concise") — die Heuristik bleibt.';

function buildPrompt(): string {
  return [
    "Prüfe in der OFFIZIELLEN Anthropic-Dokumentation (docs.anthropic.com bzw. anthropic.com),",
    "ob Anthropic einen KONKRETEN empfohlenen Maximalwert für die Größe einer CLAUDE.md-Datei",
    "(in Zeichen oder Tokens) publiziert.",
    "Antworte AUSSCHLIESSLICH mit EINEM JSON-Objekt, ohne Markdown-Zäune, ohne Text davor/danach:",
    '{"found": true|false, "value": <Zahl>|null, "unit": "chars"|"tokens"|null, "sourceUrl": "<URL>"|null}',
    'Setze "found" NUR auf true, wenn du eine EXPLIZITE offizielle Zahl auf einer anthropic.com-Seite',
    'findest, und gib dann die exakte Quell-URL an. Gibt es keinen offiziellen Zahlwert (nur',
    'qualitative Hinweise wie "keep it concise"), setze found=false, value=null, unit=null.',
    "Erfinde NIEMALS einen Wert und rate nicht.",
  ].join("\n");
}

interface ParsedCheck {
  found: boolean;
  value: number | null;
  unit: "chars" | "tokens" | null;
  sourceUrl: string | null;
}

function parse(raw: string): ParsedCheck | null {
  // Das Modell kann Text um das JSON legen — erstes {…} herausschneiden.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const unit = j["unit"] === "chars" || j["unit"] === "tokens" ? j["unit"] : null;
    return {
      found: j["found"] === true,
      value: typeof j["value"] === "number" && Number.isFinite(j["value"]) ? (j["value"] as number) : null,
      unit,
      sourceUrl: typeof j["sourceUrl"] === "string" ? j["sourceUrl"] : null,
    };
  } catch {
    return null;
  }
}

export async function runBudgetCheck(
  opts: { claudeCmd?: ClaudeCmd; timeoutMs?: number } = {},
): Promise<BudgetCheckResult> {
  const checkedAt = new Date().toISOString();
  const res = await runClaude(buildPrompt(), {
    claudeCmd: opts.claudeCmd,
    timeoutMs: opts.timeoutMs,
    allowWebSearch: true,
  });
  if (!res.ok) {
    return { checkedAt, found: false, value: null, unit: null, sourceUrl: null, note: `Prüfung nicht möglich (${res.reason}) — die Heuristik bleibt.` };
  }
  const p = parse(res.stdout);
  // Ehrlichkeits-Guard: nur akzeptieren mit found + konkreter Zahl + Quelle von
  // anthropic.com. Sonst NIE einen Wert übernehmen (bindende Vorgabe).
  const legit =
    p?.found === true && typeof p.value === "number" && !!p.sourceUrl && /anthropic\.com/i.test(p.sourceUrl);
  if (!legit) {
    return { checkedAt, found: false, value: null, unit: null, sourceUrl: p?.sourceUrl ?? null, note: HEURISTIC_NOTE };
  }
  return {
    checkedAt,
    found: true,
    value: p!.value,
    unit: p!.unit,
    sourceUrl: p!.sourceUrl,
    note: "Offizieller Wert gefunden.",
  };
}
