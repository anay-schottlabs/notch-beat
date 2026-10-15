import { describe, expect, it } from "vitest";
import { GameEngine } from "../../game/engine";
import { ManualClock } from "../../game/timing/clock";
import { DEFAULT_SEQUENCE } from "../../game/timing/beatSequence";
import { audioService } from "../../services/audio/audioService";
import type { AudioAnalysisService } from "../../services/audio/types";
import { BAND_COUNT, sampleVisual } from "./visualSignal";

const bands = () => new Float32Array(BAND_COUNT);

describe("visual signal fallback", () => {
  it("never reports audio when no audio is available", () => {
    const engine = new GameEngine({ clock: new ManualClock() });
    expect(sampleVisual({ nowMs: 0, engine, audio: audioService, mediaPlaying: true }, bands()).source).toBe("idle");
    expect(sampleVisual({ nowMs: 0, engine, audio: audioService, mediaPlaying: false }, bands())).toEqual({ source: "still", pulse: 0 });
  });

  it("pulses on the practice beat while playing", () => {
    const clock = new ManualClock();
    const engine = new GameEngine({ clock });
    engine.start();
    clock.set(DEFAULT_SEQUENCE.leadInMs); // exactly on a beat
    const out = bands();
    const onBeat = sampleVisual({ nowMs: 0, engine, audio: audioService, mediaPlaying: false }, out);
    expect(onBeat.source).toBe("practice");
    expect(onBeat.pulse).toBeCloseTo(1);
    clock.advance(60000 / engine.bpm / 2);
    expect(sampleVisual({ nowMs: 0, engine, audio: audioService, mediaPlaying: false }, out).pulse).toBeLessThan(0.2);
  });

  it("prefers real audio features when present", () => {
    const live: AudioAnalysisService = {
      ...audioService,
      availability: () => ({ status: "active" }),
      features: () => ({ level: 0.5, low: 0.9, mid: 0.4, high: 0.1, pulse: 1, transient: false, kick: false, snare: false, energy: 0.5, buildup: 0 }),
    };
    const out = bands();
    const r = sampleVisual({ nowMs: 0, engine: new GameEngine(), audio: live, mediaPlaying: true }, out);
    expect(r.source).toBe("audio");
    expect(out[0]).toBeCloseTo(0.9);
    expect(out[4]).toBeCloseTo(0.1);
  });
});
