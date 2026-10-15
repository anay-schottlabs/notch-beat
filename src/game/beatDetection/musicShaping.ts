import type { Intensity, Step } from "../timing/beatSequence";
import type { Lane } from "../types";

/**
 * How a music chart reacts to the song: pattern density follows energy, and
 * chords land where the song's bass hits keep landing.
 */

/** Energy thresholds with hysteresis, so sections don't flicker between pools. */
export function nextIntensity(prev: Intensity, energy: number): Intensity {
  switch (prev) {
    case "calm":
      return energy > 0.25 ? (energy > 0.6 ? "busy" : "normal") : "calm";
    case "normal":
      return energy < 0.16 ? "calm" : energy > 0.55 ? "busy" : "normal";
    case "busy":
      return energy < 0.42 ? (energy < 0.16 ? "calm" : "normal") : "busy";
  }
}

/** A build-up worth a drumroll: rising steadily, not already at full energy. */
export function wantsRoll(buildup: number, energy: number, barsSinceRoll: number): boolean {
  return buildup >= 0.6 && energy < 0.85 && barsSinceRoll >= 4;
}

const STEPS = 8;

/**
 * Learns where in the bar one kind of drum hit falls (kick or snare). Notes are
 * placed ~1.6 s ahead, so we can't wait for the hit itself; instead, steps where
 * hits have landed in most recent bars are treated as "the drum goes here".
 */
export class DrumGroove {
  private weights = new Float64Array(STEPS);
  private bars = new Map<number, { start: number; step: number; hits: Set<number> }>();
  private folded = new Set<number>();
  private lastHit = -Infinity;

  /** Record a generated bar (song times; `stepMs` is an eighth note). */
  addBar(index: number, start: number, stepMs: number): void {
    this.bars.set(index, { start, step: stepMs, hits: new Set() });
  }

  /** Feed hits (song times, ascending). Each is assigned to the nearest eighth of its bar. */
  addHits(songTimes: readonly number[]): void {
    for (const k of songTimes) {
      if (k <= this.lastHit) continue;
      this.lastHit = k;
      for (const [, bar] of this.bars) {
        const pos = (k - bar.start) / bar.step;
        if (pos < -0.5 || pos >= STEPS - 0.5) continue;
        bar.hits.add(Math.round(pos));
        break;
      }
    }
  }

  /** Fold every bar that has fully played (ends before `songNow`) into the weights. */
  settle(songNow: number): void {
    for (const [index, bar] of [...this.bars].sort((a, b) => a[0] - b[0])) {
      if (this.folded.has(index) || bar.start + STEPS * bar.step > songNow) continue;
      for (let s = 0; s < STEPS; s++) this.weights[s] = 0.65 * this.weights[s] + 0.35 * (bar.hits.has(s) ? 1 : 0);
      this.folded.add(index);
      this.bars.delete(index);
    }
  }

  /** Eighth-note steps where hits reliably land (a steady groove reaches ~0.9 after a few bars). */
  steps(threshold = 0.55): number[] {
    return [...this.weights.keys()].filter((s) => this.weights[s] >= threshold);
  }
}

/** Lanes a pattern already occupies at a step through a hold or roll that started earlier. */
function busyLanes(pattern: readonly Step[], at: number): Set<Lane> {
  const busy = new Set<Lane>();
  for (let i = 0; i < at; i++) {
    const s = pattern[i];
    if (!s || typeof s !== "object") continue;
    const end = i + ("hold" in s ? s.steps : s.roll);
    if (at > end) continue;
    if ("hold" in s) busy.add(s.hold);
    else busy.add("f").add("j");
  }
  return busy;
}

const lanesOf = (s: Step): Lane[] => (s === "both" ? ["f", "j"] : s === "f" || s === "j" ? [s] : []);
const other = (l: Lane): Lane => (l === "f" ? "j" : "f");

/** The song's drum groove for a bar: eighth-note steps where the kick and the snare land. */
export interface Drums {
  kick: readonly number[];
  snare: readonly number[];
}

