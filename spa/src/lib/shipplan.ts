// Reine Ableitung des "Live"-Plans aus den Roh-Signalen (Ship-Tab Slice 1).
// Kein DOM, kein React, kein Netz, keine Ausführung — getestet über
// spa-helpers.test.ts. Spiegelt die Philosophie von gitactions.ts: erkennen und
// beraten, nie ausführen; unsichere/mehrdeutige Aktion -> command=null, der Weg
// führt über die eigene Session.
//
// Terminologie-Leitplanke (Review C1): "Sicherheit" endet beim push. Produktion
// bekommt das Wortfeld "live / läuft / im Netz" — NIE "sicher live". Ein roter
// Zustand heißt "gestoppt", nicht "fehlgeschlagen" (kein Schuld-Ton).

import type { ShipSignals } from "@/api/types";

export interface DeployTarget {
  name: string;
  // Kandidaten-Kommando; null, wenn ein Ein-Zeilen-Kommando irreführend wäre
  // (mehrdeutiges Ziel oder reines Push-to-Deploy).
  command: string | null;
  // Geht das Projekt vermutlich schon beim Hochladen (push) automatisch live?
  pushToDeploy: boolean;
  // Klartext-Vorbehalt (Konto/Verknüpfung/Push-to-Deploy sind lokal nicht sicher
  // erkennbar).
  note: string;
  // Fertiger Prompt für die eigene Session (Primärweg, respektiert deploy-discipline).
  sessionPrompt: string;
}

export interface ReadinessGate {
  // Gate-Kommando zum Kopieren; null, wenn kein Test/Build erkennbar.
  command: string | null;
  sessionPrompt: string;
}

export interface ShipPlan {
  targets: DeployTarget[];
  gate: ReadinessGate;
}

const has = (s: ShipSignals, f: string): boolean => s.files.includes(f);

function handToSession(name: string): string {
  return `Ich möchte mein Projekt live bringen (${name}). Prüf zuerst, ob es beim Hochladen (push) automatisch live geht oder ein Deploy-Kommando braucht, und führe dann die sichere Variante gemäß meiner Deploy-Regeln aus. Erklär mir in einem Satz, was du tust.`;
}

// Benannte Ziele zuerst; mehrdeutige Signale (Dockerfile/Procfile/Workflow)
// werden NUR dann als Ziel gezeigt, wenn kein benanntes Ziel vorliegt — sonst
// würde Cockpit ein Ziel behaupten, das es nicht kennt.
function deriveDeployTargets(s: ShipSignals): DeployTarget[] {
  const t: DeployTarget[] = [];
  if (has(s, "vercel.json") || has(s, ".vercel/project.json")) {
    t.push({
      name: "Vercel",
      command: "vercel --prod",
      pushToDeploy: true,
      note: "Ist dein Vercel-Projekt mit GitHub verbunden, geht es beim Hochladen (push) automatisch live — dann brauchst du gar kein Kommando.",
      sessionPrompt: handToSession("Vercel"),
    });
  }
  if (has(s, "netlify.toml") || has(s, ".netlify/state.json")) {
    t.push({
      name: "Netlify",
      command: "netlify deploy --prod",
      pushToDeploy: true,
      note: "Bei verbundenem Git-Projekt geht Netlify beim Hochladen automatisch live.",
      sessionPrompt: handToSession("Netlify"),
    });
  }
  if (has(s, "fly.toml")) {
    t.push({
      name: "Fly.io",
      command: "fly deploy",
      pushToDeploy: false,
      note: "Fly.io liefert per Kommando aus (nicht automatisch beim Hochladen). Setzt einen fly-Login voraus.",
      sessionPrompt: handToSession("Fly.io"),
    });
  }
  if (has(s, "wrangler.toml") || has(s, "wrangler.jsonc")) {
    t.push({
      name: "Cloudflare",
      command: "wrangler deploy",
      pushToDeploy: false,
      note: "Cloudflare liefert per Kommando aus. Setzt einen wrangler-Login voraus.",
      sessionPrompt: handToSession("Cloudflare"),
    });
  }
  if (has(s, "render.yaml")) {
    t.push({
      name: "Render",
      command: null,
      pushToDeploy: true,
      note: "Render liefert in der Regel automatisch beim Hochladen (push) aus — meist genügt hochladen.",
      sessionPrompt: handToSession("Render"),
    });
  }
  // Mehrdeutige Fallbacks nur ohne benanntes Ziel.
  if (t.length === 0 && s.deployWorkflow) {
    t.push({
      name: "GitHub-Actions-Workflow",
      command: null,
      pushToDeploy: true,
      note: "Du lieferst über einen GitHub-Actions-Workflow aus — der ist die Quelle der Wahrheit. Meist startet er beim Hochladen (push) automatisch.",
      sessionPrompt: handToSession("GitHub-Actions-Workflow"),
    });
  }
  if (t.length === 0 && has(s, "Dockerfile")) {
    t.push({
      name: "Container (Ziel offen)",
      command: null,
      pushToDeploy: false,
      note: "Ein Dockerfile ist noch kein Ziel — du kannst es überallhin ausliefern. Sag deiner Session, wohin es soll.",
      sessionPrompt:
        "Mein Projekt hat ein Dockerfile, aber kein festes Ziel. Zeig mir 2-3 einfache Wege, es live zu bringen, je mit Vor- und Nachteilen.",
    });
  }
  if (t.length === 0 && has(s, "Procfile")) {
    t.push({
      name: "Ziel unklar (Procfile)",
      command: null,
      pushToDeploy: false,
      note: "Ein Procfile passt zu mehreren Anbietern (Heroku/Fly/Render) — welcher es ist, verrät die Datei allein nicht.",
      sessionPrompt:
        "Mein Projekt hat ein Procfile. Finde heraus, zu welchem Anbieter es gehört, und sag mir Schritt für Schritt, wie ich live gehe.",
    });
  }
  return t;
}

// Gate-Kommando je Stack — reine Empfehlung zum Kopieren bzw. Session-Weg.
// Cockpit führt es NIE selbst aus (Runner-Verbot, Review C1/D10).
function deriveGate(s: ShipSignals): ReadinessGate {
  const prompt =
    "Bin ich startklar zum Live-Gehen? Lauf meine Tests/Lint/Build und sag mir in EINEM Satz: bereit oder nicht — und wenn nicht, was fehlt. Committe und deploye dabei nichts.";
  if (has(s, "package.json")) {
    const order = ["lint", "test", "build"].filter((n) => s.npmScripts.includes(n));
    const command = order.length
      ? order.map((n) => (n === "test" ? "npm test" : `npm run ${n}`)).join(" && ")
      : null;
    return { command, sessionPrompt: prompt };
  }
  if (has(s, "pyproject.toml")) return { command: "pytest", sessionPrompt: prompt };
  if (has(s, "go.mod")) return { command: "go build ./... && go test ./...", sessionPrompt: prompt };
  if (has(s, "Cargo.toml")) return { command: "cargo build && cargo test", sessionPrompt: prompt };
  if (has(s, "Makefile")) return { command: "make test", sessionPrompt: prompt };
  return { command: null, sessionPrompt: prompt };
}

export function deriveShipPlan(signals: ShipSignals): ShipPlan {
  return { targets: deriveDeployTargets(signals), gate: deriveGate(signals) };
}
