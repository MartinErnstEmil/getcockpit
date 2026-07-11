import type { ReactNode } from "react";

// Neutraler Leer-/Ladezustand. Fehler haben eine eigene rote Box (StateView).
export default function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center text-ink-2">
      <div className="text-sm">{title}</div>
      {hint && <div className="max-w-md text-xs">{hint}</div>}
    </div>
  );
}
