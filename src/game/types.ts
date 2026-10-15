export type Lane = "f" | "j";
export const LANES: readonly Lane[] = ["f", "j"];

export type Judgment = "perfect" | "good" | "miss";

export interface Note {
  readonly id: number;
  readonly lane: Lane;
  /** Target time in song milliseconds (0 = session start). */
  readonly timeMs: number;
  /** Holds and drumrolls: how long the note lasts. */
  readonly durationMs?: number;
  /** Absent for a normal tap. A roll spans both tracks: mash either key. */
  readonly kind?: "hold" | "roll";
}

export const isHold = (n: Note): boolean => n.kind === "hold";
export const isRoll = (n: Note): boolean => n.kind === "roll";

/** Which part of a note a judgment is for: the hit, or the end of a hold. */
export type NotePart = "head" | "tail";

export function noteEnd(n: Note): number {
  return n.timeMs + (n.durationMs ?? 0);
}
