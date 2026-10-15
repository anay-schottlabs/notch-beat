import type { Chart } from "../chart";
import type { Lane, Note } from "../types";

/**
 * Deterministic practice charts: the same seed and BPM always yield the same notes,
 * so the game is playable (and testable) without any audio input.
 */
export interface SequenceConfig {
  bpm: number;
  seed: number;
  /** Silence before the first note so the player can get ready. */
  leadInMs: number;
  /** Bars before eighth-note patterns are allowed. */
  warmupBars: number;
}

export const DEFAULT_SEQUENCE: SequenceConfig = {
  bpm: 120,
  seed: 0x5eed,
  leadInMs: 2000,
  warmupBars: 4,
};

/** A held note: hit on this step, keep it down for `steps` eighth notes. */
export interface Hold {
  hold: Lane;
  steps: number;
}

/** A drumroll across both tracks for `steps` eighth notes: mash either key. */
export interface Roll {
  roll: number;
}

/**
 * A bar is 8 eighth-note steps or 16 sixteenth-note steps. One step: a single lane, both lanes at once (a chord), a held
 * note, or a rest. During a hold only the other lane may have notes.
 */
export type Step = Lane | "both" | Hold | Roll | null;

const B = "both";
const H = (hold: Lane, steps: number): Hold => ({ hold, steps });
const R = (roll: number): Roll => ({ roll });

/** Quiet sections: sparse, mostly on the beat. */
export const CALM_PATTERNS: readonly Step[][] = [
  ["f", null, null, null, "j", null, null, null],
  [B, null, null, null, "f", null, null, null],
  ["j", null, null, null, "f", null, "j", null],
  [H("f", 3), null, null, null, "j", null, null, null],
  ["f", null, "j", null, "f", null, "j", null],
  [B, null, "j", null, null, null, "f", null],
];

/** A drumroll that lands on a chord: the bar before a drop. */
export const ROLL_PATTERN: readonly Step[] = [R(6), null, null, null, null, null, null, B];

/** Eight eighth-note steps per 4/4 bar, all on the beat: the first bars of a practice chart. */
export const WARMUP_PATTERNS: readonly Step[][] = [
  [B, null, "f", null, "j", null, "f", null],
  ["f", null, "j", null, "f", null, B, null],
  [B, null, "j", null, B, null, "j", null],
  [H("f", 3), null, "j", null, "f", null, "j", null],
];

/** Normal sections: steady beats with off-beat pickups, chords on strong beats, holds. */
export const EASY_PATTERNS: readonly Step[][] = [
  [B, null, "f", "j", "f", null, "j", null],
  ["f", null, "j", "j", "f", null, B, null],
  [B, null, "j", null, B, "f", "j", null],
  ["f", "j", null, "j", "f", null, "j", "f"],
  // Holds: keep one hand down while the other keeps time.
  [H("f", 3), "j", null, "j", "f", null, "j", null],
  ["j", null, "f", null, H("j", 3), "f", "f", null],
  [H("f", 2), "j", null, "j", "f", null, B, null],
];

export const BUSY_PATTERNS: readonly Step[][] = [
  [B, null, "f", "f", "j", null, B, null],
  ["f", "j", "f", null, B, null, "j", null],
  [B, null, "j", "j", "f", null, B, null],
  ["j", null, "f", null, "f", "j", B, null],
  [B, "f", "j", null, B, "f", "j", null],
  [H("f", 6), "j", null, "j", null, "j", "j", null],
  [B, null, H("j", 3), "f", "f", null, "j", null],
  [H("j", 3), "f", "f", null, H("f", 3), "j", "j", null],
  ["f", "j", "f", "j", B, null, "f", "j"],
  [B, "j", "f", null, "j", "f", B, null],
  [H("j", 4), "f", null, "f", null, B, "f", "j"],
  [B, "f", "j", "f", B, "j", "f", "j"],
  // Sixteen-step bars: sixteenth-note runs that alternate hands (never the same lane twice in a row).
  ["f", null, "j", null, "f", "j", "f", null, B, null, "j", null, "f", "j", "f", null],
  [B, null, null, "j", "f", null, "j", null, B, null, null, "j", "f", "j", "f", "j"],
  [H("f", 6), null, "j", null, "j", null, "j", null, B, null, "f", "j", "f", null, B, null],
  ["j", "f", "j", "f", null, null, B, null, "f", "j", "f", "j", null, null, B, null],
  [B, null, "f", "j", "f", null, "j", null, B, null, "f", "j", "f", "j", null, B],
];

/** Every lane a step puts a note in. */
function stepLanes(step: Step): Lane[] {
  if (!step) return [];
  if (step === B) return ["f", "j"];
  if (typeof step === "string") return [step];
  return "hold" in step ? [step.hold] : ["f", "j"];
}

