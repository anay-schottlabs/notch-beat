import { MIN_CONFIDENCE } from "../../game/beatDetection/chartSource";
import type { AudioState } from "../../hooks/useAudioState";

/** A short note when listening is on but something needs attention; null when all is well or it's off. */
export function audioNotice(audio: AudioState): string | null {
  const a = audio.availability;
  switch (a.status) {
    case "active":
      if (!audio.beat) return "Listening… finding the beat";
      return audio.beat.confidence >= MIN_CONFIDENCE ? null : "Beat unclear: notes wait for a steady beat";
    case "starting":
      return "Starting to listen…";
    case "waitingForSpotify":
      return "Listening starts when Spotify opens";
    case "silent":
      return "Hearing nothing: allow NotchBeat in Privacy › Screen & System Audio Recording";
    case "error":
      return a.message;
    case "off":
    case "unsupported":
      return null;
  }
}
