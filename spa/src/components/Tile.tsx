import { cn } from "@/lib/utils";

// Klickbare Stat-Kachel (PLAN-PRD §6.2): Zahl groß (28px, tabular-nums), Label
// klein/uppercase und handlungsnah. Zero-Kacheln bleiben klickbar (echter
// Empty-State, nie tote Links); fokusbar, Enter/Space klickt.
export default function Tile({
  num,
  label,
  onClick,
  crit,
}: {
  num: number | string;
  label: string;
  onClick: () => void;
  crit?: boolean;
}) {
  const isZero = num === 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="ds-card-interactive px-5 py-4"
    >
      <div
        className={cn(
          "text-[32px] font-normal leading-none tabular-nums",
          crit && !isZero && "text-crit",
          isZero && "text-ink-2",
        )}
      >
        {num}
      </div>
      <div className="mt-2 text-xs font-medium uppercase tracking-wider text-ink-2">{label}</div>
    </div>
  );
}
