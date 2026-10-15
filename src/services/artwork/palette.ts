/**
 * Derive game colours from album art: two lane colours that look like the cover
 * and read on black, plus a dark glow tint for the panel background.
 */
export interface Palette {
  /** F / "don" notes: the warmer of the two. */
  f: string;
  /** J / "ka" notes. */
  j: string;
  /** Dark background tint. */
  glow: string;
}

export const DEFAULT_PALETTE: Palette = { f: "#ff4b4b", j: "#4f9dff", glow: "#2a0a0d" };

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Higher for reds/oranges, lower for blues: decides which colour is "don". */
function warmth(h: number): number {
  return Math.cos(((h - 20) * Math.PI) / 180);
}

const BUCKETS = 24;
const MIN_SEPARATION = 55;
/** Below this share of colourful pixels, art counts as black and white. */
const MONO_CHROMA = 0.04;
/** Above this share of neutral pixels, a lone colour is paired with the art's neutral tone. */
const NEUTRAL_SHARE = 0.3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * `rgba` is RGBA bytes, as from CanvasRenderingContext2D.getImageData.
 *
 * The palette mirrors the cover rather than imposing one: black-and-white art
 * gets black-and-white lanes (keeping any sepia or cool tint), a lone accent on
 * a neutral cover is paired with that neutral, and muted covers stay muted. Lane
 * colours are only lifted as far as needed to stay readable on the dark panel.
 */
export function paletteFromPixels(rgba: ArrayLike<number>): Palette {
  const weight = new Float64Array(BUCKETS);
  // Sum hue as a vector per bucket so averaging wraps correctly.
  const hx = new Float64Array(BUCKETS);
  const hy = new Float64Array(BUCKETS);
  const sat = new Float64Array(BUCKETS);
  const light = new Float64Array(BUCKETS);
  let chroma = 0;
  let pixels = 0;
  let avgH = { x: 0, y: 0 };
  // Neutral (grey/black/white) pixels: how many, how light, and any faint tint.
  let neutral = 0;
  let neutralLight = 0;
  let tint = { x: 0, y: 0, s: 0, n: 0 };
  let darkest = 1;
  let lightest = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    pixels++;
    const { h, s, l } = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2]);
    const rad = (h * Math.PI) / 180;
    if (s < 0.22 || l < 0.12 || l > 0.9) {
      neutral++;
      neutralLight += l;
      darkest = Math.min(darkest, l);
      lightest = Math.max(lightest, l);
      // Faint colour in the greys (sepia, blue-black): only from mid tones, where it's real.
      const ts = s * (1 - Math.abs(l - 0.5) * 2);
      if (ts > 0.02) tint = { x: tint.x + Math.cos(rad) * ts, y: tint.y + Math.sin(rad) * ts, s: tint.s + ts, n: tint.n + 1 };
      continue;
    }
    const w = s * (1 - Math.abs(l - 0.5) * 1.3);
    if (w <= 0) continue;
    const b = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    weight[b] += w;
    hx[b] += Math.cos(rad) * w;
    hy[b] += Math.sin(rad) * w;
    sat[b] += s * w;
    light[b] += l * w;
    avgH = { x: avgH.x + Math.cos(rad) * w, y: avgH.y + Math.sin(rad) * w };
    chroma += w;
  }
  if (pixels === 0) return DEFAULT_PALETTE;

  const angle = (x: number, y: number) => ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const tintHue = angle(tint.x, tint.y);
  // How much tint the greys carry (0 for pure greys), capped so it stays a tint.
  const tintSat = tint.n ? clamp((Math.hypot(tint.x, tint.y) / tint.n) * 1.6, 0, 0.22) : 0;
  /** The cover's neutral as a lane colour: light enough to read, faintly tinted like the art. */
  const neutralLane = (l: number) => hslToHex({ h: tintHue, s: tintSat, l });
  const neutralGlow = hslToHex({ h: tintHue, s: Math.min(0.3, tintSat * 1.5), l: 0.08 + 0.06 * (neutralLight / Math.max(1, neutral)) });

  // Black-and-white art: black-and-white lanes, told apart by brightness.
  if (chroma / pixels < MONO_CHROMA) {
    return { f: neutralLane(0.92), j: neutralLane(clamp(0.44 + 0.16 * (lightest - darkest), 0.5, 0.62)), glow: neutralGlow };
  }

  // Merge each bucket with its neighbours so a colour split across a boundary isn't penalised.
  const smoothed = Array.from(weight, (w, b) => w + 0.5 * (weight[(b + 1) % BUCKETS] + weight[(b + BUCKETS - 1) % BUCKETS]));
  const hueOf = (b: number) => angle(hx[b], hy[b]);
  const order = [...smoothed.keys()].filter((b) => weight[b] > 0).sort((a, b) => smoothed[b] - smoothed[a]);
  /** A bucket's colour as it appears on the cover, lifted only as far as needed to read on black. */
  const lane = (b: number): string => {
    const s = sat[b] / weight[b];
    const l = light[b] / weight[b];
    return hslToHex({ h: hueOf(b), s: clamp(s * 1.1, 0.35, 1), l: clamp(l, 0.5, 0.74) });
  };

  const first = order[0];
  const h1 = hueOf(first);
  const second = order.find((b) => hueDistance(hueOf(b), h1) >= MIN_SEPARATION && smoothed[b] > smoothed[first] * 0.08);
  const dominant = angle(avgH.x, avgH.y);
  const glow = hslToHex({ h: dominant, s: clamp(0.15 + (chroma / pixels) * 1.5, 0.15, 0.55), l: 0.15 });

  let fColor: string;
  let jColor: string;
  if (second !== undefined) {
    // Two real colours on the cover: the warmer one is F ("don").
    [fColor, jColor] = warmth(h1) >= warmth(hueOf(second)) ? [lane(first), lane(second)] : [lane(second), lane(first)];
  } else if (neutral / pixels >= NEUTRAL_SHARE) {
    // One colour on a black/white/grey cover: that colour and the cover's neutral.
    const accent = lane(first);
    const tone = neutralLane(neutralLight / neutral > 0.5 ? 0.9 : 0.82);
    [fColor, jColor] = warmth(h1) >= 0 ? [accent, tone] : [tone, accent];
  } else {
    // A cover in one colour family: a neighbouring shade of it, lighter, for the second lane.
    const s1 = sat[first] / weight[first];
    const l1 = clamp(light[first] / weight[first], 0.5, 0.74);
    const near: Hsl = { h: (h1 + (warmth(h1) >= 0 ? -38 : 38) + 360) % 360, s: clamp(s1, 0.35, 1), l: l1 > 0.62 ? l1 - 0.16 : l1 + 0.14 };
    [fColor, jColor] = warmth(h1) >= warmth(near.h) ? [lane(first), hslToHex(near)] : [hslToHex(near), lane(first)];
  }
  return { f: fColor, j: jColor, glow };
}

/** Fetch an image (CORS-enabled) and extract its palette from a 32×32 downsample. */
export async function paletteFromImage(url: string): Promise<Palette> {
  const response = await fetch(url);
  if (!response.ok) return DEFAULT_PALETTE;
  // createImageBitmap decodes off the DOM, so it works even while the page is hidden.
  const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: 32, resizeHeight: 32, resizeQuality: "medium" });
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return DEFAULT_PALETTE;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return paletteFromPixels(ctx.getImageData(0, 0, 32, 32).data);
}
