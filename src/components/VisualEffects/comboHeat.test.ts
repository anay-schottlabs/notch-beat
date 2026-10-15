import { describe, expect, it } from "vitest";
import { comboHeat, comboTier } from "./comboHeat";

describe("combo heat", () => {
  it("rises with the combo and saturates", () => {
    expect(comboHeat(0)).toBe(0);
    expect(comboHeat(10)).toBeGreaterThan(0.25);
    expect(comboHeat(25)).toBeGreaterThan(comboHeat(10));
    expect(comboHeat(50)).toBeGreaterThan(comboHeat(25));
    expect(comboHeat(500)).toBe(1);
  });

  it("has tiers at 10, 25, 50 and 100", () => {
    expect([0, 9, 10, 25, 50, 99, 100].map(comboTier)).toEqual([0, 0, 1, 2, 3, 3, 4]);
  });
});
