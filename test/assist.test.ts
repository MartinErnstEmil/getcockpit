// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Assist-Gate: Prompt trägt Item-Kontext, Ergebnis ist flüchtig (keine
// Persistenz), Fehlerpfade degradieren sauber, Web-Route validiert kind.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAssist } from "../src/assist.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;

beforeEach(() => {
  ts = makeTempStore("cockpit-assist-");
});

afterEach(() => {
  ts.cleanup();
});

function echoScript(): string {
  const p = join(ts.dir, "assist-echo.cjs");
  writeFileSync(
    p,
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('ASSIST-OK:'+(d.includes('Farbfrage')?'ctx':'noctx')))",
    "utf8",
  );
  return p;
}

describe("runAssist", () => {
  it("sends item context via stdin and returns the text, persisting nothing", async () => {
    const item = ts.store.addItem({ type: "question", title: "Farbfrage", body: "Blau oder Grün?", projectPath: "c:/dev/p" });
    const before = ts.store.rawDb().prepare("SELECT COUNT(*) c FROM items").get() as { c: number };
    const res = await runAssist(ts.store, {
      itemId: item.id,
      kind: "pros-cons",
      claudeCmd: { cmd: process.execPath, baseArgs: [echoScript()] },
      timeoutMs: 10_000,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("ASSIST-OK:ctx");
    const after = ts.store.rawDb().prepare("SELECT COUNT(*) c FROM items").get() as { c: number };
    expect(after.c).toBe(before.c); // flüchtig: kein Item, keine Antwort persistiert
    const ev = ts.store.rawDb()
      .prepare("SELECT COUNT(*) c FROM events WHERE event_type='assist_run'")
      .get() as { c: number };
    expect(ev.c).toBe(1);
  });

  it("reports missing item and dead binary as errors, never throws", async () => {
    const missing = await runAssist(ts.store, {
      itemId: "i-gibtesnicht",
      kind: "explain",
      claudeCmd: { cmd: process.execPath, baseArgs: [echoScript()] },
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("nicht gefunden");

    const item = ts.store.addItem({ type: "question", title: "X", projectPath: "c:/dev/p" });
    const dead = await runAssist(ts.store, {
      itemId: item.id,
      kind: "swot",
      claudeCmd: { cmd: "cockpit-kein-binary", baseArgs: [] },
      timeoutMs: 5_000,
    });
    expect(dead.ok).toBe(false);
    expect(dead.error).toContain("LLM nicht verfügbar");
  });
});
