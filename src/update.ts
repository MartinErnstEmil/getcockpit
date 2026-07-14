// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Update-Verfügbarkeit (nicht-blockierend, fail-open). Fragt die npm-Registry
// nach der neuesten getcockpit-Version und vergleicht mit der laufenden. Offline
// oder bei jedem Fehler: kein Update gemeldet, NIE ein Fehler nach außen — die
// Prüfung darf App-Start und SPA nie aufhalten.
import { COCKPIT_VERSION } from "./index.js";

const REGISTRY_URL = "https://registry.npmjs.org/getcockpit/latest";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export async function checkForUpdate(timeoutMs = 3000): Promise<UpdateInfo> {
  const current = COCKPIT_VERSION;
  const none: UpdateInfo = { current, latest: null, updateAvailable: false };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return none;
    const latest = (await res.json() as { version?: string }).version ?? null;
    return { current, latest, updateAvailable: latest !== null && isNewer(latest, current) };
  } catch {
    return none; // Netzfehler/Timeout/JSON: still schlucken, nur „kein Update".
  }
}

// Numerischer semver-Vergleich (major.minor.patch); Vorabversions-Suffixe werden
// über parseInt auf die Zahl reduziert — für „neuer als" genau genug.
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}