/** True if no lane gets a note while it's being held, and holds end within the bar. */
export function isPlayable(pattern: readonly Step[]): boolean {
  const busyUntil: Record<Lane, number> = { f: -1, j: -1 };
  for (let i = 0; i < pattern.length; i++) {
    const step = pattern[i];
    for (const lane of stepLanes(step)) {
      if (i <= busyUntil[lane]) return false;
    }
    if (step && typeof step === "object") {
      const steps = "hold" in step ? step.steps : step.roll;
      if (steps < 1 || i + steps >= pattern.length) return false;
      for (const lane of stepLanes(step)) busyUntil[lane] = i + steps;
    }
  }
  return true;
}

/** Notes for one bar's pattern (`eighthMs` is an eighth note). Ids are unique per (bar, step, lane). */
export function notesForBar(pattern: readonly Step[], barIndex: number, barStartMs: number, eighthMs: number): Note[] {
  const notes: Note[] = [];
  const per = 16 / pattern.length; // sixteenths per step
  const stepMs = (eighthMs * 8) / pattern.length;
  pattern.forEach((step, i) => {
    if (!step) return;
    const timeMs = barStartMs + i * stepMs;
    const id = (barIndex * 16 + i * per) * 2;
    if (typeof step === "object") {
      if ("hold" in step) {
        notes.push({ id: id + (step.hold === "f" ? 0 : 1), lane: step.hold, timeMs, durationMs: step.steps * stepMs, kind: "hold" });
      } else {
        notes.push({ id, lane: "f", timeMs, durationMs: step.roll * stepMs, kind: "roll" });
      }
      return;
    }
    if (step === "f" || step === B) notes.push({ id, lane: "f", timeMs });
    if (step === "j" || step === B) notes.push({ id: id + 1, lane: "j", timeMs });
  });
  return notes;
}

/** Small fast seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function beatIntervalMs(bpm: number): number {
  return 60000 / bpm;
}

export function barDurationMs(bpm: number): number {
  return beatIntervalMs(bpm) * 4;
}

/** How intense a bar should be. Music charts derive it from the song's energy. */
export type Intensity = "calm" | "normal" | "busy";

/**
 * Pattern for a bar; depends only on (seed, barIndex[, intensity]), so bars can be
 * generated in any order. Without an intensity (practice), it mixes normal and busy
 * bars after on-the-beat warmup bars and drops in a drumroll every 16 bars.
 */
export function patternForBar(config: SequenceConfig, barIndex: number, intensity?: Intensity): readonly Step[] {
  const rand = mulberry32(config.seed ^ Math.imul(barIndex + 1, 0x9e3779b1));
  if (!intensity && barIndex < config.warmupBars) return WARMUP_PATTERNS[Math.floor(rand() * WARMUP_PATTERNS.length)];
  if (!intensity && barIndex % 16 === 15) return ROLL_PATTERN;
  const level = intensity ?? (rand() < 0.8 ? "busy" : "normal");
  const pool = level === "calm" ? CALM_PATTERNS : level === "busy" ? BUSY_PATTERNS : EASY_PATTERNS;
  return pool[Math.floor(rand() * pool.length)];
}

export function generateBar(config: SequenceConfig, barIndex: number): Note[] {
  if (!(config.bpm > 0)) throw new RangeError(`bpm must be positive, got ${config.bpm}`);
  const barStart = config.leadInMs + barIndex * barDurationMs(config.bpm);
  return notesForBar(patternForBar(config, barIndex), barIndex, barStart, beatIntervalMs(config.bpm) / 2);
}

/** Endless practice chart, generated lazily one bar at a time. */
export class BeatSequence implements Chart {
  readonly kind = "practice";
  private generatedBars = 0;
  private buffer: Note[] = [];

  constructor(readonly config: SequenceConfig = DEFAULT_SEQUENCE) {}

  get bpm(): number {
    return this.config.bpm;
  }

  isDownbeat(beatMs: number): boolean {
    return Math.round((beatMs - this.config.leadInMs) / beatIntervalMs(this.config.bpm)) % 4 === 0;
  }

  /** Returns, in order, every not-yet-taken note with timeMs < untilMs. */
  take(untilMs: number): Note[] {
    const barMs = barDurationMs(this.config.bpm);
    while (this.config.leadInMs + this.generatedBars * barMs < untilMs) {
      this.buffer.push(...generateBar(this.config, this.generatedBars));
      this.generatedBars++;
    }
    let n = 0;
    while (n < this.buffer.length && this.buffer[n].timeMs < untilMs) n++;
    return this.buffer.splice(0, n);
  }

  /** Song times of quarter-note beats in [fromMs, toMs), for metronome and visuals. */
  beatsBetween(fromMs: number, toMs: number): number[] {
    const interval = beatIntervalMs(this.config.bpm);
    const first = Math.max(0, Math.ceil((fromMs - this.config.leadInMs) / interval));
    const beats: number[] = [];
    for (let i = first; ; i++) {
      const t = this.config.leadInMs + i * interval;
      if (t >= toMs) break;
      beats.push(t);
    }
    return beats;
  }
}
