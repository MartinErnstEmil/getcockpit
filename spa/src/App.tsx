import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import HooksBanner from "./components/HooksBanner";
import EmptyState from "./components/EmptyState";

// Code-Split je Route (eigener Chunk, erst bei Navigation geladen).
const OverviewPage = lazy(() => import("./routes/OverviewPage"));
const BriefingPage = lazy(() => import("./routes/BriefingPage"));
const InboxPage = lazy(() => import("./routes/InboxPage"));
const DecisionsPage = lazy(() => import("./routes/DecisionsPage"));
const SearchPage = lazy(() => import("./routes/SearchPage"));
const SessionsPage = lazy(() => import("./routes/SessionsPage"));
const GitPage = lazy(() => import("./routes/GitPage"));
const FilesPage = lazy(() => import("./routes/FilesPage"));
const ReportPage = lazy(() => import("./routes/ReportPage"));
const SettingsPage = lazy(() => import("./routes/SettingsPage"));

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[220px_minmax(0,1fr)] grid-rows-[44px_minmax(0,1fr)] bg-ground text-ink max-[780px]:grid-cols-[56px_minmax(0,1fr)]">
      <div className="col-span-2 row-start-1 border-b border-line">
        <Header />
      </div>
      <aside className="row-start-2 min-h-0 overflow-y-auto border-r border-line bg-panel">
        <Sidebar />
      </aside>
      <main className="row-start-2 min-h-0 min-w-0 overflow-y-auto">
        <HooksBanner />
        <Suspense fallback={<EmptyState title="Lädt…" />}>{children}</Suspense>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/briefing" element={<BriefingPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/decisions" element={<DecisionsPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:sessionId" element={<SessionsPage />} />
        <Route path="/git" element={<GitPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/files/:key" element={<FilesPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </Shell>
  );
}
