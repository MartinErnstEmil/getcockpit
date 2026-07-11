import { getToken } from "@/lib/token";

// Server-Fehler wörtlich anzeigen, nie schlucken (PLAN-PRD §1.4.7). Der Body
// der API ist {error: "..."} — den ziehen wir raus und werfen ihn als Message,
// damit die rote Fehlerbox (StateView) die echte Servermeldung zeigt.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // kein JSON-Body — Statuszeile genügt
  }
  return `${res.status} ${res.statusText}`;
}

// Jeder API-Call trägt den Token-Header (PLAN-PRD §2). 403 -> ApiError mit
// Status, damit die Shell einen globalen Klartext-Fehlerzustand zeigen kann.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-cockpit-token": token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
}
