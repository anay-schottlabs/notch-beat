import type { Note } from "./types";

/**
 * A source of notes and beats in song time (ms since the session started,
 * excluding pauses). The engine pulls from it lazily, a lookahead window at a time.
 */
export interface Chart {
  readonly kind: "practice" | "music";
  /** Current tempo (may drift for music charts). */
  readonly bpm: number;
  /** Every not-yet-taken note with timeMs < untilMs, in order. */
  take(untilMs: number): Note[];
  /** Quarter-note beat times in [fromMs, toMs). */
  beatsBetween(fromMs: number, toMs: number): number[];
  isDownbeat(beatMs: number): boolean;
  /**
   * Called on resume. The music kept playing during the pause, so a music chart
   * re-anchors from here; notes after `songMs` have already been discarded.
   */
  resync?(songMs: number): void;
}
