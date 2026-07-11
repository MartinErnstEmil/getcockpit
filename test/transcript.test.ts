// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Spezifikation übernommen aus dev/cola transcript-reader.test.ts und um
// Backfill-Anforderungen erweitert (isMeta, tool_result-only, Sidechain, CRLF).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInternalSessionFilter,
  isInternalSession,
  INTERNAL_MARKER,
  parseTranscriptLine,
  readTranscript,
  type ParsedLine,
  type TranscriptTurn,
} from "../src/transcript.js";

const BASE = {
  uuid: "u-1",
  sessionId: "s-1",
  cwd: "C:\\Users\\x\\proj",
  timestamp: "2026-05-16T19:12:57.168Z",
  gitBranch: "master",
};

function line(over: Record<string, unknown>): string {
  return JSON.stringify({ ...BASE, ...over });
}

describe("parseTranscriptLine", () => {
  it("parses a user turn with bare-string content (legacy shape)", () => {
    const p = parseTranscriptLine(line({ type: "user", message: { role: "user", content: "resume" } }));
    expect(p.kind).toBe("turn");
    if (p.kind === "turn") {
      expect(p.turn).toMatchObject({ role: "user", content: "resume", uuid: "u-1", isSidechain: false });
    }
  });

  it("parses an assistant turn, concatenating text blocks, ignoring tool_use", () => {
    const p = parseTranscriptLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "tool_use", name: "Bash", id: "t1", input: {} },
            { type: "text", text: "b" },
          ],
        },
      }),
    );
    expect(p.kind === "turn" && p.turn.content).toBe("a\nb");
  });

  it("flags sidechain turns", () => {
    const p = parseTranscriptLine(line({ type: "user", isSidechain: true, message: { content: "x" } }));
    expect(p.kind === "turn" && p.turn.isSidechain).toBe(true);
  });

  it("ignores isMeta lines", () => {
    expect(parseTranscriptLine(line({ type: "user", isMeta: true, message: { content: "x" } })).kind).toBe("ignored");
  });

  it("ignores tool_result-only user lines", () => {
    const p = parseTranscriptLine(
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] } }),
    );
    expect(p.kind).toBe("ignored");
  });

  it("ignores non-turn line types (snapshots, attachments, summaries)", () => {
    expect(parseTranscriptLine('{"type":"file-history-snapshot","messageId":"m"}').kind).toBe("ignored");
    expect(parseTranscriptLine('{"type":"attachment","uuid":"u"}').kind).toBe("ignored");
    expect(parseTranscriptLine('{"type":"summary","summary":"s"}').kind).toBe("ignored");
    expect(parseTranscriptLine("").kind).toBe("ignored");
  });

  it("counts malformed JSON and turns without required fields as broken", () => {
    expect(parseTranscriptLine("{ partial json").kind).toBe("broken");
    expect(parseTranscriptLine('"nur-ein-string"').kind).toBe("broken");
    const noUuid = { type: "user", message: { content: "x" }, sessionId: "s", cwd: "c", timestamp: "t" };
    expect(parseTranscriptLine(JSON.stringify(noUuid)).kind).toBe("broken");
    const noCwd = { type: "user", message: { content: "x" }, uuid: "u", sessionId: "s", timestamp: "t" };
    expect(parseTranscriptLine(JSON.stringify(noCwd)).kind).toBe("broken");
  });
});

describe("Assist-Rauschfilter (Paket 0)", () => {
  function turn(over: Partial<TranscriptTurn>): TranscriptTurn {
    return {
      uuid: "u",
      sessionId: "s",
      cwd: "c:/proj",
      role: "user",
      content: "",
      timestamp: "2026-07-10T00:00:00.000Z",
      isSidechain: false,
      ...over,
    };
  }

  it("verwirft ALLE Turns einer markierten Spawn-Session, behält echte", () => {
    const filter = createInternalSessionFilter();
    // Der Assistant-Turn trägt den Marker NICHT — er wird über die session_id verworfen.
    expect(
      filter.keep(turn({ sessionId: "spawn", role: "user", content: `${INTERNAL_MARKER}\nDu schreibst...` })),
    ).toBe(false);
    expect(filter.keep(turn({ sessionId: "spawn", role: "assistant", content: "Bericht" }))).toBe(false);
    expect(filter.keep(turn({ sessionId: "echt", role: "user", content: "Baue das Feature" }))).toBe(true);
    expect(filter.keep(turn({ sessionId: "echt", role: "assistant", content: "ok" }))).toBe(true);
  });

  it("erkennt Marker und Legacy-Präfixe nur bei kurzen Sessions", () => {
    expect(isInternalSession(`${INTERNAL_MARKER} x`, 2)).toBe(true);
    expect(isInternalSession("Du unterstützt einen Entwickler bei der Triage eines Inbox-Items", 2)).toBe(true);
    expect(isInternalSession("Du briefst den Product Owner eines Software-Projekts.", 1)).toBe(true);
    expect(isInternalSession("Du schreibst einen Standup-Bericht für einen Entwickler", 2)).toBe(true);
    // Echte lange Session, die zufällig so beginnt, bleibt sichtbar (Turn-Schranke).
    expect(isInternalSession("Du briefst den Product Owner eines Software-Projekts.", 5)).toBe(false);
    // Normaler Prompt / leer.
    expect(isInternalSession("Baue mir ein Login", 2)).toBe(false);
    expect(isInternalSession(null, 2)).toBe(false);
  });
});

describe("readTranscript (streaming)", () => {
  it("reads CRLF files and never throws on broken lines", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cockpit-transcript-"));
    const file = join(tmp, "t.jsonl");
    const content = [
      line({ type: "user", message: { content: "erste" } }),
      "{ kaputt",
      line({ type: "assistant", uuid: "u-2", message: { content: [{ type: "text", text: "zweite" }] } }),
      "",
    ].join("\r\n");
    writeFileSync(file, content, "utf8");
    const results: ParsedLine[] = [];
    for await (const p of readTranscript(file)) results.push(p);
    const kinds = results.map((r) => r.kind);
    expect(kinds.filter((k) => k === "turn")).toHaveLength(2);
    expect(kinds.filter((k) => k === "broken")).toHaveLength(1);
    const turns = results.flatMap((r) => (r.kind === "turn" ? [r.turn] : []));
    // CRLF darf nicht im Content kleben.
    expect(turns[0]?.content).toBe("erste");
    rmSync(tmp, { recursive: true, force: true });
  });
});
