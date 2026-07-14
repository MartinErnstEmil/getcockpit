import { useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "@/lib/i18n";
import { ageText } from "@/lib/utils";
import { useResendAnswer } from "@/api/queries";
import type { Item } from "@/api/types";

// Zustell-Quittung (Zustellung v2): eine Zustandszeile unter der Antwort einer
// beantworteten Karte — teilt sich ItemCard (Inbox) und DecisionsPage. Vier
// Zustände: dead (laut + erneut senden) · bestätigt (geackt) · zugestellt-
// unbestätigt (angeboten, Agent hat noch nicht bestätigt) · wartet (noch nicht
// angeboten). "Bestätigt" heißt: der Agent hat per ack_answers finalisiert.
const AGING_MS = 24 * 60 * 60 * 1000;

// Älter als die Aging-Schwelle? (ab hier bietet die UI den manuellen Kopier-Weg an)
const aged = (ts?: string): boolean => !!ts && Date.now() - Date.parse(ts) > AGING_MS;

export default function DeliveryState({ item }: { item: Item }) {
  const t = useT();
  const resend = useResendAnswer();
  if (item.status !== "answered") return null;

  // Tot (Poison-Cap erreicht): laut, mit menschlichem "erneut senden" — die
  // Antwort geht dabei NIE verloren, sie wandert nur zurück in die Outbox.
  if (item.dead) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-crit">
        <span className="font-semibold">{t("delivery.dead")}</span>
        <button
          type="button"
          disabled={resend.isPending}
          onClick={() => resend.mutate({ id: item.id })}
          className="ds-btn-ghost border border-line !px-2 !py-0.5"
        >
          {resend.isPending ? t("delivery.resending") : t("delivery.resend")}
        </button>
      </div>
    );
  }

  // Bestätigt (geackt): der Agent hat die Antwort umgesetzt.
  if (item.deliveredAt) {
    const via = t(`delivery.via.${item.delivery?.via ?? "prompt"}`);
    const sid = item.delivery?.sessionId;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-ok">
        <span>{t("delivery.delivered", { age: ageText(item.deliveredAt), via })}</span>
        {sid && item.delivery?.via !== "mcp" && (
          <Link to={`/sessions/${sid}`} className="font-mono text-accent underline decoration-dotted">
            {t("delivery.session", { id: sid.slice(0, 8) })}
          </Link>
        )}
      </div>
    );
  }

  // Zugestellt, aber unbestätigt: injiziert/abgeholt, aber der Agent hat noch
  // nicht per ack_answers finalisiert. Ab 24 h Kopier-Knopf als manueller Weg.
  if (item.offeredAt) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-warn">
        <span>{t("delivery.unacked", { age: ageText(item.offeredAt) })}</span>
        <span className="text-ink-2">{t("delivery.unackedHint")}</span>
        {aged(item.offeredAt) && item.answer && <CopyAnswerButton answer={item.answer} />}
      </div>
    );
  }

  // Wartet (noch nicht angeboten): keine laufende/neue Session hat sie bisher
  // gesehen. Aging nach echten Stunden; ab 24 h Aufforderung + Kopier-Knopf.
  const since = item.answeredAt ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-warn">
      <span>{t("delivery.waiting", { age: ageText(since) })}</span>
      {aged(since) && (
        <>
          <span className="text-ink-2">{t("delivery.aging")}</span>
          {item.answer && <CopyAnswerButton answer={item.answer} />}
        </>
      )}
    </div>
  );
}

// Kopier-Knopf mit eigenem "Kopiert!"-Zustand — teilt sich der unbestätigte und
// der wartende Zustand (statt zweimal identisch inline).
function CopyAnswerButton({ answer }: { answer: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(answer).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard kann blockiert sein — still bleiben, Antwort steht auf der Karte.
      },
    );
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="ds-btn-ghost border border-line !px-2 !py-0.5 text-ink-2"
    >
      {copied ? t("delivery.copied") : t("delivery.copy")}
    </button>
  );
}