export interface DrumOptions {
  intensity: Intensity;
  /** Position in a 4-bar phrase (0 = phrase start). */
  barInPhrase: number;
  /** Picks the fill, so consecutive phrases differ. */
  phrase: number;
}

/**
 * Sixteenth-note fills for the second half of a phrase's last bar. They alternate
 * hands and leave the last sixteenth empty before the next phrase's opening chord.
 */
export const FILLS: readonly Step[][] = [
  ["f", "j", "f", "j", "f", "j", "f", null],
  ["f", null, "f", "j", null, "j", "f", null],
  ["j", "f", "j", null, "j", "f", "j", null],
  ["f", "j", null, "j", "f", "j", "f", null],
];

/**
 * Shape a bar like a drummer would play it.
 *
 * - Kick steps go to F (red, the bass drum) and snare steps to J (blue), so the
 *   notes you hit are the song's own drum pattern.
 * - Chords are rare accents: one on the first beat of each phrase. Other chords in
 *   the pattern become single notes that follow the drums or alternate hands.
 * - Calm sections play just the drums; livelier ones keep the pattern's extra notes.
 * - A busy phrase ends with a sixteenth-note fill.
 * Holds and rolls are never broken.
 */
export function applyDrums(pattern: readonly Step[], drums: Drums, opts: DrumOptions): Step[] {
  if (pattern.some((s) => s && typeof s === "object" && "roll" in s)) return [...pattern];
  let out: Step[] = [...pattern];
  const scale = () => out.length / STEPS;
  const drumLane = (eighth: number): Lane | null =>
    drums.snare.includes(eighth) ? "j" : drums.kick.includes(eighth) ? "f" : null;
  const grooved = drums.kick.length + drums.snare.length > 0;

  // 1. Thin chords to single notes: the drum at that step, else the opposite hand to the note before.
  let prev: Lane = "j";
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s === "both") {
      const drum = i % scale() === 0 ? drumLane(i / scale()) : null;
      out[i] = drum ?? other(prev);
    }
    const lanes = lanesOf(out[i]);
    if (lanes.length === 1) prev = lanes[0];
    else if (s && typeof s === "object" && "hold" in s) prev = s.hold;
  }

  // 2. Lay the drums over the pattern.
  const isDrumStep = new Set<number>();
  for (let e = 0; e < STEPS; e++) {
    const lane = drumLane(e);
    if (!lane) continue;
    const i = e * scale();
    if ((out[i] && typeof out[i] === "object") || busyLanes(out, i).has(lane)) continue;
    out[i] = lane;
    isDrumStep.add(i);
    // On a sixteenth grid, don't leave a note of the same lane right next to the drum.
    for (const n of [i - 1, i + 1]) if (scale() > 1 && lanesOf(out[n] ?? null).includes(lane)) out[n] = null;
  }

  // 3. Calm sections: just the drums (holds stay).
  if (opts.intensity === "calm" && grooved) {
    out = out.map((s, i) => (typeof s === "string" && !isDrumStep.has(i) ? null : s));
  }

  // 4. A busy phrase ends with a fill across the last half bar.
  if (opts.intensity === "busy" && opts.barInPhrase === 3) {
    const wide: Step[] = out.length === 16 ? out : out.flatMap((s) => [s, null]);
    const free = wide.slice(8).every((s) => !s || typeof s === "string") && busyLanes(wide, 8).size === 0;
    if (free) {
      const fill = FILLS[opts.phrase % FILLS.length];
      for (let k = 0; k < 8; k++) wide[8 + k] = fill[k];
      if (lanesOf(wide[7]).some((l) => lanesOf(fill[0]).includes(l))) wide[7] = null;
      out = wide;
    }
  }

  // 5. The phrase opens with a chord (the crash), unless it's calm or a hold is there.
  if (opts.barInPhrase === 0 && opts.intensity !== "calm" && (out[0] === null || typeof out[0] === "string")) {
    out[0] = "both";
    if (scale() > 1 && lanesOf(out[1]).length) out[1] = null;
  }
  return out;
}
