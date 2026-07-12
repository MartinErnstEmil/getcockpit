import { useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "@/lib/i18n";
import { ageText } from "@/lib/utils";
import type { DeliveryInfo } from "@/api/types";

// Zustell-Quittung (Zustell-Transparenz): eine Zustandszeile unter der Antwort
// einer beantworteten Karte — teilt sich ItemCard (Inbox) und DecisionsPage.
// Wartet: seit wann; ab 24 h mit Aufforderung + Kopier-Knopf. Zugestellt: seit
// wann, auf welchem Weg, Session-Kurz-Id als Link in den Verlauf (außer mcp).
const AGING_MS = 24 * 60 * 60 * 1000;

export default function DeliveryState({
  status,
  answeredAt,
  deliveredAt,
  delivery,
  answerText,
}: {
  status: string;
  answeredAt?: string;
  deliveredAt?: string;
  delivery?: DeliveryInfo | null;
  answerText?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (status !== "answered") return null;

  if (!deliveredAt) {
    // Aging nach echten Stunden (nicht Kalendertagen): ab 24 h Aufforderung.
    const since = answeredAt ?? "";
    const aging = since ? Date.now() - Date.parse(since) > AGING_MS : false;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-warn">
        <span>{t("delivery.waiting", { age: ageText(since) })}</span>
        {aging && (
          <>
            <span className="text-ink-2">{t("delivery.aging")}</span>
            {answerText && (
              <button
                type="button"
                onClick={() => copyText(answerText, setCopied)}
                className="ds-btn-ghost border border-line !px-2 !py-0.5 text-ink-2"
              >
                {copied ? t("delivery.copied") : t("delivery.copy")}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  const via = t(`delivery.via.${delivery?.via ?? "prompt"}`);
  const sid = delivery?.sessionId;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ok">
      <span>{t("delivery.delivered", { age: ageText(deliveredAt), via })}</span>
      {sid && delivery?.via !== "mcp" && (
        <Link to={`/sessions/${sid}`} className="font-mono text-accent underline decoration-dotted">
          {t("delivery.session", { id: sid.slice(0, 8) })}
        </Link>
      )}
    </div>
  );
}

function copyText(text: string, setCopied: (v: boolean) => void): void {
  navigator.clipboard.writeText(text).then(
    () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    () => {
      // Clipboard kann blockiert sein — still bleiben, Antwort steht auf der Karte.
    },
  );
}
