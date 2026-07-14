// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Erzeugt ein Platzhalter-App-Icon (Cockpit-/Gauge-Motiv) als Multi-Size .ico
// (Windows) + 512er .png (electron-builder Fallback). Rein aus SVG gerendert
// (@resvg/resvg-js, vorkompiliert) -> kein Rasterizer/Compiler noetig.
// Ersetzen: eigenes 512x512-Logo als electron/build/icon.png ablegen und dieses
// Skript erneut laufen lassen, ODER icon.ico direkt austauschen.
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "build");

// Kuenstlicher Horizont (Attitude Indicator): dunkle Blende, kreisrunde
// Instrumentenflaeche mit Himmel/Boden-Teilung + leichter Querlage, fixes
// Flugzeugsymbol + Querlage-Zeiger oben.
const SVG = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="face"><circle cx="256" cy="256" r="168"/></clipPath>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4aa3e6"/><stop offset="1" stop-color="#2f7fc4"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9c5a24"/><stop offset="1" stop-color="#6d3d17"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="#0b0e14"/>
  <circle cx="256" cy="256" r="178" fill="#1a2130"/>
  <g clip-path="url(#face)">
    <g transform="rotate(-12 256 256)">
      <rect x="-140" y="-140" width="792" height="396" fill="url(#sky)"/>
      <rect x="-140" y="256" width="792" height="396" fill="url(#ground)"/>
      <line x1="-140" y1="256" x2="652" y2="256" stroke="#f2f5f8" stroke-width="6"/>
      <line x1="226" y1="212" x2="286" y2="212" stroke="#eaf2f8" stroke-width="5" stroke-linecap="round"/>
      <line x1="236" y1="300" x2="276" y2="300" stroke="#eae0d2" stroke-width="5" stroke-linecap="round"/>
    </g>
  </g>
  <circle cx="256" cy="256" r="168" fill="none" stroke="#0b0e14" stroke-width="10"/>
  <circle cx="256" cy="256" r="178" fill="none" stroke="#26303f" stroke-width="14"/>
  <g fill="#ffd23f">
    <rect x="188" y="251" width="52" height="9" rx="4.5"/>
    <rect x="272" y="251" width="52" height="9" rx="4.5"/>
    <circle cx="256" cy="256" r="8"/>
  </g>
  <path d="M256 96 l14 24 h-28 z" fill="#ffd23f"/>
</svg>`;

function renderPng(size) {
  return new Resvg(SVG, { fitTo: { mode: "width", value: size } }).render().asPng();
}

mkdirSync(OUT, { recursive: true });
const sizes = [16, 32, 48, 64, 128, 256];
const ico = await pngToIco(sizes.map(renderPng));
writeFileSync(join(OUT, "icon.ico"), ico);
writeFileSync(join(OUT, "icon.png"), renderPng(512));
console.log(`icon.ico (${sizes.join("/")}) + icon.png(512) -> ${OUT}`);
