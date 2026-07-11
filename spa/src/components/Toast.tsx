import { useEffect } from "react";

export interface ToastState {
  text: string;
  undoLabel?: string;
  onUndo?: () => void;
  key: number; // erzwingt Re-Trigger des Auto-Hide bei gleichem Text
}

// Toast: 5 s, ein Puffer, kein Stack (PLAN-PRD §5). Undo-Aktion optional.
export default function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-20 flex max-w-[90vw] -translate-x-1/2 items-center gap-3 border-l-4 border-accent bg-[#393939] px-4 py-3 text-sm text-[#f4f4f4] shadow-overlay">
      {toast.text}
      {toast.onUndo && (
        <button
          type="button"
          className="px-3 py-1 text-xs font-medium text-[#78a9ff] underline decoration-[#78a9ff]/60 hover:bg-white/10"
          onClick={() => {
            toast.onUndo?.();
          }}
        >
          {toast.undoLabel}
        </button>
      )}
    </div>
  );
}
