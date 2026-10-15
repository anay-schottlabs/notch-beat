/** Player-agnostic media model. Spotify is the first provider; others can implement MediaService. */
export type PlaybackState = "playing" | "paused" | "stopped" | "unknown";

export type MediaAvailability =
  /** No integration on this platform (e.g. browser preview). */
  | "unsupported"
  | "notInstalled"
  | "notRunning"
  | "ready";

export type ControlPermission = "granted" | "denied" | "notDetermined" | "unknown";

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  artworkUrl: string | null;
}

export interface MediaSnapshot {
  provider: string;
  availability: MediaAvailability;
  state: PlaybackState;
  track: TrackInfo | null;
  /** Whether playback controls / artwork are authorised. */
  permission: ControlPermission;
  error: string | null;
}

/** "restart" jumps back to the start of the current track and plays. */
export type MediaCommand = "playPause" | "play" | "pause" | "next" | "previous" | "restart";

export interface MediaService {
  snapshot(): Promise<MediaSnapshot>;
  /** Calls back with the current snapshot, then on every change. */
  subscribe(cb: (s: MediaSnapshot) => void): () => void;
  control(command: MediaCommand): Promise<void>;
  /** User-initiated: may show the one-time macOS Automation prompt. */
  connect(): Promise<MediaSnapshot>;
}

export const UNSUPPORTED_MEDIA: MediaSnapshot = {
  provider: "none",
  availability: "unsupported",
  state: "unknown",
  track: null,
  permission: "unknown",
  error: null,
};
