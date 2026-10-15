import type { Judgment } from "../types";

export const BASE_POINTS: Readonly<Record<Judgment, number>> = {
  perfect: 300,
  good: 100,
  miss: 0,
};

export interface ScoreState {
  readonly score: number;
  readonly combo: number;
  readonly maxCombo: number;
  readonly counts: Readonly<Record<Judgment, number>>;
  readonly last: { readonly judgment: Judgment; readonly deltaMs: number | null; readonly seq: number } | null;
}

export const INITIAL_SCORE: ScoreState = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  counts: { perfect: 0, good: 0, miss: 0 },
  last: null,
};

/** +10% for every 10 combo already held, capped at 2x. */
export function comboMultiplier(combo: number): number {
  return 1 + Math.min(Math.floor(combo / 10), 10) * 0.1;
}

/** Pure reducer. `deltaMs` is null for notes that passed unhit. */
export function applyJudgment(state: ScoreState, judgment: Judgment, deltaMs: number | null): ScoreState {
  const hit = judgment !== "miss";
  const points = hit ? Math.round(BASE_POINTS[judgment] * comboMultiplier(state.combo)) : 0;
  const combo = hit ? state.combo + 1 : 0;
  return {
    score: state.score + points,
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
    counts: { ...state.counts, [judgment]: state.counts[judgment] + 1 },
    last: { judgment, deltaMs, seq: (state.last?.seq ?? 0) + 1 },
  };
}

/** Points for each drumroll hit or hold tick (before the combo multiplier). */
export const BONUS_POINTS = 50;

/** A drumroll hit or a hold tick: one more combo and a few points, without counting as a judged note. */
export function applyBonusHit(state: ScoreState): ScoreState {
  const combo = state.combo + 1;
  return {
    ...state,
    score: state.score + Math.round(BONUS_POINTS * comboMultiplier(state.combo)),
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
  };
}

/** A press that hit nothing: no note was missed, but the combo is over. */
export function applyStray(state: ScoreState): ScoreState {
  return state.combo === 0 ? state : { ...state, combo: 0 };
}

/** 0..1, where a good is worth half a perfect. Null before any note is judged. */
export function accuracy(state: ScoreState): number | null {
  const { perfect, good, miss } = state.counts;
  const total = perfect + good + miss;
  return total === 0 ? null : (perfect + good * 0.5) / total;
}
