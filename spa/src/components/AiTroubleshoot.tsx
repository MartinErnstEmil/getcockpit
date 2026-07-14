import { useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { useAiHealth, useTerminateStale } from "@/api/queries";
import { errText } from "@/lib/utils";

// Fehlerdiagnose bei Briefing/Assist-Timeout (wiederverwendbar). Führt Schritt
// für Schritt durch die wahrscheinlichen Ursachen und bietet die zwei
// Handlungen an: alte Sitzungen beenden (nutzer-bestätigt) und neu versuchen.
// UX: die zerstörerische Aktion (Beenden) ist zurückhaltend und braucht einen
// eigenen Bestätigen-Schritt mit Klartext, was passiert und dass nichts verloren geht.
export default function AiTroubleshoot({ reason, onRetry, retrying }: { reason?: string; onRetry: () => void; retrying: boolean }) {
  const health = useAiHealth(true);
  const terminate = useTerminateStale();
  const [confirming, setConfirming] = useState(false);
  const h = health.data;
  const stale = h?.staleSessions ?? 0;
  const thr = h?.staleThresholdHours ?? 18;

  function doTerminate() {
    terminate.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false);
        onRetry(); // nach dem Aufräumen gleich neu zusammenfassen
      },
    });
  }

  return (
    <div className="mt-2 border-l-4 border-warn bg-panel px-3 py-2.5 text-sm text-ink-2">
      <div className="font-semibold text-ink">
        Claude nicht erreichbar{reason ? ` (${reason})` : ""} — so bekommst du die KI-Zusammenfassung:
      </div>

      {/* Schritt-für-Schritt-Diagnose */}
      <ul className="mt-2 space-y-1 text-xs">
        <li className="flex gap-2">
          <Mark ok={h?.claudeInstalled} />
          {h?.claudeInstalled
            ? <span>Claude Code ist installiert{h.claudeVersion ? ` (v${h.claudeVersion})` : ""}.</span>
            : <span>Claude Code nicht gefunden — installieren und einmal <code className="font-mono">claude</code> im Terminal starten (einloggen).</span>}
        </li>
        <li className="flex gap-2">
          <Mark ok={stale === 0} warn={stale > 0} />
          {stale > 0
            ? <span><strong className="text-ink">{stale} Claude-Sitzung{stale === 1 ? "" : "en"}</strong> {stale === 1 ? "läuft" : "laufen"} seit über {thr} h — das bremst neue KI-Aufrufe aus (wahrscheinliche Ursache).</span>
            : <span>Keine alten Sitzungen stauen sich{h ? ` (${h.runningSessions} laufen).` : "."}</span>}
        </li>
        <li className="flex gap-2">
          <span className="shrink-0 text-ink-2">·</span>
          <span>Klappt es wiederholt nicht: einmal <code className="font-mono">claude</code> im Terminal starten und einloggen; <code className="font-mono">cockpit doctor</code> prüft es.</span>
        </li>
      </ul>

      {/* Aktionen */}
      {!confirming ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="ds-btn-primary flex items-center gap-1.5 !py-1.5 text-xs"
          >
            <Sparkles className={retrying ? "h-3.5 w-3.5 animate-pulse" : "h-3.5 w-3.5"} />
            {retrying ? "Fasst zusammen…" : "Neu zusammenfassen"}
          </button>
          {stale > 0 && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="ds-btn-ghost flex items-center gap-1.5 border border-line !py-1.5 text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Alte Sitzungen beenden ({stale})
            </button>
          )}
          {terminate.isSuccess && terminate.data && (
            <span className="text-xs text-ok">{terminate.data.terminated} alte Sitzung{terminate.data.terminated === 1 ? "" : "en"} beendet.</span>
          )}
        </div>
      ) : (
        <div className="mt-2.5 border border-warn/50 bg-ground px-3 py-2 text-xs">
          <div className="font-semibold text-ink">{stale} alte Claude-Sitzung{stale === 1 ? "" : "en"} beenden?</div>
          <p className="mt-1">
            {stale === 1 ? "Diese Sitzung läuft" : "Diese Sitzungen laufen"} seit über {thr} h — vermutlich vergessene Terminal-Fenster,
            die neue KI-Aufrufe (Briefing, Assists) ausbremsen.
          </p>
          <p className="mt-1">
            <strong className="text-ink">Du verlierst nichts:</strong> deine Dateien sind gespeichert, und Cockpit hat jede Sitzung
            mitgeschrieben (Verlauf). Beendet wird nur die im Hintergrund laufende Unterhaltung dieser alten Fenster.
            Falls du eine davon noch nutzt: abbrechen und das Fenster normal schließen.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="ds-btn-ghost border border-line !py-1.5 !px-3 text-xs">Abbrechen</button>
            <button type="button" disabled={terminate.isPending} onClick={doTerminate} className="ds-btn-primary !py-1.5 !px-3 text-xs disabled:opacity-40">
              {terminate.isPending ? "Beende…" : `${stale} beenden`}
            </button>
            {terminate.isError && <span className="text-crit">{errText(terminate.error)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// Kleiner farbiger Status-Marker (kein Icon-Import-Risiko, klar lesbar).
function Mark({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  if (ok) return <span className="shrink-0 font-semibold text-ok">✓</span>;
  if (warn) return <span className="shrink-0 font-semibold text-warn">!</span>;
  return <span className="shrink-0 font-semibold text-crit">✗</span>;
}
