import { describe, expect, it } from "vitest";
import { textOn } from "../../app/theme";
import { DEFAULT_PALETTE, hueDistance, paletteFromPixels, rgbToHsl } from "./palette";

/** RGBA pixels made of the given colours in the given proportions. */
function image(parts: Array<[number, number, number, number]>): number[] {
  const px: number[] = [];
  for (const [r, g, b, count] of parts) for (let i = 0; i < count; i++) px.push(r, g, b, 255);
  return px;
}

const hue = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
};

describe("paletteFromPixels", () => {
  it("assigns the warmer colour to F and the cooler to J", () => {
    const p = paletteFromPixels(image([[30, 60, 200, 500], [220, 40, 30, 300], [10, 10, 10, 200]]));
    expect(hueDistance(hue(p.f).h, 5)).toBeLessThan(25);
    expect(hueDistance(hue(p.j).h, 228)).toBeLessThan(25);
  });

  it("gives black-and-white art black-and-white lanes, told apart by brightness", () => {
    const p = paletteFromPixels(image([[0, 0, 0, 400], [128, 128, 128, 400], [250, 250, 250, 200]]));
    const [f, j, glow] = [hue(p.f), hue(p.j), hue(p.glow)];
    expect(f.s).toBeLessThan(0.05);
    expect(j.s).toBeLessThan(0.05);
    expect(f.l - j.l).toBeGreaterThan(0.25);
    expect(j.l).toBeGreaterThanOrEqual(0.49); // still readable on the dark panel
    expect(glow.l).toBeLessThan(0.2);
    expect(paletteFromPixels([])).toEqual(DEFAULT_PALETTE);
  });

  it("keeps a sepia tint in monochrome art", () => {
    // Warm browns at low saturation (old-photo look).
    const p = paletteFromPixels(image([[40, 32, 25, 400], [140, 120, 100, 400], [235, 225, 210, 200]]));
    expect(hueDistance(hue(p.j).h, 30)).toBeLessThan(25);
    expect(hue(p.j).s).toBeGreaterThan(0.04);
    expect(hue(p.j).s).toBeLessThan(0.25);
  });

  it("pairs a lone accent on a neutral cover with the cover's neutral", () => {
    // Black cover with a red accent.
    const p = paletteFromPixels(image([[10, 10, 10, 700], [230, 30, 40, 300]]));
    expect(hueDistance(hue(p.f).h, 357)).toBeLessThan(20);
    expect(hue(p.f).s).toBeGreaterThan(0.5);
    expect(hue(p.j).s).toBeLessThan(0.25); // the neutral, not an invented hue
    expect(hue(p.j).l).toBeGreaterThan(0.75);
  });

  it("gives a one-colour cover two shades of that colour family", () => {
    const p = paletteFromPixels(image([[40, 180, 70, 800], [20, 90, 35, 200]]));
    expect(p.f).not.toEqual(p.j);
    expect(hueDistance(hue(p.f).h, hue(p.j).h)).toBeLessThan(50);
    expect(hueDistance(hue(p.f).h, 135)).toBeLessThan(45);
  });

  it("keeps muted covers muted, but readable on black", () => {
    const p = paletteFromPixels(image([[150, 110, 90, 500], [90, 110, 150, 500]])); // dusty, desaturated art
    for (const c of [p.f, p.j]) {
      const { s, l } = hue(c);
      expect(s).toBeLessThan(0.5);
      expect(l).toBeGreaterThanOrEqual(0.49);
      expect(l).toBeLessThan(0.76);
    }
    expect(hue(p.glow).l).toBeLessThan(0.2);
  });

  it("ignores transparent pixels", () => {
    const px = image([[220, 40, 30, 10]]).map((v, i) => (i % 4 === 3 ? 0 : v));
    expect(paletteFromPixels(px)).toEqual(DEFAULT_PALETTE);
  });

  it("picks readable text for light and dark lane colours", () => {
    expect(textOn("#f0f0f0")).toBe("#111");
    expect(textOn("#ff4b4b")).toBe("#fff");
    expect(textOn("#4f9dff")).toBe("#fff");
  });
});
