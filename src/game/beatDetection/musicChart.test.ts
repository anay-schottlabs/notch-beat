import { describe, expect, it } from "vitest";
import type { BeatEstimate } from "../../services/audio/types";
import { GameEngine } from "../engine";
import { ManualClock } from "../timing/clock";
import { MusicChart } from "./musicChart";

/** Clock and song time coincide in these tests unless an engine is involved. */
function chartWith(estimate: () => BeatEstimate | null, offset = 0) {
  return new MusicChart({ estimate, clockToSong: (c) => c, offsetMs: () => offset, leadInMs: 2000 }, 120);
}

const onGrid = (t: number, phase: number, interval: number) => {
  const r = (((t - phase) % interval) + interval) % interval;
  return Math.min(r, interval - r) < 0.01;
};

describe("MusicChart", () => {
  it("places notes on the estimated beat grid after the lead-in", () => {
    const est = { bpm: 125, phaseMs: 333, confidence: 0.9 };
    const chart = chartWith(() => est);
    const notes = chart.take(20_000);
    const sixteenth = 60000 / 125 / 4;
    expect(notes.length).toBeGreaterThan(20);
    expect(notes[0].timeMs).toBeGreaterThanOrEqual(2000);
    for (const n of notes) expect(onGrid(n.timeMs, 333, sixteenth)).toBe(true);
    expect(chart.bpm).toBeCloseTo(125);
  });

  it("rests instead of guessing when the estimate is unreliable", () => {
    let est: BeatEstimate | null = null;
    const chart = chartWith(() => est);
    expect(chart.take(10_000)).toEqual([]);
    est = { bpm: 120, phaseMs: 0, confidence: 0.3 };
    expect(chart.take(20_000)).toEqual([]);
    // Beats still exist so the lane keeps its grid.
    expect(chart.beatsBetween(0, 20_000).length).toBeGreaterThan(10);
  });

  it("starts charting as soon as the estimate becomes reliable", () => {
    let est: BeatEstimate | null = null;
    const chart = chartWith(() => est);
    chart.take(6000);
    est = { bpm: 100, phaseMs: 50, confidence: 0.8 };
    const notes = chart.take(16_000);
    expect(notes.length).toBeGreaterThan(5);
    for (const n of notes) expect(onGrid(n.timeMs, 50, 150)).toBe(true);
  });

  it("corrects phase drift at each new bar without moving taken notes", () => {
    let est: BeatEstimate = { bpm: 120, phaseMs: 0, confidence: 0.9 };
    const chart = chartWith(() => est);
    const first = chart.take(6000);
    // The song is actually 40 ms later than first thought.
    est = { bpm: 120, phaseMs: 40, confidence: 0.9 };
    const later = chart.take(14_000);
    expect(first.every((n) => onGrid(n.timeMs, 0, 125))).toBe(true);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((n) => onGrid(n.timeMs, 40, 125))).toBe(true);
  });

  it("applies the calibration offset", () => {
    const chart = chartWith(() => ({ bpm: 120, phaseMs: 0, confidence: 0.9 }), 30);
    for (const n of chart.take(10_000)) expect(onGrid(n.timeMs, 30, 250)).toBe(true);
  });

  it("marks the first beat of each generated bar as a downbeat", () => {
    const chart = chartWith(() => ({ bpm: 120, phaseMs: 0, confidence: 0.9 }));
    chart.take(10_000);
    const beats = chart.beatsBetween(0, 10_000);
    expect(beats.filter((b) => chart.isDownbeat(b)).length).toBe(Math.ceil(beats.length / 4));
  });

  it("re-anchors to the music after a pause", () => {
    const clock = new ManualClock(0);
    // The song's beats are at clock times 0, 500, 1000... regardless of the game.
    const est = { bpm: 120, phaseMs: 0, confidence: 0.9 };
    const engine: GameEngine = new GameEngine({
      clock,
      chart: new MusicChart({ estimate: () => est, clockToSong: (c) => engine.songTime(c) }, 120),
    });
    engine.start();
    clock.set(3000);
    engine.update();
    engine.pause();
    clock.set(3000 + 10_130); // pause for 10.13 s: the music moves on by a non-whole number of beats
    engine.resume();
    clock.advance(4000);
    engine.update();
    const song = engine.songTime();
    const upcoming = engine.visibleNotes().filter((n) => n.timeMs > song - 500 && !n.result);
    expect(upcoming.length).toBeGreaterThan(0);
    // Every upcoming note lines up with the music's clock-time beat grid.
    for (const n of upcoming) {
      const clockTime = n.timeMs + (clock.now() - song);
      expect(onGrid(clockTime, 0, 250)).toBe(true);
    }
  });
});
