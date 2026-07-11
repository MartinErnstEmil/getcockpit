import type { ReactNode } from "react";
import EmptyState from "./EmptyState";
import { ApiError } from "@/api/client";

// StateView-Erweiterung (Auflage P4): vier Zustände je View mit onRetry-Callback
// und einer ROTEN Fehlerbox, die die WÖRTLICHE Servermeldung zeigt (nie
// schlucken, §1.4.7) plus Button "Erneut versuchen". Deutsche Texte.
type Props<T> = {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  onRetry?: () => void;
  empty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  loadingTitle?: string;
  children: (data: T) => ReactNode;
};

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  // Carbon Inline Notification (error): eckig, 4px Fehler-Kante links, Layer-Bg.
  return (
    <div className="my-3 border-l-4 border-crit bg-panel px-4 py-3 text-sm text-ink">
      <div className="whitespace-pre-wrap">{message}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center border border-outline px-4 py-1.5 text-xs font-normal text-accent-text hover:bg-surface-container"
        >
          Erneut versuchen
        </button>
      )}
    </div>
  );
}

export default function StateView<T>({
  isLoading,
  error,
  data,
  onRetry,
  empty,
  emptyTitle,
  emptyHint,
  loadingTitle,
  children,
}: Props<T>) {
  if (error) return <ErrorBox error={error} onRetry={onRetry} />;
  if (isLoading) return <EmptyState title={loadingTitle ?? "Lädt…"} />;
  if (data === undefined) return <EmptyState title="Keine Daten." />;
  if (empty && empty(data)) return <EmptyState title={emptyTitle ?? "Nichts vorhanden."} hint={emptyHint} />;
  return <>{children(data)}</>;
}
