// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Secret-Redaction am Ingest (PRD F4): läuft vor JEDEM Persistieren, in
// Capture UND Backfill. Roh-Treffer erreichen die DB nie.

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
  total: number;
}

const PATTERNS: ReadonlyArray<{ type: string; re: RegExp }> = [
  // PEM zuerst: mehrzeilig; die inneren Base64-Zeilen dürfen nicht einzeln
  // vom Entropie-Pass getroffen werden, sonst zählt ein Key mehrfach.
  {
    type: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { type: "api-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { type: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { type: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
];

// Kandidaten für den Entropie-Pass: base64-artige Läufe ab 32 Zeichen.
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g;
// Zufalls-Token (64er-Alphabet) liegen bei ~4.8+ bits/Zeichen; camelCase-
// Bezeichner und Hex-Hashes (git-SHAs!) bleiben darunter bzw. scheitern an
// der Drei-Klassen-Pflicht. Schwelle empirisch in test/redact.test.ts belegt.
const ENTROPY_THRESHOLD = 4.3;

function shannonEntropyPerChar(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isHighEntropyToken(m: string): boolean {
  if (!(/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m))) return false;
  return shannonEntropyPerChar(m) >= ENTROPY_THRESHOLD;
}

export function redactText(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  for (const { type, re } of PATTERNS) {
    text = text.replace(re, () => {
      counts[type] = (counts[type] ?? 0) + 1;
      return `[REDACTED:${type}]`;
    });
  }
  text = text.replace(HIGH_ENTROPY_CANDIDATE, (m) => {
    if (!isHighEntropyToken(m)) return m;
    counts["high-entropy"] = (counts["high-entropy"] ?? 0) + 1;
    return "[REDACTED:high-entropy]";
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}
