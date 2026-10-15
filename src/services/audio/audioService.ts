import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import type { AudioAnalysisService, AudioAvailability, AudioFeatures, BeatEstimate } from "./types";

const ENABLED_KEY = "notchbeat.listen";
const FEATURES_STALE_MS = 250;
const BEAT_STALE_MS = 2000;

interface BeatPayload {
  bpm: number;
  confidence: number;
  ageMs: number;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    // Not persisted; listening just won't auto-start next launch.
  }
}

/** Backend capture via the Rust audio service (Core Audio tap on Spotify). */
function createTauriAudio(): AudioAnalysisService {
  let availability: AudioAvailability = { status: "off" };
  let enabled = readEnabled();
  let features: AudioFeatures | null = null;
  let featuresAt = 0;
  let beat: BeatEstimate | null = null;
  let beatAt = 0;
  let kicks: number[] = [];
  let snares: number[] = [];
  const listeners = new Set<() => void>();
  const dropListeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  void listen<AudioAvailability>("audio-status", (e) => {
    availability = e.payload;
    if (availability.status !== "active") features = null;
    notify();
  });
  void listen<AudioFeatures>("audio-features", (e) => {
    features = e.payload;
    featuresAt = performance.now();
  });
  // Drum hits, kept for the last ~12 s (clock times, oldest first).
  const remember = (hits: number[], ageMs: number) => {
    const now = performance.now();
    hits.push(now - ageMs);
    return hits.length > 64 || now - hits[0] > 12_000 ? hits.filter((k) => now - k <= 12_000) : hits;
  };
  void listen<number>("audio-kick", (e) => void (kicks = remember(kicks, e.payload)));
  void listen<number>("audio-snare", (e) => void (snares = remember(snares, e.payload)));
  void listen("audio-drop", () => dropListeners.forEach((l) => l()));
  void listen<BeatPayload | null>("audio-beat", (e) => {
    const now = performance.now();
    beat = e.payload ? { bpm: e.payload.bpm, confidence: e.payload.confidence, phaseMs: now - e.payload.ageMs } : null;
    beatAt = now;
    notify();
  });
  void invoke<AudioAvailability>("audio_status").then((s) => {
    availability = s;
    notify();
  });
  // Resume listening if the user turned it on in a previous session (permission already decided).
  if (enabled) void invoke("audio_set_enabled", { enabled: true });

  return {
    availability: () => availability,
    enabled: () => enabled,
    setEnabled: async (on) => {
      enabled = on;
      writeEnabled(on);
      availability = await invoke<AudioAvailability>("audio_set_enabled", { enabled: on });
      notify();
    },
    features: () => (features && performance.now() - featuresAt < FEATURES_STALE_MS ? features : null),
    beatEstimate: () => (beat && performance.now() - beatAt < BEAT_STALE_MS ? beat : null),
    recentKicks: () => kicks,
    recentSnares: () => snares,
    onDrop: (l) => {
      dropListeners.add(l);
      return () => dropListeners.delete(l);
    },
    newSong: () => {
      kicks = [];
      snares = [];
      beat = null;
      void invoke("audio_new_song").catch(() => {});
      notify();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

// A stable object: availability() feeds useSyncExternalStore, which needs referential stability.
const UNSUPPORTED: AudioAvailability = { status: "unsupported", reason: "Audio capture needs the NotchBeat app" };

const unsupported: AudioAnalysisService = {
  availability: () => UNSUPPORTED,
  enabled: () => false,
  setEnabled: async () => {},
  features: () => null,
  beatEstimate: () => null,
  recentKicks: () => [],
  recentSnares: () => [],
  onDrop: () => () => {},
  newSong: () => {},
  subscribe: () => () => {},
};

export const audioService: AudioAnalysisService = isTauri ? createTauriAudio() : unsupported;
