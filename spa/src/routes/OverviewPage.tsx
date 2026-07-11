import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost } from "@/api/client";
import { useScope } from "@/lib/useScope";
import { scopeToParams, isInboxOpen, isBlocker, isActionable } from "@/lib/scope";
import { useScopedStatus, useScopedItems } from "@/lib/useScopedData";
import { useConfig, useDecisions } from "@/api/queries";
import { ErrorBox } from "@/components/StateView";
import EmptyState from "@/components/EmptyState";
import OnboardingBanner from "@/components/OnboardingBanner";
import Tile from "@/components/Tile";
import { useT, useLocale, type Locale } from "@/lib/i18n";
import { shortName, dayMonth } from "@/lib/utils";
import type { NextAction, ProjectStatus } from "@/api/types";

type TFn = (key: string, params?: Record<string, string | number>) => string;

// /overview — der wichtigste Screen (PLAN-PRD §6.2, Umbau U1). Aufbau oben nach
// unten: Onboarding -> "Heute"-Band -> Kacheln -> "Jetzt dran" -> Empfehlungen
// -> "Wusstest du?" -> Projektkarten. Vom Status zum Einstieg, mit Nudges.
export default function OverviewPage() {
  const t = useT();
  const { scope } = useScope();
  const navigate = useNavigate();
  const { status, keep, projects, nextActions } = useScopedStatus(scope);
  const { inScopeItems } = useScopedItems(scope, keep);
  const decisionsQ = useDecisions(scope, false);
  const configQ = useConfig(scope);
  const nextRef = useRef<HTMLDivElement>(null);
  const projRef = useRef<HTMLDivElement>(null);

  if (status.error) return <div className="p-5"><ErrorBox error={status.error} onRetry={() => void status.refetch()} /></div>;
  if (status.isLoading) return <EmptyState title="Lädt…" />;

  // Kachel == Badge == Liste: dieselben Prädikate wie Inbox/Sidebar (T3/P2).
  const open = inScopeItems.filter(isInboxOpen).length;
  const blockers = inScopeItems.filter(isBlocker).length;
  const waiting = inScopeItems.filter(isActionable).length;
  const decisions = (decisionsQ.data?.decisions ?? []).filter((d) => keep(d.projectPath)).length;
  const firstRun = status.data?.firstRun ?? null;
  const olderOpen = status.data?.olderOpen ?? 0;

  const toInbox = (filter?: string) => {
    const p = scopeToParams(scope);
    if (filter) p.set("filter", filter);
    navigate({ pathname: "/inbox", search: p.toString() });
  };
  const go = (pathname: string) => navigate({ pathname, search: scopeToParams(scope).toString() });
  const goBriefing = (project: string) =>
    navigate({ pathname: "/briefing", search: scopeToParams({ mode: "single", project, days: scope.days }).toString() });
  const openItem = (id: string) => {
    const p = scopeToParams(scope);
    p.set("item", id);
    navigate({ pathname: "/inbox", search: p.toString() });
  };
  const scrollTo = (r: React.RefObject<HTMLDivElement | null>) =>
    r.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const recs = buildRecommendations(t, {
    fullConfigs: (configQ.data?.entries ?? []).filter(
      (e) => e.exists && keep(e.projectPath || null) && e.remaining < e.budget * 0.1,
    ),
    draftCount: inScopeItems.filter((i) => i.answer && i.status !== "answered").length,
    worstDirty: projects
      .filter((p) => p.git && p.git.dirtyFiles >= 10)
      .sort((a, b) => (b.git?.dirtyFiles ?? 0) - (a.git?.dirtyFiles ?? 0))[0],
    onFiles: () => go("/files"),
    onDrafts: () => toInbox("waiting"),
    onBriefing: goBriefing,
  });

  return (
    <div className="mx-auto max-w-[1120px] px-5 py-5">
      {status.data && !status.data.dismissedHints.includes("onboarding") && <OnboardingBanner />}

      {status.data?.today && <TodayBar t={t} today={status.data.today} />}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
        <Tile num={nextActions.length} label={t("overview.tile.now")} onClick={() => scrollTo(nextRef)} />
        {/* Kachel == Zielansicht: "Inbox offen" zählt ALLE offenen, also führt
            sie in die transiente ?filter=open-Ansicht statt in den Default. */}
        <Tile num={open} label={t("overview.tile.inboxOpen")} onClick={() => toInbox("open")} />
        <Tile num={blockers} label={t("overview.tile.blocker")} crit onClick={() => toInbox("blocker")} />
        <Tile num={waiting} label={t("overview.tile.waiting")} onClick={() => toInbox("waiting")} />
        <Tile num={decisions} label={t("overview.tile.decisions")} onClick={() => go("/decisions")} />
        <Tile num={projects.length} label={t("overview.tile.projects")} onClick={() => scrollTo(projRef)} />
      </div>

      <section ref={nextRef} className="mt-8">
        <h2 className="mb-3 text-[15px] font-semibold">
          {t("overview.now.title")} <span className="ml-2 text-xs font-normal text-ink-2">{t("overview.now.sub")}</span>
        </h2>
        <NextActions t={t} actions={nextActions} firstRun={firstRun} singleScope={scope.mode === "single"} onOpen={openItem} />
        {olderOpen > 0 && (
          <button type="button" onClick={() => toInbox()} className="mt-2 text-xs text-accent underline">
            {t(olderOpen === 1 ? "overview.olderOpen_one" : "overview.olderOpen", { n: olderOpen })}
          </button>
        )}
      </section>

      {recs.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[15px] font-semibold">{t("overview.rec.title")}</h2>
          <div className="flex flex-col gap-2">
            {recs.map((r) => (
              <div key={r.key} className="ds-card flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="text-ink-2">{r.text}</span>
                <button type="button" onClick={r.go} className="text-accent underline">{r.cta}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {status.data && !status.data.dismissedHints.includes("tips") && <DidYouKnow />}

      <section ref={projRef} className="mt-8">
        <h2 className="mb-3 text-[15px] font-semibold">
          {t("overview.projects.title")} <span className="ml-2 text-xs font-normal text-ink-2">{t("overview.projects.sub")}</span>
        </h2>
        {projects.length === 0 ? (
          <p className="italic text-ink-2">{t("overview.projects.empty")}</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-2.5">
            {/* Projektkarte führt zur Status-Zusammenfassung (Briefing) des
                Projekts — mit sichtbarem Rückweg (PO-Befund 09.07.). */}
            {projects.map((p) => (
              <ProjectCard key={p.projectPath} t={t} p={p} onClick={() => goBriefing(p.projectPath)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// "Heute"-Band: leichter Tagesüberblick als Einstieg (U1). In "Aktiv"/"Alle"
// portfolioweit, bei Einzelauswahl projektbezogen (Server filtert).
function TodayBar({ t, today }: { t: TFn; today: { sessions: number; decisions: number; newItems: number } }) {
  const parts = [
    t(today.sessions === 1 ? "overview.today.sessions_one" : "overview.today.sessions", { n: today.sessions }),
    t(today.decisions === 1 ? "overview.today.decisions_one" : "overview.today.decisions", { n: today.decisions }),
    t("overview.today.new", { n: today.newItems }),
  ];
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="font-semibold">{t("overview.today")}</span>
      <span className="text-ink-2">{parts.join(" · ")}</span>
    </div>
  );
}

type Rec = { key: string; text: string; cta: string; go: () => void };

// Abgeleitete Handlungsempfehlungen (U1, max. 3), jede mit Klickziel: volle
// CLAUDE.md, nicht zugestellte Entwürfe, viel ungesicherte Git-Arbeit.
function buildRecommendations(t: TFn, a: {
  fullConfigs: Array<{ projectPath: string | null }>;
  draftCount: number;
  worstDirty: ProjectStatus | undefined;
  onFiles: () => void;
  onDrafts: () => void;
  onBriefing: (project: string) => void;
}): Rec[] {
  const recs: Rec[] = [];
  if (a.fullConfigs.length > 0) {
    const names = a.fullConfigs.map((e) => (e.projectPath ? shortName(e.projectPath) : "Global")).join(", ");
    recs.push({
      key: "config",
      text: t(a.fullConfigs.length === 1 ? "overview.rec.configFull_one" : "overview.rec.configFull", { n: a.fullConfigs.length, names }),
      cta: t("overview.rec.configCta"),
      go: a.onFiles,
    });
  }
  if (a.draftCount > 0) {
    recs.push({
      key: "drafts",
      text: t(a.draftCount === 1 ? "overview.rec.drafts_one" : "overview.rec.drafts", { n: a.draftCount }),
      cta: t("overview.rec.draftsCta"),
      go: a.onDrafts,
    });
  }
  if (a.worstDirty?.git) {
    recs.push({
      key: "git",
      text: t("overview.rec.git", { name: shortName(a.worstDirty.projectPath), n: a.worstDirty.git.dirtyFiles }),
      cta: t("overview.rec.gitCta"),
      go: () => a.onBriefing(a.worstDirty!.projectPath),
    });
  }
  return recs.slice(0, 3);
}

// "Wusstest du?" — ein rotierender Feature-Tipp pro Tag (gamifizierte
// Entdeckung). Deterministisch über den Kalendertag; "nicht mehr zeigen"
// blendet das ganze Band dauerhaft aus (dismissedHints-Schlüssel "tips").
// Strukturierter Inhalt je Sprache (statt 20 flacher i18n-Schlüssel).
const TIPS: Record<Locale, Array<{ title: string; body: string }>> = {
  en: [
    { title: "Full-text search", body: "The Search tab searches every recorded session in full text — even old conversations you only vaguely remember." },
    { title: "Decision chain", body: "In the decision log, “also show replaced” reveals the full history: what a decision superseded and what replaced it." },
    { title: "Copy the briefing", body: "On a project card the briefing sums up the state — “Copy for session” puts it on the clipboard as Markdown for a new CLI window." },
    { title: "Filter by click", body: "Clicking a card’s reference tag (e.g. “project #12”) instantly filters the view to exactly that project." },
    { title: "Later instead of delete", body: "“Later” removes an item from the inbox but brings it back — ideal for things that aren’t due yet." },
    { title: "Journal", body: "The Report tab shows your work as a timeline: which sessions ran, which decisions were made, what came in." },
    { title: "Pick a period", body: "In the header you can set “Active” to 7/14/30/90 days — that’s how far the view reaches back." },
    { title: "Memory & rules", body: "The Files tab shows each project’s CLAUDE.md with its character budget and the unsaved changes since the last commit." },
    { title: "cockpit doctor", body: "If the AI summary doesn’t run, “cockpit doctor” in the terminal checks whether Claude Code is installed and logged in." },
    { title: "Clickable answers", body: "Questions with options (“( ) …” or “[ ] …”) answer by click — it only fills the field; you decide when to send." },
  ],
  de: [
    { title: "Volltextsuche", body: "Der Suche-Tab durchsucht alle erfassten Sessions per Volltext — auch alte Gespräche, an die du dich nur vage erinnerst." },
    { title: "Entscheidungs-Kette", body: "Im Entscheidungs-Log zeigt „auch ersetzte zeigen“ die volle Historie: was eine Entscheidung abgelöst hat und wodurch sie ersetzt wurde." },
    { title: "Briefing kopieren", body: "Auf einer Projektkarte fasst das Briefing den Stand zusammen — „Für Session kopieren“ legt ihn als Markdown in die Zwischenablage für ein neues CLI-Fenster." },
    { title: "Projektfilter per Klick", body: "Klick auf das Referenz-Kürzel einer Karte (z. B. „projekt #12“) filtert die Ansicht sofort auf genau dieses Projekt." },
    { title: "Später statt Löschen", body: "Mit „Später“ verschwindet ein Item aus der Inbox, kommt aber wieder — ideal für Dinge, die noch nicht dran sind." },
    { title: "Tagebuch", body: "Der Report-Tab zeigt deine Arbeit als Zeitachse: welche Sessions liefen, welche Entscheidungen fielen, was neu hereinkam." },
    { title: "Zeitraum wählen", body: "Im Kopf lässt sich „Aktiv“ auf 7/14/30/90 Tage stellen — so weit reicht die Ansicht zurück." },
    { title: "Gedächtnis & Regeln", body: "Der Files-Tab zeigt je Projekt die CLAUDE.md mit Zeichen-Budget und den ungesicherten Änderungen seit dem letzten Commit." },
    { title: "cockpit doctor", body: "Läuft die KI-Zusammenfassung nicht, prüft „cockpit doctor“ im Terminal, ob Claude Code installiert und eingeloggt ist." },
    { title: "Klickbare Antworten", body: "Fragen mit Optionen („( ) …“ oder „[ ] …“) machen die Antwort per Klick — das füllt nur das Feld, gesendet wird auf deinen Befehl." },
  ],
  fr: [
    { title: "Recherche plein texte", body: "L’onglet Recherche parcourt en plein texte toutes les sessions enregistrées — même de vieilles conversations dont vous vous souvenez à peine." },
    { title: "Chaîne de décisions", body: "Dans le journal des décisions, « afficher aussi les remplacées » révèle l’historique complet : ce qu’une décision a supplanté et ce qui l’a remplacée." },
    { title: "Copier le briefing", body: "Sur une carte de projet, le briefing résume l’état — « Copier pour session » le met dans le presse-papiers en Markdown pour une nouvelle fenêtre CLI." },
    { title: "Filtrer d’un clic", body: "Cliquer sur la référence d’une carte (p. ex. « projet #12 ») filtre aussitôt la vue sur exactement ce projet." },
    { title: "Plus tard plutôt que supprimer", body: "« Plus tard » retire un élément de la boîte mais le fait revenir — idéal pour ce qui n’est pas encore d’actualité." },
    { title: "Journal", body: "L’onglet Rapport montre votre travail sur une frise : quelles sessions ont eu lieu, quelles décisions ont été prises, ce qui est arrivé." },
    { title: "Choisir une période", body: "Dans l’en-tête, « Actif » se règle sur 7/14/30/90 jours — c’est la portée de la vue vers le passé." },
    { title: "Mémoire & règles", body: "L’onglet Fichiers montre le CLAUDE.md de chaque projet avec son budget de caractères et les changements non sauvegardés depuis le dernier commit." },
    { title: "cockpit doctor", body: "Si le résumé IA ne démarre pas, « cockpit doctor » dans le terminal vérifie si Claude Code est installé et connecté." },
    { title: "Réponses cliquables", body: "Les questions à options (« ( ) … » ou « [ ] … ») se répondent d’un clic — cela ne remplit que le champ ; vous décidez de l’envoi." },
  ],
};

function DidYouKnow() {
  const t = useT();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000);
  const list = TIPS[locale];
  const tip = list[dayOfYear % list.length]!;
  const dismiss = async () => {
    await apiPost("/api/events", { eventType: "hint_dismiss", payload: { hint: "tips" } });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
  return (
    <section className="mt-8">
      <div className="border-l-4 border-accent bg-panel px-4 py-3 text-sm">
        <div className="flex items-start justify-between gap-3">
          <span className="font-semibold">{t("overview.tips.title")} {tip.title}</span>
          <button type="button" onClick={() => void dismiss()} className="shrink-0 text-xs text-ink-2 underline hover:text-accent-text">
            {t("overview.tips.dismiss")}
          </button>
        </div>
        <p className="mt-1 text-ink-2">{tip.body}</p>
      </div>
    </section>
  );
}

function NextActions({
  t,
  actions,
  firstRun,
  singleScope,
  onOpen,
}: {
  t: TFn;
  actions: NextAction[];
  firstRun: { turns: number; projects: number } | null;
  singleScope: boolean;
  onOpen: (id: string) => void;
}) {
  if (actions.length === 0) {
    return (
      <p className="italic text-ink-2">
        {firstRun
          ? t("overview.now.firstRun", { turns: firstRun.turns, projects: firstRun.projects })
          : t("overview.now.empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {actions.map((a, i) => (
        <div
          key={a.itemId ?? i}
          role="button"
          tabIndex={0}
          onClick={() => a.itemId && onOpen(a.itemId)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && a.itemId && onOpen(a.itemId)}
          className="ds-card-interactive grid grid-cols-[4px_1fr] overflow-hidden"
        >
          <div className={a.kind === "blocker" ? "bg-crit" : a.kind === "urgent" ? "bg-warn" : "bg-line"} />
          <div className="px-3 py-2">
            <div className="text-sm font-semibold">
              {a.title}
              {a.projectPath && !singleScope && (
                <span className="ml-2 text-xs font-normal text-ink-2">[{shortName(a.projectPath)}]</span>
              )}
            </div>
            <div className="text-xs text-ink-2">{a.why}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectCard({ t, p, onClick }: { t: TFn; p: ProjectStatus; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      className="ds-card-interactive px-4 py-3"
    >
      <div className="text-sm font-semibold">
        {shortName(p.projectPath)}
        {p.activeSession && <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-ok">● {t("overview.card.running")}</span>}
      </div>
      <div className="mt-0.5 text-xs text-ink-2">
        {dayMonth(p.lastActivity)} · {t("overview.card.turns", { n: p.turns })}
        {p.blockers > 0 && <span className="font-semibold text-crit"> · {t("overview.card.blockers", { n: p.blockers })}</span>}
        {p.waitingOnHuman > 0 && <span> · {t("overview.card.waiting", { n: p.waitingOnHuman })}</span>}
        {p.git && <span> · {p.git.branch ?? "?"}{p.git.dirtyFiles ? ` (${p.git.dirtyFiles})` : ""}</span>}
      </div>
      {p.latestDecisions.slice(0, 2).map((d) => (
        <div key={d.id} className="mt-0.5 text-xs text-ink-2">✓ {dayMonth(d.at)} {d.title}</div>
      ))}
    </div>
  );
}
