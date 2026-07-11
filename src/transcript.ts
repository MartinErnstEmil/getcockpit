// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Defensiv-Parsing portiert und um Zeilen-Streaming erweitert aus dev/cola
// transcript-reader.ts (ursprünglich MIT, (c) 2026, relizenziert durch
// denselben Rechteinhaber). Wirft nie pro Zeile; kaputte Zeilen werden
// gezählt statt geworfen (PRD F1).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface TranscriptTurn {
  uuid: string;
  sessionId: string;
  cwd: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isSidechain: boolean;
  gitBranch?: string;
}

// "broken" = kaputtes/partielles JSON oder Turn ohne Pflichtfelder (zählt im
// Report als Skip). "ignored" = legitime Nicht-Turn-Zeile (Snapshots,
// Attachments, isMeta, tool_result-only) — kein Qualitätssignal.
export type ParsedLine =
  | { kind: "turn"; turn: TranscriptTurn }
  | { kind: "broken" }
  | { kind: "ignored" };

const BROKEN: ParsedLine = { kind: "broken" };
const IGNORED: ParsedLine = { kind: "ignored" };

// Echo-Bruch (PRD F7): vom SessionStart-Briefing injizierte Blöcke dürfen
// nicht wieder eingefangen werden (Echo-Schleife). Greift in BEIDEN
// Ingest-Pfaden, weil Stop-Hook und Backfill durch diesen Parser laufen.
export const BRIEFING_OPEN = "<cockpit-inbox-untrusted>";
export const BRIEFING_CLOSE = "</cockpit-inbox-untrusted>";
const BRIEFING_BLOCK = /<cockpit-inbox-untrusted>[\s\S]*?<\/cockpit-inbox-untrusted>/g;
// Alt-Marker aus der cola2-Zeit: historische Transcripts tragen ihn noch —
// ohne Legacy-Strip käme er beim Re-Backfill als Echo zurück.
const LEGACY_BRIEFING_BLOCK = /<cola2-inbox-untrusted>[\s\S]*?<\/cola2-inbox-untrusted>/g;

export function stripBriefingBlocks(text: string): string {
  return text
    .replace(BRIEFING_BLOCK, "[cockpit-briefing entfernt]")
    .replace(LEGACY_BRIEFING_BLOCK, "[cockpit-briefing entfernt]");
}

// Assist-Rauschfilter (Paket 0): Die eigenen `claude -p`-Spawns (assist.ts,
// standup.ts, statusbrief.ts) beginnen ihren Prompt mit diesem Marker. Ihre
// 2-Turn-Sessions ("Du unterstützt einen Entwickler …") würden sonst Verlauf
// und Report vermüllen. Erkennung am ersten User-Turn — nicht löschen, nur
// nicht erfassen bzw. nicht anzeigen.
export const INTERNAL_MARKER = "[cockpit-intern]";

// Bestands-Sessions (vor Einführung des Markers erfasst) tragen ihn nicht —
// sie werden über die stabilen Prompt-Präfixe der drei Spawns erkannt. Nur
// nutzbar zusammen mit der Turn-Schranke unten (echte Sessions sind länger).
const INTERNAL_LEGACY_PREFIXES = [
  "Du unterstützt einen Entwickler bei der Triage",
  "Du schreibst einen Standup-Bericht",
  "Du briefst den Product Owner",
];
// Interne Spawns haben genau einen User- und einen Assistant-Turn. Die
// Schranke schützt echte Sessions, die zufällig so beginnen (>2 Turns).
const INTERNAL_MAX_TURNS = 2;

function isInternalFirstPrompt(firstPrompt: string | null | undefined): boolean {
  if (!firstPrompt) return false;
  if (firstPrompt.startsWith(INTERNAL_MARKER)) return true;
  return INTERNAL_LEGACY_PREFIXES.some((p) => firstPrompt.startsWith(p));
}

// Bestandsdaten-Filter für Verlauf/Report: blendet erfasste Spawn-Sessions
// aus, ohne sie zu löschen. Nur bei kurzen Sessions mit internem Erst-Prompt.
export function isInternalSession(firstPrompt: string | null | undefined, turns: number): boolean {
  return turns <= INTERNAL_MAX_TURNS && isInternalFirstPrompt(firstPrompt);
}

// Capture-seitiger Filter (Hook + Backfill, EIN Pfad): der Assistant-Turn
// eines Spawns trägt den Marker NICHT — die Erkennung braucht Zustand über die
// Turns EINER Transcript-Datei. Session gilt als intern, sobald ihr erster
// gesehener User-Turn den Marker führt; danach werden ALLE ihre Turns
// verworfen. Pro Datei/Tail eine frische Instanz (Transcripts sind
// session-rein, Zeilen chronologisch).
export function createInternalSessionFilter(): { keep(turn: TranscriptTurn): boolean } {
  const internal = new Set<string>();
  const sawUser = new Set<string>();
  return {
    keep(turn: TranscriptTurn): boolean {
      if (internal.has(turn.sessionId)) return false;
      if (turn.role === "user" && !sawUser.has(turn.sessionId)) {
        sawUser.add(turn.sessionId);
        if (turn.content.startsWith(INTERNAL_MARKER)) {
          internal.add(turn.sessionId);
          return false;
        }
      }
      return true;
    },
  };
}

export function parseTranscriptLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return IGNORED;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return BROKEN;
  }
  if (!raw || typeof raw !== "object") return BROKEN;
  const r = raw as Record<string, unknown>;
  if (r["type"] !== "user" && r["type"] !== "assistant") return IGNORED;
  if (r["isMeta"] === true) return IGNORED;
  const message = r["message"];
  const content = stripBriefingBlocks(
    extractText(
      message && typeof message === "object" ? (message as { content?: unknown }).content : undefined,
    ),
  );
  // tool_result-only-User-Zeilen und tool_use-only-Assistant-Zeilen: kein Text.
  if (!content) return IGNORED;
  if (
    typeof r["uuid"] !== "string" ||
    typeof r["sessionId"] !== "string" ||
    typeof r["cwd"] !== "string" ||
    typeof r["timestamp"] !== "string"
  ) {
    return BROKEN;
  }
  return {
    kind: "turn",
    turn: {
      uuid: r["uuid"],
      sessionId: r["sessionId"],
      cwd: r["cwd"],
      role: r["type"] as "user" | "assistant",
      content,
      timestamp: r["timestamp"],
      isSidechain: r["isSidechain"] === true,
      gitBranch: typeof r["gitBranch"] === "string" ? r["gitBranch"] : undefined,
    },
  };
}

function extractText(content: unknown): string {
  // Legacy-Shape: bare-string content.
  if (typeof content === "string") return content.trim() ? content : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
  }
  return parts.join("\n");
}

// CRLF-tolerant (readline akzeptiert \r\n und \n); crlfDelay verhindert
// Doppel-Events bei gesplitteten \r\n über Chunk-Grenzen.
export async function* readTranscript(filePath: string): AsyncGenerator<ParsedLine> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield parseTranscriptLine(line);
}
