/**
 * Audio analysis interface. The backend captures Spotify's output with a Core
 * Audio process tap and publishes features; renderers and the game only ever
 * see these features, never raw audio.
 */
export type AudioAvailability =
  /** No capture backend in this environment (e.g. browser preview). */
  | { status: "unsupported"; reason: string }
  /** The user hasn't turned listening on. */
  | { status: "off" }
  | { status: "waitingForSpotify" }
  | { status: "starting" }
  | { status: "active" }
  /** Capturing, but silent while Spotify is playing: usually a denied permission. */
  | { status: "silent" }
  | { status: "error"; message: string };

export interface AudioFeatures {
  /** Smoothed overall level, 0..1. */
  level: number;
  /** Smoothed band energies, 0..1. */
  low: number;
  mid: number;
  high: number;
  /** Decaying onset envelope, 0..1. */
  pulse: number;
  /** True for the analysis frame in which a transient onset was detected. */
  transient: boolean;
  /** True for a strong bass onset (kick drum, bass hit). */
  kick: boolean;
  /** True for a snare/clap onset (mids and highs, no bass hit). */
  snare: boolean;
  /** Section energy, 0..1 relative to this song. */
  energy: number;
  /** How steadily energy is rising, 0..1. */
  buildup: number;
}

export interface BeatEstimate {
  bpm: number;
  /** Clock time (performance.now() origin) of a recent estimated beat. */
  phaseMs: number;
  /** 0..1; low values must not drive gameplay. */
  confidence: number;
}

export interface AudioAnalysisService {
  availability(): AudioAvailability;
  /** Whether the user has turned listening on (persisted). */
  enabled(): boolean;
  /** User-initiated: the first time, macOS asks for audio recording permission. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Latest features, or null when not active. Cheap to call every frame. */
  features(): AudioFeatures | null;
  beatEstimate(): BeatEstimate | null;
  /** Clock times (performance.now() origin) of bass hits in the last ~12 s, oldest first. */
  recentKicks(): readonly number[];
  /** Clock times of snare/clap hits in the last ~12 s, oldest first. */
  recentSnares(): readonly number[];
  /** Called when a drop is detected. */
  onDrop(listener: () => void): () => void;
  /** The song changed: forget tempo and energy history. */
  newSong(): void;
  /** Fires on availability changes and new beat estimates (a few times a second), not per frame. */
  subscribe(listener: () => void): () => void;
}
