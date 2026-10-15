import { useSyncExternalStore } from "react";
import type { AudioAnalysisService, AudioAvailability, BeatEstimate } from "../services/audio/types";

export interface AudioState {
  availability: AudioAvailability;
  enabled: boolean;
  beat: BeatEstimate | null;
}

/** Re-renders on status changes and beat updates (~4 Hz while listening), never per audio frame. */
export function useAudioState(audio: AudioAnalysisService): AudioState {
  const availability = useSyncExternalStore(audio.subscribe, audio.availability);
  const enabled = useSyncExternalStore(audio.subscribe, audio.enabled);
  const beat = useSyncExternalStore(audio.subscribe, audio.beatEstimate);
  return { availability, enabled, beat };
}
