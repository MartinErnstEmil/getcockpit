// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Treiberfreie Mini-Helfer: werden sowohl vom better-sqlite3-Store als auch
// vom node:sqlite-Hook-Bundle gebündelt (D2 — keine nativen Imports hier).
import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
