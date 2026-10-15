import type { Judgment } from "../types";

/** Half-widths in ms around the note time. Early presses inside missMs are judged as a miss. */
export interface TimingWindows {
  perfectMs: number;
  goodMs: number;
  missMs: number;
}

export const DEFAULT_WINDOWS: TimingWindows = {
  perfectMs: 35,
  goodMs: 75,
  missMs: 115,
};

export function validateWindows(w: TimingWindows): TimingWindows {
  if (!(w.perfectMs > 0 && w.perfectMs <= w.goodMs && w.goodMs <= w.missMs)) {
    throw new RangeError(`timing windows must satisfy 0 < perfect <= good <= miss, got ${JSON.stringify(w)}`);
  }
  return w;
}

/**
 * Judge a press `deltaMs` after the note (negative = early).
 * Returns null when the press is too far from the note to count at all.
 */
export function judge(deltaMs: number, windows: TimingWindows = DEFAULT_WINDOWS): Judgment | null {
  const d = Math.abs(deltaMs);
  if (d <= windows.perfectMs) return "perfect";
  if (d <= windows.goodMs) return "good";
  if (d <= windows.missMs) return "miss";
  return null;
}
