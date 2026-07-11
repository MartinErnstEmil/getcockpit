/// <reference types="vite/client" />

// Compile-Zeit-Konstanten aus vite.config.ts (define): App-Version und Repo-URL
// aus der Root-package.json (Feedback-Betreff bzw. Repo-Link in den Einstellungen).
declare const __APP_VERSION__: string;
declare const __REPO_URL__: string;
