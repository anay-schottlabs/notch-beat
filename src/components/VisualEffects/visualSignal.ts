import type { GameEngine } from "../../game/engine";
import { MIN_CONFIDENCE } from "../../game/beatDetection/chartSource";
import type { AudioAnalysisService } from "../../services/audio/types";

/**
 * Which signal drives the visuals right now. Shown in the UI so that synthetic
 * animation is never presented as music analysis.
 */
export type VisualSource =
  /** Real audio features from the analysis service. */
  | "audio"
  /** The practice chart's beat clock while a game is running. */
  | "practice"
  /** Gentle synthetic motion: music is playing but no audio is available. */
  | "idle"
  /** Nothing playing. */
  | "still";

export const BAND_COUNT = 5;

export interface VisualInputs {
  nowMs: number;
  engine: GameEngine;
  audio: AudioAnalysisService;
  mediaPlaying: boolean;
}

/** Fills `bands` (0..1) and returns the source plus a 0..1 beat pulse. */
export function sampleVisual(inputs: VisualInputs, bands: Float32Array): { source: VisualSource; pulse: number } {
  const features = inputs.audio.features();
  if (features) {
    const shape = [features.low, (features.low + features.mid) / 2, features.mid, (features.mid + features.high) / 2, features.high];
    for (let i = 0; i < BAND_COUNT; i++) bands[i] = shape[i] * (0.75 + 0.25 * features.pulse);
    // Pulse on the estimated beat when it's reliable; otherwise on detected transients.
    const beat = inputs.audio.beatEstimate();
    if (beat && beat.confidence >= MIN_CONFIDENCE) {
      const interval = 60000 / beat.bpm;
      const phase = ((((inputs.nowMs - beat.phaseMs) % interval) + interval) % interval) / interval;
      return { source: "audio", pulse: Math.max((1 - phase) ** 4, features.pulse * 0.5) };
    }
    return { source: "audio", pulse: features.pulse };
  }

  if (inputs.engine.getPhase() === "playing") {
    const phase = inputs.engine.beatPhase();
    const pulse = phase === null ? 0 : (1 - phase) ** 3;
    for (let i = 0; i < BAND_COUNT; i++) {
      const centre = 1 - Math.abs(i - (BAND_COUNT - 1) / 2) / BAND_COUNT;
      bands[i] = 0.18 + pulse * (0.45 + 0.35 * centre);
    }
    return { source: "practice", pulse };
  }

  if (inputs.mediaPlaying) {
    const t = inputs.nowMs / 1000;
    for (let i = 0; i < BAND_COUNT; i++) bands[i] = 0.3 + 0.14 * Math.sin(t * 1.7 + i * 1.25) + 0.06 * Math.sin(t * 3.1 + i * 2.1);
    return { source: "idle", pulse: 0 };
  }

  bands.fill(0.14);
  return { source: "still", pulse: 0 };
}
