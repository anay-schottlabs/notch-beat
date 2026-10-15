/**
 * How hot the visuals run for a combo: 0 with no combo, about 0.3 at 10, 0.5 at
 * 25, 0.7 at 50 and 1 from about 120. Only visuals scale with it, never sound.
 */
export function comboHeat(combo: number): number {
  return combo <= 0 ? 0 : Math.min(1, Math.log2(1 + combo / 8) / 4);
}

/** Combo tiers: each one changes the look (colour of the combo drum, rings, aura). */
export function comboTier(combo: number): 0 | 1 | 2 | 3 | 4 {
  return combo >= 100 ? 4 : combo >= 50 ? 3 : combo >= 25 ? 2 : combo >= 10 ? 1 : 0;
}
