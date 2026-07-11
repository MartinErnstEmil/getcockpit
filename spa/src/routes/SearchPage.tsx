import { useState } from "react";
import { useScope } from "@/lib/useScope";
import { searchTurns } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import { shortName, dayMonth } from "@/lib/utils";
import type { TurnHit } from "@/api/types";

// «…» markiert der FTS-Snippet die Treffer; hier fett rendern (kein HTML aus
// Serverdaten interpolieren — nur Text-Split).
function Snippet({ text }: { text: string }) {
  const parts = text.split(/[«»]/);
  return (
    <span>
      {parts.map((p, i) => (i % 2 === 1 ? <b key={i} className="bg-hl">{p}</b> : <span key={i}>{p}</span>))}
    </span>
  );
}

// /search — Volltextsuche über alle erfassten Sessions (PLAN-PRD §6).
export default function SearchPage() {
  const { scope } = useScope();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [hits, setHits] = useState<TurnHit[]>([]);
  const [error, setError] = useState<unknown>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState("loading");
    setError(null);
    try {
      const r = await searchTurns(q, scope);
      setHits(r.hits);
      setState("done");
    } catch (err) {
      setError(err);
      setState("error");
    }
  }

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      <h2 className="mb-3 text-[15px] font-semibold">
        Suche <span className="ml-2 text-xs font-normal text-ink-2">Volltext über alle erfassten Sessions</span>
      </h2>
      <form onSubmit={run} className="mb-4 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Warum haben wir X entschieden?"
          className="ds-field max-w-[30rem]"
        />
        <button type="submit" disabled={state === "loading" || !query.trim()} className="ds-btn-primary">
          {state === "loading" ? "Sucht…" : "Suchen"}
        </button>
      </form>

      {state === "error" ? (
        <ErrorBox error={error} onRetry={() => void run(new Event("submit") as unknown as React.FormEvent)} />
      ) : state === "idle" ? (
        <p className="italic text-ink-2">Noch keine Suche.</p>
      ) : state === "loading" ? (
        <p className="italic text-ink-2">Sucht…</p>
      ) : hits.length === 0 ? (
        <p className="italic text-ink-2">Keine Treffer.</p>
      ) : (
        <div className="ds-card divide-y divide-line">
          {hits.map((h) => (
            <div key={h.uuid} className="px-4 py-3">
              <div className="text-xs text-ink-2">{dayMonth(h.timestamp)} · {h.role} · {shortName(h.projectPath)}</div>
              <div className="text-sm"><Snippet text={h.snippet} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
