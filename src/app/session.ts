import { MusicChart } from "../game/beatDetection/musicChart";
import { GameEngine } from "../game/engine";
import { DEFAULT_SEQUENCE } from "../game/timing/beatSequence";
import { audioService } from "../services/audio/audioService";
import { spotifyService } from "../services/spotify/spotifyService";

/** App-lifetime singletons. Collapsing the panel keeps the session; only Reset clears it. */
export const engine = new GameEngine();
export const media = spotifyService;
export const audio = audioService;


/** User calibration for music charts: positive = notes later. Adjusted with [ and ]. */
let syncOffsetMs = readNumber("notchbeat.syncOffset");
const offsetListeners = new Set<() => void>();

export function getSyncOffset(): number {
  return syncOffsetMs;
}

export function nudgeSyncOffset(deltaMs: number): void {
  syncOffsetMs = Math.max(-300, Math.min(300, syncOffsetMs + deltaMs));
  write("notchbeat.syncOffset", String(syncOffsetMs));
  offsetListeners.forEach((l) => l());
}

export function subscribeSyncOffset(l: () => void): () => void {
  offsetListeners.add(l);
  return () => offsetListeners.delete(l);
}

function musicChart(bpm: number): MusicChart {
  return new MusicChart(
    {
      estimate: () => audio.beatEstimate(),
      clockToSong: (c) => engine.songTime(c),
      offsetMs: getSyncOffset,
      section: () => {
        const f = audio.features();
        return f ? { energy: f.energy, buildup: f.buildup } : null;
      },
      kicks: () => audio.recentKicks(),
      snares: () => audio.recentSnares(),
    },
    bpm,
  );
}

/** A chart on the song's beat. It rests until the analyser has found the beat. */
function freshChart(): MusicChart {
  return musicChart(audio.beatEstimate()?.bpm ?? DEFAULT_SEQUENCE.bpm);
}

/** Start, pause or resume. Notes always follow the music (there is no practice chart). */
export function togglePlay(): void {
  if (engine.getPhase() === "idle") engine.reset(freshChart());
  engine.toggle();
}

// A drop in the music is a moment for the visuals while playing.
audio.onDrop(() => engine.getPhase() === "playing" && engine.cue("drop"));

/**
 * Spotify moved to another song. Tempo and energy tracking start over; a run in
 * progress gets an end-of-song flourish and carries straight on with a fresh
 * chart (a music chart rests until it has found the new song's beat).
 */
export function songChanged(): void {
  audio.newSong();
  if (engine.getPhase() !== "playing") return;
  engine.cue("songEnd");
  engine.restart(musicChart(engine.bpm));
}

/** Clear the session. The next Start picks a chart afresh. */
export function resetGame(): void {
  engine.reset(freshChart());
}

function readNumber(key: string): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: lasts for this session only.
  }
}
