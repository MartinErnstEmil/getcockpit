// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Hook-Einstieg (PRD F3, ADR-006): EIN Node-Prozess pro Event, In-Process-
// Dispatch, Exit-Code IMMER 0 — ein Hook darf Claude nie blockieren.
// Fehlerpfade: hooks.log (Diagnose) + dead-letter.jsonl (nur bei DB-Fehler).
// Exit-0-Disziplin konzeptionell aus dev/cola cola-hook-capture.cjs
// (ursprünglich MIT, (c) 2026, relizenziert durch denselben Rechteinhaber).
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectGitState } from "../gitinfo.js";
import { cockpitHome, deadLetterPath, hooksLogPath, resolveDbPath } from "../paths.js";
import { redactText } from "../redact.js";
import { createInternalSessionFilter, parseTranscriptLine, type TranscriptTurn } from "../transcript.js";
import { buildBriefing, renderClaimedContext } from "./briefing.js";
import { captureEnabled, claimHumanAnswers, gitMode, insertHookTurn, openHookDb, recordHookEvent, upsertGitState } from "./hookdb.js";
import { takeAutoSnapshot } from "./snapshot.js";

const TAIL_BYTES = 256 * 1024;

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
}

function logLine(message: string): void {
  try {
    mkdirSync(cockpitHome(), { recursive: true, mode: 0o700 });
    appendFileSync(hooksLogPath(), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Logging ist best-effort; der Hook bleibt still.
  }
}

function deadLetter(record: unknown): void {
  try {
    mkdirSync(cockpitHome(), { recursive: true, mode: 0o700 });
    appendFileSync(deadLetterPath(), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Letzte Eskalationsstufe — mehr geht nicht ohne Exit != 0 zu riskieren.
  }
}

function captureOptedOut(cwd: string | undefined): boolean {
  if (!cwd) return false;
  // .cola/no-capture bleibt als Alt-Opt-out gültig (bestehende Projekte).
  return (
    existsSync(join(cwd, ".cockpit", "no-capture")) || existsSync(join(cwd, ".cola", "no-capture"))
  );
}

// Tail-Read statt Vollfile (PRD F3: <= 2 s Stop-Budget bei beliebig großen
// Transcripts). Erste (potenziell angeschnittene) Zeile wird verworfen.
function readTail(filePath: string, maxBytes = TAIL_BYTES): string {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}

function handlePrompt(payload: HookPayload): void {
  const prompt = (payload.prompt ?? "").trim();
  // Leerer-Prompt-Pfad MUSS ohne DB/Ausgabe zurückkehren (hooks.test.ts).
  if (!payload.session_id || !prompt) return;
  const db = openHookDb(resolveDbPath());
  try {
    // DB-Opt-out (Paket 5): Aufzeichnung für dieses Projekt abgeschaltet →
    // nichts schreiben, nichts injizieren (analog zum Datei-Opt-out).
    if (payload.cwd && !captureEnabled(db, payload.cwd)) return;
    // Kein Turn (keine Transcript-uuid verfügbar, D4) — Event als
    // Crash-Sicherung und Capture-Quote-Basis, Prompt redacted.
    recordHookEvent(db, {
      eventType: "hook_prompt",
      sessionId: payload.session_id,
      projectPath: payload.cwd,
      payload: { prompt: redactText(prompt).text },
    });
    // On-the-fly-Zustellung (Paket 1): menschliche Antworten dieses Projekts
    // atomar beanspruchen und als additionalContext injizieren — beim nächsten
    // Prompt derselben laufenden Session, ohne neuen Prozess/Kanal. Nur bei
    // Treffer valides JSON auf stdout (Hook-Parsing sonst gebrochen). Kein
    // Git-Collect/Tail-Read auf diesem Pre-Turn-Pfad (Latenz).
    if (payload.cwd) {
      const claimed = claimHumanAnswers(db, payload.cwd);
      if (claimed.length > 0) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: renderClaimedContext(claimed),
            },
          }) + "\n",
        );
      }
    }
  } finally {
    db.close();
  }
}

