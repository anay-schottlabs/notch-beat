import type { BeatEstimate } from "../../services/audio/types";

/**
 * Where note timing comes from. Estimated beats are used only when the analyser
 * is confident; otherwise the deterministic practice chart keeps the game
 * playable instead of producing erratic notes.
 */
export type ChartSource =
  | { kind: "practice"; bpm: number; reason: "noAudio" | "lowConfidence" | "outOfRange" }
  | { kind: "estimated"; bpm: number; phaseMs: number; confidence: number };

export const MIN_CONFIDENCE = 0.6;
export const BPM_RANGE = { min: 60, max: 200 } as const;

export function selectChartSource(
  estimate: BeatEstimate | null,
  practiceBpm: number,
  minConfidence = MIN_CONFIDENCE,
): ChartSource {
  if (!estimate) return { kind: "practice", bpm: practiceBpm, reason: "noAudio" };
  if (!(estimate.confidence >= minConfidence)) return { kind: "practice", bpm: practiceBpm, reason: "lowConfidence" };
  if (!(estimate.bpm >= BPM_RANGE.min && estimate.bpm <= BPM_RANGE.max)) {
    return { kind: "practice", bpm: practiceBpm, reason: "outOfRange" };
  }
  return { kind: "estimated", bpm: estimate.bpm, phaseMs: estimate.phaseMs, confidence: estimate.confidence };
}
