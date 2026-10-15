import { type Clock, performanceClock } from "./timing/clock";
import type { Chart } from "./chart";
import { BeatSequence, DEFAULT_SEQUENCE } from "./timing/beatSequence";
import { DEFAULT_WINDOWS, judge, type TimingWindows, validateWindows } from "./scoring/judge";
import { applyJudgment, applyBonusHit, applyStray, INITIAL_SCORE, type ScoreState } from "./scoring/score";
import { isHold, isRoll, type Judgment, type Lane, type Note, type NotePart, noteEnd } from "./types";

export type GamePhase = "idle" | "playing" | "paused";
export type Cue = "drop" | "songEnd";

export type GameEvent =
  | { type: "press"; lane: Lane; songMs: number }
  | { type: "judgment"; lane: Lane; judgment: Judgment; deltaMs: number | null; noteId: number; part: NotePart }
  | { type: "release"; lane: Lane; songMs: number }
  /** A press that hit nothing while playing: it breaks the combo (no spamming). */
  | { type: "stray"; lane: Lane }
  /** A hit during a drumroll; `hits` counts this roll's hits so far. */
  | { type: "roll"; lane: Lane; hits: number; noteId: number }
  /** A held note kept down for another tick: +1 combo. */
  | { type: "holdTick"; lane: Lane; noteId: number }
  /** A musical moment for the visuals: a detected drop, or the song ending. */
  | { type: "cue"; cue: Cue }
  | { type: "phase"; phase: GamePhase };

export interface LiveNote extends Note {
  /** Set once the head is judged; missed notes stay visible briefly so the player sees them go. */
  result?: Judgment;
  /** Held notes: true from a successful head hit until release or completion. */
  holding?: boolean;
  /** Held notes: how the hold ended. */
  tailResult?: Judgment;
  /** Drumrolls: hits so far. */
  rollHits?: number;
  /** Held notes: combo ticks awarded so far. */
  holdTicks?: number;
}

export interface GameSnapshot {
  readonly phase: GamePhase;
  readonly score: ScoreState;
  readonly bpm: number;
  readonly chartKind: Chart["kind"];
}

export interface EngineOptions {
  clock?: Clock;
  /** Defaults to the deterministic practice chart. */
  chart?: Chart;
  windows?: TimingWindows;
  /** How far ahead of the hit zone notes become visible. */
  lookaheadMs?: number;
}

/** How long a missed note lingers past the hit zone for rendering. */
const MISS_LINGER_MS = 400;
/** Letting go of a hold this close to its end (or later) still completes it. */
const RELEASE_GRACE_MS = 150;
/** While a hold is kept down, the combo goes up by one this often. */
const HOLD_TICK_MS = 100;

/**
 * The rhythm game, independent of rendering. All timing is song time in ms,
 * derived from a monotonic clock and excluding paused intervals.
 */
export class GameEngine {
  readonly clock: Clock;
  readonly windows: TimingWindows;
  readonly lookaheadMs: number;
  private chart: Chart;

  private phase: GamePhase = "idle";
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private resumedAt = 0;

  private notes: LiveNote[] = [];
  private score: ScoreState = INITIAL_SCORE;
  private snapshot: GameSnapshot;
  private listeners = new Set<(e: GameEvent) => void>();
  private snapshotListeners = new Set<() => void>();

  constructor(options: EngineOptions = {}) {
    this.clock = options.clock ?? performanceClock;
    this.windows = validateWindows(options.windows ?? DEFAULT_WINDOWS);
    this.lookaheadMs = options.lookaheadMs ?? 1600;
    this.chart = options.chart ?? new BeatSequence(DEFAULT_SEQUENCE);
    this.snapshot = this.makeSnapshot();
  }

  // ---- Lifecycle ----

  getPhase(): GamePhase {
    return this.phase;
  }

  get bpm(): number {
    return this.chart.bpm;
  }

  get chartKind(): Chart["kind"] {
    return this.chart.kind;
  }

  isDownbeat(beatMs: number): boolean {
    return this.chart.isDownbeat(beatMs);
  }

  start(): void {
    if (this.phase !== "idle") return;
    this.startedAt = this.clock.now();
    this.resumedAt = this.startedAt;
    this.pausedTotal = 0;
    this.setPhase("playing");
  }

  pause(): void {
    if (this.phase !== "playing") return;
    // Keys can't stay down through a pause (focus is usually lost), so be generous: count active holds as done.
    for (const n of this.notes) {
      if (!n.holding) continue;
      this.tickHold(n, noteEnd(n));
      this.endHold(n, "perfect", null);
    }
    this.pausedAt = this.clock.now();
    this.setPhase("paused");
  }

