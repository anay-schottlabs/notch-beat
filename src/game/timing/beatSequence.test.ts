import { describe, expect, it } from "vitest";
import { barDurationMs, BeatSequence, beatIntervalMs, DEFAULT_SEQUENCE, generateBar, mulberry32 } from "./beatSequence";

describe("beat sequence", () => {
  const config = { ...DEFAULT_SEQUENCE, bpm: 120, leadInMs: 1000 };

  it("is deterministic for the same seed", () => {
    const a = new BeatSequence(config).take(30_000);
    const b = new BeatSequence(config).take(30_000);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("differs for a different seed", () => {
    const a = new BeatSequence(config).take(30_000);
    const b = new BeatSequence({ ...config, seed: 1234 }).take(30_000);
    expect(a).not.toEqual(b);
  });

  it("places every note on the sixteenth-note grid after the lead-in", () => {
    const step = beatIntervalMs(120) / 4;
    for (const n of new BeatSequence(config).take(20_000)) {
      expect(n.timeMs).toBeGreaterThanOrEqual(1000);
      expect(((n.timeMs - 1000) / step) % 1).toBeCloseTo(0);
      expect(["f", "j"]).toContain(n.lane);
    }
  });

  it("keeps warmup bars on quarter notes", () => {
    const beat = beatIntervalMs(120);
    for (let bar = 0; bar < config.warmupBars; bar++) {
      for (const n of generateBar(config, bar)) {
        expect(((n.timeMs - 1000) / beat) % 1).toBeCloseTo(0);
      }
    }
  });

  it("hands out each note once, in order, with unique ids", () => {
    const seq = new BeatSequence(config);
    const first = seq.take(5000);
    const second = seq.take(12_000);
    const all = [...first, ...second];
    expect(first.every((n) => n.timeMs < 5000)).toBe(true);
    expect(second.every((n) => n.timeMs >= 5000 && n.timeMs < 12_000)).toBe(true);
    expect(new Set(all.map((n) => n.id)).size).toBe(all.length);
    expect(all.map((n) => n.timeMs)).toEqual([...all.map((n) => n.timeMs)].sort((x, y) => x - y));
  });

  it("lists quarter beats in a range", () => {
    const seq = new BeatSequence(config);
    expect(seq.beatsBetween(0, 2600)).toEqual([1000, 1500, 2000, 2500]);
    expect(barDurationMs(120)).toBe(2000);
  });

  it("includes chords: both lanes at the same time, with distinct ids", () => {
    const notes = new BeatSequence(config).take(30_000);
    const byTime = new Map<number, string[]>();
    for (const n of notes) byTime.set(n.timeMs, [...(byTime.get(n.timeMs) ?? []), n.lane]);
    const chords = [...byTime.values()].filter((lanes) => lanes.length === 2);
    expect(chords.length).toBeGreaterThan(5);
    for (const lanes of chords) expect(lanes.sort()).toEqual(["f", "j"]);
    expect([...byTime.values()].every((lanes) => lanes.length <= 2)).toBe(true);
  });

  it("rejects a non-positive bpm", () => {
    expect(() => generateBar({ ...config, bpm: 0 }, 0)).toThrow(RangeError);
  });

  it("has a seeded PRNG in [0, 1)", () => {
    const r = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
