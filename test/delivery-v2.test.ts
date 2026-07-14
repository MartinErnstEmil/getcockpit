// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Zustellung v2: die harten Zusicherungen scharf testen — Angebote finalisieren
// nie, ACK ist exactly-once + projekt-gescopet, Poison-Cap tötet laut (nie
// löschend), "erneut senden" bringt zurück in die Outbox. Echte Datei-DB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OFFER_POISON_CAP } from "../src/schema.js";
import { makeTempStore, type TempStore } from "./helpers.js";

let ts: TempStore;

function seedAnswer(project: string, answer = "menschliche Antwort"): string {
  const item = ts.store.addItem({ type: "question", title: "Frage?", projectPath: project, source: "claude" });
  ts.store.answerItem(item.id, answer, "human");
  return item.id;
}

beforeEach(() => {
  ts = makeTempStore("cockpit-deliv2-");
});
afterEach(() => ts.cleanup());

describe("recordOffer — Dedup + Poison-Cap", () => {
  it("dedupt je (item, session): frisch true, dann false", () => {
    const id = seedAnswer("c:/dev/p");
    expect(ts.store.recordOffer(id, "s-1")).toBe(true);
    expect(ts.store.recordOffer(id, "s-1")).toBe(false); // schon angeboten
    expect(ts.store.recordOffer(id, "s-2")).toBe(true); // andere Session -> erneut
    expect(ts.store.getItem(id)?.offeredAt).toBeTruthy();
  });

  it("tötet nach OFFER_POISON_CAP Angeboten (laut, nicht löschend) und nimmt es aus der Auswahl", () => {
    const id = seedAnswer("c:/dev/p");
    for (let i = 0; i < OFFER_POISON_CAP; i++) ts.store.recordOffer(id, `s-${i}`);
    const item = ts.store.getItem(id);
    expect(item?.dead).toBe(true);
    expect(item?.answer).toBe("menschliche Antwort"); // Antwort NIE gelöscht
    // dead ist aus der Auswahl (PUSH/PULL) raus:
    expect(ts.store.offerForPickup("c:/dev/p", null, "s-x")).toHaveLength(0);
  });
});

describe("ackAnswers — exactly-once + projekt-gescopet", () => {
  it("finalisiert genau einmal (zweiter Ack ist leer)", () => {
    const id = seedAnswer("c:/dev/p");
    const first = ts.store.ackAnswers([id], "c:/dev/p");
    expect(first.map((r) => r.uuid)).toEqual([id]);
    expect(ts.store.getItem(id)?.deliveredAt).toBeTruthy();
    // Zweiter Ack: nichts mehr offen -> leer (idempotent).
    expect(ts.store.ackAnswers([id], "c:/dev/p")).toHaveLength(0);
  });

  it("ackt NICHT über Projektgrenzen (kein Cross-Projekt-Verlust)", () => {
    const id = seedAnswer("c:/dev/a");
    expect(ts.store.ackAnswers([id], "c:/dev/b")).toHaveLength(0);
    expect(ts.store.getItem(id)?.deliveredAt).toBeFalsy();
    // Richtiges Projekt finalisiert:
    expect(ts.store.ackAnswers([id], "c:/dev/a")).toHaveLength(1);
  });

  it("leere itemIds sind ein No-op (kein SQL-Fehler)", () => {
    expect(ts.store.ackAnswers([], "c:/dev/p")).toEqual([]);
  });
});

describe("offerForPickup — nicht-finalisierend + scoped", () => {
  it("gibt Inhalt zurück ohne zu finalisieren; scopet auf itemIds", () => {
    const a = seedAnswer("c:/dev/p", "A");
    const b = seedAnswer("c:/dev/p", "B");
    const only = ts.store.offerForPickup("c:/dev/p", [a], "mcp");
    expect(only.map((r) => r.uuid)).toEqual([a]);
    // nicht finalisiert -> zweiter Pull liefert es weiter (kein stiller Verlust):
    expect(ts.store.offerForPickup("c:/dev/p", [a], "mcp").map((r) => r.uuid)).toEqual([a]);
    expect(ts.store.getItem(a)?.deliveredAt).toBeFalsy();
    // ohne Scope: beide anbietbar
    expect(ts.store.offerForPickup("c:/dev/p", null, "mcp").map((r) => r.uuid).sort()).toEqual([a, b].sort());
  });
});

describe("resendAnswer — zurück in die Outbox, nie löschend", () => {
  it("setzt delivered/offered/dead zurück und löscht Angebote, behält die Antwort", () => {
    const id = seedAnswer("c:/dev/p", "geheim");
    for (let i = 0; i < OFFER_POISON_CAP; i++) ts.store.recordOffer(id, `s-${i}`);
    ts.store.ackAnswers([id], "c:/dev/p");
    expect(ts.store.getItem(id)?.dead).toBe(true);

    const back = ts.store.resendAnswer(id);
    expect(back?.answer).toBe("geheim"); // Antwort erhalten
    expect(back?.deliveredAt).toBeFalsy();
    expect(back?.offeredAt).toBeFalsy();
    expect(back?.dead).toBe(false);
    // wieder anbietbar:
    expect(ts.store.offerForPickup("c:/dev/p", null, "s-neu").map((r) => r.uuid)).toEqual([id]);
  });
});