  resume(): void {
    if (this.phase !== "paused") return;
    this.resumedAt = this.clock.now();
    this.pausedTotal += this.resumedAt - this.pausedAt;
    if (this.chart.resync) {
      // The music didn't pause: drop upcoming notes and let the chart re-anchor.
      const song = this.songTime();
      this.notes = this.notes.filter((n) => n.result || n.timeMs <= song);
      this.chart.resync(song);
    }
    this.setPhase("playing");
  }

  /** Start, pause or resume, depending on the current phase. */
  toggle(): void {
    if (this.phase === "idle") this.start();
    else if (this.phase === "playing") this.pause();
    else this.resume();
  }

  /**
   * Start a fresh run on a new chart without leaving the playing state (used when
   * the song changes mid-game, so end-of-song effects aren't cut off by an idle screen).
   */
  restart(chart: Chart): void {
    this.chart = chart;
    this.notes = [];
    this.score = INITIAL_SCORE;
    this.startedAt = this.clock.now();
    this.resumedAt = this.startedAt;
    this.pausedTotal = 0;
    if (this.phase !== "playing") this.setPhase("playing");
    else this.publish();
  }

  /** Back to idle with a clean score. Pass a chart to change what the next session plays. */
  reset(chart?: Chart): void {
    this.chart = chart ?? (this.chart.kind === "practice" ? new BeatSequence((this.chart as BeatSequence).config) : this.chart);
    this.notes = [];
    this.score = INITIAL_SCORE;
    this.setPhase("idle");
  }

  // ---- Time ----

  /** Song time at a clock reading (defaults to now). Frozen while paused. */
  songTime(atClockMs: number = this.clock.now()): number {
    switch (this.phase) {
      case "idle":
        return 0;
      case "paused":
        return this.pausedAt - this.startedAt - this.pausedTotal;
      case "playing":
        return atClockMs - this.startedAt - this.pausedTotal;
    }
  }

  /** Position within the current beat (0 on the beat, toward 1 just before the next), or null before the first beat. */
  beatPhase(songMs: number = this.songTime()): number | null {
    const interval = 60000 / this.chart.bpm;
    const last = this.chart.beatsBetween(songMs - interval * 1.5, songMs + 1e-6).at(-1);
    if (last === undefined) return null;
    return Math.min((songMs - last) / interval, 0.999);
  }

  beatsBetween(fromMs: number, toMs: number): number[] {
    return this.chart.beatsBetween(fromMs, toMs);
  }

  // ---- Simulation ----

  /** Advance to `songMs`: pull upcoming notes in, miss anything past the good window, drop stale notes. */
  update(songMs: number = this.songTime()): void {
    if (this.phase !== "playing") return;
    // Copy: live state (result, holding) belongs to the engine, not the chart.
    for (const n of this.chart.take(songMs + this.lookaheadMs)) this.notes.push({ ...n });
    let ticked = false;
    for (const note of this.notes) {
      if (note.holding) ticked = this.tickHold(note, songMs) || ticked;
      if (!note.result && !isRoll(note) && songMs - note.timeMs > this.windows.goodMs) {
        note.result = "miss";
        if (isHold(note)) note.tailResult = "miss"; // a missed head loses the whole hold
        this.record(note, "miss", null, "head");
      }
      // Held all the way through: complete it without waiting for the release.
      if (note.holding && songMs >= noteEnd(note)) this.endHold(note, "perfect", songMs - noteEnd(note));
    }
    if (ticked) this.publish();
    this.notes = this.notes.filter((n) => {
      if (isRoll(n)) return songMs < noteEnd(n) + 150;
      if (n.result === undefined || n.holding) return true;
      if (n.result === "miss" || n.tailResult === "miss") return songMs - noteEnd(n) < MISS_LINGER_MS;
      return false;
    });
  }

  /** Keeping a hold down builds the combo: +1 for every HOLD_TICK_MS held, up to `songMs`. */
  private tickHold(note: LiveNote, songMs: number): boolean {
    const due = Math.floor((Math.min(songMs, noteEnd(note)) - note.timeMs) / HOLD_TICK_MS);
    let ticked = false;
    while ((note.holdTicks ?? 0) < due) {
      note.holdTicks = (note.holdTicks ?? 0) + 1;
      this.score = applyBonusHit(this.score);
      this.emit({ type: "holdTick", lane: note.lane, noteId: note.id });
      ticked = true;
    }
    return ticked;
  }

