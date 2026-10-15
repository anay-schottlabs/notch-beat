import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOWS, judge, validateWindows } from "./judge";

describe("judge", () => {
  const w = { perfectMs: 40, goodMs: 90, missMs: 140 };

  it("is perfect up to and including the perfect window, early or late", () => {
    expect(judge(0, w)).toBe("perfect");
    expect(judge(40, w)).toBe("perfect");
    expect(judge(-40, w)).toBe("perfect");
  });

  it("is good between the perfect and good windows", () => {
    expect(judge(40.01, w)).toBe("good");
    expect(judge(-90, w)).toBe("good");
  });

  it("is a miss between the good and miss windows", () => {
    expect(judge(-90.5, w)).toBe("miss");
    expect(judge(140, w)).toBe("miss");
  });

  it("ignores presses outside every window", () => {
    expect(judge(140.01, w)).toBeNull();
    expect(judge(-500, w)).toBeNull();
  });

  it("uses sensible defaults", () => {
    expect(judge(DEFAULT_WINDOWS.perfectMs)).toBe("perfect");
    expect(judge(DEFAULT_WINDOWS.goodMs)).toBe("good");
  });

  it("rejects inconsistent windows", () => {
    expect(() => validateWindows({ perfectMs: 100, goodMs: 50, missMs: 150 })).toThrow(RangeError);
    expect(() => validateWindows({ perfectMs: 0, goodMs: 50, missMs: 150 })).toThrow(RangeError);
    expect(validateWindows(w)).toBe(w);
  });
});
