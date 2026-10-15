import { describe, expect, it } from "vitest";
import { selectChartSource } from "./chartSource";
import { audioService } from "../../services/audio/audioService";

describe("chart source fallback", () => {
  it("uses the practice chart when audio is unavailable", () => {
    expect(audioService.features()).toBeNull();
    expect(selectChartSource(audioService.beatEstimate(), 112)).toEqual({ kind: "practice", bpm: 112, reason: "noAudio" });
  });

  it("falls back when the estimate isn't confident", () => {
    expect(selectChartSource({ bpm: 128, phaseMs: 0, confidence: 0.3 }, 112)).toMatchObject({ kind: "practice", reason: "lowConfidence" });
    expect(selectChartSource({ bpm: 128, phaseMs: 0, confidence: Number.NaN }, 112)).toMatchObject({ kind: "practice" });
  });

  it("falls back on implausible tempos", () => {
    expect(selectChartSource({ bpm: 400, phaseMs: 0, confidence: 0.9 }, 112)).toMatchObject({ kind: "practice", reason: "outOfRange" });
  });

  it("uses a confident, plausible estimate", () => {
    expect(selectChartSource({ bpm: 128, phaseMs: 50, confidence: 0.8 }, 112)).toEqual({ kind: "estimated", bpm: 128, phaseMs: 50, confidence: 0.8 });
  });
});