function handleStop(payload: HookPayload): void {
  if (!payload.session_id || !payload.transcript_path) return;
  if (!existsSync(payload.transcript_path)) return;
  const turns = collectTailTurns(payload.transcript_path);
  if (turns.length === 0) return;
  const db = openHookDb(resolveDbPath());
  try {
    // DB-Opt-out (Paket 5): Projekt-Aufzeichnung aus → keine Turns schreiben.
    if (payload.cwd && !captureEnabled(db, payload.cwd)) return;
    let inserted = 0;
    let redactions = 0;
    for (const t of turns) {
      const r = insertHookTurn(db, t);
      if (r.inserted) inserted++;
      redactions += r.redactions;
    }
    recordHookEvent(db, {
      eventType: "hook_stop",
      sessionId: payload.session_id,
      projectPath: payload.cwd,
      payload: { tailTurns: turns.length, inserted, redactions },
    });
    // Git-Cache opportunistisch aktualisieren (PRD F10): der Stop-Hook läuft
    // ohnehin post-session — `status` liest dann Sub-ms aus SQLite statt
    // Repos zu shellen. Best-effort: null (kein Repo) überschreibt nichts.
    if (payload.cwd) {
      const g = collectGitState(payload.cwd);
      if (g) upsertGitState(db, g);
    }
    // Auto-Snapshot (Git-Modi, mode='auto'): sichert den Arbeitsstand unter
    // refs/cockpit/ ohne HEAD/Index/Worktree zu berühren. Fail-open — jeder
    // Fehler landet in hooks.log (via logLine), nie in einer Exception.
    if (payload.cwd && gitMode(db, payload.cwd) === "auto") {
      const snap = takeAutoSnapshot(payload.cwd, payload.session_id, logLine);
      if (snap) {
        recordHookEvent(db, {
          eventType: "git_snapshot",
          sessionId: payload.session_id,
          projectPath: payload.cwd,
          payload: { sha: snap.sha },
        });
      }
    }
  } finally {
    db.close();
  }
}

// SessionStart-Briefing (F7): nur startup/resume, Off-Switch dokumentiert,
// stdout trägt das hookSpecificOutput-JSON für Claude Code.
function handleSessionStart(payload: HookPayload): void {
  if (payload.source !== "startup" && payload.source !== "resume") return;
  if (process.env["COCKPIT_NO_BRIEFING"] === "1") return;
  if (!payload.session_id || !payload.cwd) return;
  const db = openHookDb(resolveDbPath());
  try {
    // DB-Opt-out (Paket 5): Projekt-Aufzeichnung aus → kein Briefing zustellen.
    if (!captureEnabled(db, payload.cwd)) return;
    const text = buildBriefing(db, payload.session_id, payload.cwd);
    if (!text) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
      }) + "\n",
    );
  } finally {
    db.close();
  }
}

// Alle Turns aus dem Tail (User UND Assistant, echte Transcript-uuids):
// derselbe Dedupe-Schlüssel wie der Backfill (ADR-005, D4).
function collectTailTurns(transcriptPath: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  // Assist-Rauschfilter (Paket 0): interne Spawn-Sessions nicht erfassen —
  // ihre 2 Turns passen komplett in den Tail, Marker steht im ersten User-Turn.
  const internal = createInternalSessionFilter();
  for (const line of readTail(transcriptPath).split(/\r?\n/)) {
    const parsed = parseTranscriptLine(line);
    if (parsed.kind === "turn" && internal.keep(parsed.turn)) turns.push(parsed.turn);
  }
  return turns;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolvePromise(raw));
    process.stdin.on("error", () => resolvePromise(raw));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    logLine("broken stdin payload (kein JSON)");
    return;
  }
  if (captureOptedOut(payload.cwd)) return;
  const event = payload.hook_event_name;
  try {
    if (event === "UserPromptSubmit") handlePrompt(payload);
    else if (event === "Stop") handleStop(payload);
    else if (event === "SessionStart") handleSessionStart(payload);
    // Unbekannte Events enden still (Exit 0).
  } catch (err) {
    logLine(`${event ?? "?"}: ${err instanceof Error ? err.message : String(err)}`);
    deadLetter({ at: new Date().toISOString(), event, payload, error: String(err) });
  }
}

// process.exit(0) hart am Ende JEDES Pfades — auch bei unerwarteten Fehlern
// in main() selbst darf kein Non-Zero-Exit nach außen.
main()
  .catch((err: unknown) => logLine(`fatal: ${String(err)}`))
  .finally(() => process.exit(0));
