import { DEFAULT_PALETTE, type Palette } from "../services/artwork/palette";

/** Current game palette. DOM uses CSS variables (transitioned); the canvas reads it and blends. */
let current: Palette = DEFAULT_PALETTE;
const listeners = new Set<() => void>();

export function getPalette(): Palette {
  return current;
}

export function setPalette(p: Palette): void {
  if (p.f === current.f && p.j === current.j && p.glow === current.glow) return;
  current = p;
  const root = document.documentElement.style;
  root.setProperty("--lane-f", p.f);
  root.setProperty("--lane-j", p.j);
  root.setProperty("--glow", p.glow);
  // Text on a lane colour: dark on light lanes (e.g. a black-and-white cover's white lane).
  root.setProperty("--on-lane-f", textOn(p.f));
  root.setProperty("--on-lane-j", textOn(p.j));
  listeners.forEach((l) => l());
}

export function subscribePalette(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.45 ? "#111" : "#fff";
}
