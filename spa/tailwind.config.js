/** @type {import('tailwindcss').Config} */
// IBM-Carbon-Skin: Farbrollen als rgb(var(--x)); Tripel + Theme-Umschaltung in
// index.css. IBM Plex, eckige Kanten (kein Default-Radius), Schatten nur für
// Overlays (Toast). Carbon unterscheidet Ebenen über Layer-Hintergründe.
function c(name) {
  return `rgb(var(--${name}) / <alpha-value>)`;
}
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ground: c("ground"),
        panel: c("panel"),
        "surface-container": c("surface-container"),
        "panel-2": c("panel-2"),
        ink: c("ink"),
        "ink-2": c("ink-2"),
        line: c("line"),
        outline: c("outline"),
        accent: c("accent"),
        "accent-text": c("accent-text"),
        "accent-ink": c("accent-ink"),
        "primary-container": c("primary-container"),
        "on-primary-container": c("on-primary-container"),
        "secondary-container": c("secondary-container"),
        "on-secondary-container": c("on-secondary-container"),
        ok: c("ok"),
        warn: c("warn"),
        crit: c("crit"),
        hl: c("hl"),
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "Consolas", "monospace"],
      },
      boxShadow: {
        // Carbon nutzt Schatten nur für schwebende Overlays (Menüs, Toast).
        overlay: "0 2px 6px 0 rgb(0 0 0 / 0.3)",
      },
    },
  },
  plugins: [],
};
