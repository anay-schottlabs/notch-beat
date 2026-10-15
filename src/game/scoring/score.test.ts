import { describe, expect, it } from "vitest";
import { accuracy, applyJudgment, BASE_POINTS, comboMultiplier, INITIAL_SCORE, type ScoreState } from "./score";
import type { Judgment } from "../types";

const run = (judgments: Judgment[]): ScoreState =>
  judgments.reduce((s, j) => applyJudgment(s, j, j === "miss" ? null : 0), INITIAL_SCORE);

describe("scoring", () => {
  it("awards base points without combo bonus at first", () => {
    expect(run(["perfect"]).score).toBe(BASE_POINTS.perfect);
    expect(run(["good"]).score).toBe(BASE_POINTS.good);
    expect(run(["miss"]).score).toBe(0);
  });

  it("increments combo on hits and tracks the max", () => {
    const s = run(["perfect", "good", "perfect"]);
    expect(s.combo).toBe(3);
    expect(s.maxCombo).toBe(3);
  });

  it("breaks combo on a miss but keeps maxCombo", () => {
    const s = run(["perfect", "perfect", "miss", "good"]);
    expect(s.combo).toBe(1);
    expect(s.maxCombo).toBe(2);
    expect(s.counts).toEqual({ perfect: 2, good: 1, miss: 1 });
  });

  it("applies the combo multiplier from the combo held before the hit", () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(9)).toBe(1);
    expect(comboMultiplier(10)).toBeCloseTo(1.1);
    expect(comboMultiplier(1000)).toBe(2);
    const ten = run(Array<Judgment>(10).fill("perfect"));
    expect(ten.score).toBe(3000);
    expect(applyJudgment(ten, "perfect", 0).score).toBe(3000 + 330);
  });

  it("computes accuracy with goods worth half", () => {
    expect(accuracy(INITIAL_SCORE)).toBeNull();
    expect(accuracy(run(["perfect", "good", "miss", "perfect"]))).toBeCloseTo(2.5 / 4);
  });

  it("records the latest judgment with an increasing sequence number", () => {
    const s = run(["perfect", "miss"]);
    expect(s.last).toEqual({ judgment: "miss", deltaMs: null, seq: 2 });
  });

  it("never mutates the previous state", () => {
    const before = run(["perfect"]);
    const snapshot = JSON.stringify(before);
    applyJudgment(before, "miss", null);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
