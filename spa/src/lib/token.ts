// Token-Fluss der SPA (PLAN-PRD §2): `?token=` beim Boot lesen ->
// sessionStorage -> history.replaceState (Token raus aus der Adresszeile) ->
// danach trägt jeder API-Call den Header x-cockpit-token. Kein localStorage,
// kein Token in der Query nach dem Boot. Der reine Kern (extractToken,
// stripTokenParam) ist DOM-frei und wird per Vitest geprüft (§10A).

const STORAGE_KEY = "cockpit-token";

// Token aus einem Query-String ziehen (reiner Kern, testbar).
export function extractToken(search: string): string | null {
  return new URLSearchParams(search).get("token");
}

// `token` aus einem vollständigen URL-String entfernen und den bereinigten
// Pfad+Query+Hash zurückgeben (reiner Kern, testbar). Erhält alle anderen
// Parameter (z. B. ?scope=, ?item=), damit Deep-Links den Boot überleben.
export function stripTokenParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("token");
  return url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "") + url.hash;
}

// Boot: falls ?token= vorhanden, in sessionStorage sichern und aus der URL
// entfernen. Idempotent — ein vorhandenes sessionStorage-Token bleibt.
export function bootToken(): void {
  const fromUrl = extractToken(window.location.search);
  if (fromUrl) {
    window.sessionStorage.setItem(STORAGE_KEY, fromUrl);
    window.history.replaceState(null, "", stripTokenParam(window.location.href));
  }
}

export function getToken(): string | null {
  return window.sessionStorage.getItem(STORAGE_KEY);
}
