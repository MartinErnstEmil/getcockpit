// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, it, expect } from "vitest";
import { redactText } from "../src/redact.js";

describe("redactText (PRD F4)", () => {
  it("redacts every pattern type from the PRD list", () => {
    const fixture = [
      "openai key sk-proj1234567890abcdefXYZ done",
      "github ghp_abcdefghij1234567890KLMNOP end",
      "aws AKIAIOSFODNN7EXAMPLE end",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM end",
      "auth Bearer abc123def456ghi789jkl012 end",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "random vRq7xK2mPzA9bL4tYw8nC3jHfD6gSeU1",
    ].join("\n");
    const { text, counts, total } = redactText(fixture);
    expect(text).not.toContain("sk-proj");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(text).not.toContain("Bearer abc123");
    expect(text).not.toContain("MIIEowIBAAKCAQEA");
    expect(text).not.toContain("vRq7xK2mPzA9bL4tYw8nC3jHfD6gSeU1");
    expect(counts["api-key"]).toBe(1);
    expect(counts["github-token"]).toBe(1);
    expect(counts["aws-key"]).toBe(1);
    expect(counts["jwt"]).toBe(1);
    expect(counts["bearer-token"]).toBe(1);
    expect(counts["private-key"]).toBe(1);
    expect(counts["high-entropy"]).toBe(1);
    expect(total).toBe(7);
  });

  it("leaves ordinary prose, identifiers, git SHAs and UUIDs intact", () => {
    const benign = [
      "Die Funktion getUserAccountBalanceFromDatabase42 wird aufgerufen.",
      "commit 3f2a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a fixed it",
      "id 550e8400-e29b-41d4-a716-446655440000 in der Tabelle",
      "Pfad C:\\Users\\jane\\dev\\cockpit\\src\\store.ts Zeile 42",
    ].join("\n");
    const { text, total } = redactText(benign);
    expect(text).toBe(benign);
    expect(total).toBe(0);
  });

  it("counts multiple hits of the same type", () => {
    const { counts } = redactText("sk-abcdefgh12345678 and sk-zyxwvuts87654321");
    expect(counts["api-key"]).toBe(2);
  });
});
