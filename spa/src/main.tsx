import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { bootToken } from "./lib/token";
import { applyTheme, getTheme } from "./lib/theme";
import { LocaleProvider } from "./lib/i18n";
// IBM Plex gebündelt (kein externer Fetch) — Carbon-Typografie.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./index.css";

// Vor dem ersten Render: Token aus ?token= sichern (raus aus der Adresszeile)
// und das gewählte Theme anwenden (PLAN-PRD §2, §6.9).
bootToken();
applyTheme(getTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Kein SSE: TanStack-Polling mit staleTime 5 s, kein Focus-Refetch (§2).
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <BrowserRouter basename="/spa">
          <App />
        </BrowserRouter>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
);