  /**
   * Register a press. `atClockMs` should be the input event's own timestamp
   * (same time origin as performance.now()), not the time it was handled.
   * Returns the judgment, or null if the press didn't land near any note.
   */
  press(lane: Lane, atClockMs: number = this.clock.now()): Judgment | null {
    if (this.phase !== "playing") {
      this.emit({ type: "press", lane, songMs: this.songTime() });
      return null;
    }
    // Clamp into [last resume, now]: an event stamped before the resume would land inside the pause.
    const now = this.clock.now();
    const songMs = this.songTime(Math.min(Math.max(atClockMs, this.resumedAt), now));
    this.update(songMs);
    this.emit({ type: "press", lane, songMs });

    // During a drumroll every press (either key) is a roll hit: each adds to the combo. Rolls never miss.
    const roll = this.notes.find((n) => isRoll(n) && songMs >= n.timeMs - this.windows.goodMs && songMs <= noteEnd(n) + 60);
    if (roll) {
      roll.rollHits = (roll.rollHits ?? 0) + 1;
      this.score = applyBonusHit(this.score);
      this.emit({ type: "roll", lane, hits: roll.rollHits, noteId: roll.id });
      this.publish();
      return null;
    }

    let best: LiveNote | undefined;
    for (const note of this.notes) {
      if (note.lane !== lane || note.result || isRoll(note)) continue;
      const d = Math.abs(songMs - note.timeMs);
      if (d <= this.windows.missMs && (!best || d < Math.abs(songMs - best.timeMs))) best = note;
    }
    if (!best) return this.stray(lane);

    const delta = songMs - best.timeMs;
    const judgment = judge(delta, this.windows);
    if (!judgment) return this.stray(lane);
    best.result = judgment;
    if (isHold(best) && judgment !== "miss") best.holding = true;
    else if (isHold(best)) best.tailResult = "miss";
    this.record(best, judgment, delta, "head");
    if (judgment !== "miss" && !best.holding) this.notes = this.notes.filter((n) => n !== best);
    return judgment;
  }

  /**
   * Register a key/button release. Ends an active hold in that lane: on time
   * (or late) completes it, early drops it. Returns the tail judgment, if any.
   */
  release(lane: Lane, atClockMs: number = this.clock.now()): Judgment | null {
    if (this.phase !== "playing") return null;
    const now = this.clock.now();
    const songMs = this.songTime(Math.min(Math.max(atClockMs, this.resumedAt), now));
    this.emit({ type: "release", lane, songMs });
    // Resolve before update(), which would otherwise auto-complete a hold whose end has just arrived.
    const note = this.notes.find((n) => n.lane === lane && n.holding);
    let judgment: Judgment | null = null;
    if (note) {
      const late = songMs - noteEnd(note);
      judgment = late >= -RELEASE_GRACE_MS ? "perfect" : "miss";
      // A completed hold earns every tick, even if released inside the grace window.
      if (judgment === "perfect") this.tickHold(note, noteEnd(note));
      this.endHold(note, judgment, judgment === "miss" ? null : late);
    }
    this.update(songMs);
    return judgment;
  }

  /** Pressing with nothing to hit resets the combo, so mashing doesn't pay. */
  private stray(lane: Lane): null {
    const before = this.score;
    this.score = applyStray(this.score);
    this.emit({ type: "stray", lane });
    if (this.score !== before) this.publish();
    return null;
  }

  /** Signal a musical moment (drop, song end) to whatever's rendering. */
  cue(cue: Cue): void {
    this.emit({ type: "cue", cue });
  }

  /** The drumroll under the target right now, if any. */
  activeRoll(songMs: number = this.songTime()): LiveNote | undefined {
    return this.notes.find((n) => isRoll(n) && songMs >= n.timeMs && songMs <= noteEnd(n));
  }

  /** True while a hold in this lane is being held. */
  isHolding(lane: Lane): boolean {
    return this.notes.some((n) => n.lane === lane && n.holding);
  }

  private endHold(note: LiveNote, judgment: Judgment, deltaMs: number | null): void {
    note.holding = false;
    note.tailResult = judgment;
    this.record(note, judgment, deltaMs, "tail");
  }

  /** Notes to draw: everything still live, including briefly lingering misses. */
  visibleNotes(): readonly LiveNote[] {
    return this.notes;
  }

  // ---- Observation ----

  getScore(): ScoreState {
    return this.score;
  }

  /** Stable snapshot for useSyncExternalStore; replaced only when something changes. */
  getSnapshot = (): GameSnapshot => this.snapshot;

  subscribeSnapshot = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  on(listener: (e: GameEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(note: Note, judgment: Judgment, deltaMs: number | null, part: NotePart): void {
    this.score = applyJudgment(this.score, judgment, deltaMs);
    this.emit({ type: "judgment", lane: note.lane, judgment, deltaMs, noteId: note.id, part });
    this.publish();
  }

  private setPhase(phase: GamePhase): void {
    if (phase === this.phase && phase !== "idle") return;
    this.phase = phase;
    this.emit({ type: "phase", phase });
    this.publish();
  }

  private makeSnapshot(): GameSnapshot {
    return { phase: this.phase, score: this.score, bpm: Math.round(this.chart.bpm), chartKind: this.chart.kind };
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot();
    for (const l of this.snapshotListeners) l();
  }

  private emit(e: GameEvent): void {
    for (const l of this.listeners) l(e);
  }
}
