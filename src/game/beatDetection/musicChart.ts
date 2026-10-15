import type { BeatEstimate } from "../../services/audio/types";
import type { Chart } from "../chart";
import {
  beatIntervalMs,
  DEFAULT_SEQUENCE,
  type Intensity,
  notesForBar,
  patternForBar,
  ROLL_PATTERN,
  type SequenceConfig,
} from "../timing/beatSequence";
import type { Note } from "../types";
import { BPM_RANGE, MIN_CONFIDENCE } from "./chartSource";
import { applyDrums, DrumGroove, nextIntensity, wantsRoll } from "./musicShaping";

export interface MusicChartOptions {
  /** Latest beat estimate (phaseMs on the performance.now() clock), or null. */
  estimate: () => BeatEstimate | null;
  /** Convert a clock time to song time (the engine's mapping). */
  clockToSong: (clockMs: number) => number;
  /** User calibration: positive moves notes later. */
  offsetMs?: () => number;
  /** Patterns reuse the practice generator; this sets seed and warmup. */
  sequence?: SequenceConfig;
  minConfidence?: number;
  /** Earliest song time for the first note, so the player can get ready. */
  leadInMs?: number;
  /** The song's current energy and build-up (0..1), when listening. */
  section?: () => { energy: number; buildup: number } | null;
  /** Clock times of recent bass hits, in "heard" time like beat estimates. */
  kicks?: () => readonly number[];
  /** Clock times of recent snare/clap hits, in the same time base. */
  snares?: () => readonly number[];
  /** Current clock time (defaults to performance.now()). */
  now?: () => number;
}

/**
 * Notes on the song's estimated beat grid. Notes are fixed once they enter the
 * lookahead window, so each new bar snaps to the current estimate: tempo drift
 * is corrected bar by bar without moving notes the player can already see.
 * Bars generated while the estimate is unreliable are rests, not guesses.
 *
 * It also follows the song: density tracks section energy, a build-up brings a
 * drumroll, and the song's kick and snare pattern decides which lane each beat goes to.
 */
export class MusicChart implements Chart {
  readonly kind = "music";
  private interval: number;
  private nextBar: number | null = null;
  private minStart: number;
  private barIndex = 0;
  private buffer: Note[] = [];
  private beats: number[] = [];
  private barStarts = new Set<number>();
  private sequence: SequenceConfig;
  private minConfidence: number;
  private intensity: Intensity = "normal";
  private lastRollBar = -100;
  private kickGroove = new DrumGroove();
  private snareGroove = new DrumGroove();

  constructor(private options: MusicChartOptions, initialBpm: number) {
    this.interval = beatIntervalMs(initialBpm);
    this.sequence = options.sequence ?? DEFAULT_SEQUENCE;
    this.minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
    this.minStart = options.leadInMs ?? 2000;
  }

  get bpm(): number {
    return 60000 / this.interval;
  }

  take(untilMs: number): Note[] {
    while (this.nextBar === null || this.nextBar < untilMs) this.generateBar();
    let n = 0;
    while (n < this.buffer.length && this.buffer[n].timeMs < untilMs) n++;
    return this.buffer.splice(0, n);
  }

  beatsBetween(fromMs: number, toMs: number): number[] {
    return this.beats.filter((b) => b >= fromMs && b < toMs);
  }

  isDownbeat(beatMs: number): boolean {
    return this.barStarts.has(beatMs);
  }

  resync(songMs: number): void {
    this.nextBar = null;
    this.minStart = songMs + 1200;
    this.buffer = [];
    this.beats = this.beats.filter((b) => b <= songMs);
  }

  /** Pick this bar's pattern from the song's energy, build-up and groove. */
  private shapeBar() {
    const section = this.options.section?.() ?? null;
    if (section) {
      this.intensity = nextIntensity(this.intensity, section.energy);
      if (wantsRoll(section.buildup, section.energy, this.barIndex - this.lastRollBar)) {
        this.lastRollBar = this.barIndex;
        return ROLL_PATTERN;
      }
    }
    const pattern = patternForBar(this.sequence, this.barIndex, section ? this.intensity : undefined);
    const toSong = (hits: readonly number[]) => hits.map((k) => this.options.clockToSong(k) + (this.options.offsetMs?.() ?? 0));
    const songNow = this.options.clockToSong((this.options.now ?? (() => performance.now()))());
    this.kickGroove.addHits(toSong(this.options.kicks?.() ?? []));
    this.snareGroove.addHits(toSong(this.options.snares?.() ?? []));
    this.kickGroove.settle(songNow);
    this.snareGroove.settle(songNow);
    return applyDrums(pattern, { kick: this.kickGroove.steps(), snare: this.snareGroove.steps() }, {
      intensity: section ? this.intensity : "normal",
      barInPhrase: this.barIndex % 4,
      phrase: Math.floor(this.barIndex / 4),
    });
  }

  private reliable(est: BeatEstimate | null): est is BeatEstimate {
    return !!est && est.confidence >= this.minConfidence && est.bpm >= BPM_RANGE.min && est.bpm <= BPM_RANGE.max;
  }

  private generateBar(): void {
    const est = this.options.estimate();
    const confident = this.reliable(est);
    if (confident) {
      this.interval = beatIntervalMs(est.bpm);
      const anchor = this.options.clockToSong(est.phaseMs) + (this.options.offsetMs?.() ?? 0);
      if (this.nextBar === null) {
        this.nextBar = anchor + Math.ceil((this.minStart - anchor) / this.interval) * this.interval;
      } else {
        const snapped = anchor + Math.round((this.nextBar - anchor) / this.interval) * this.interval;
        if (Math.abs(snapped - this.nextBar) < this.interval / 2) this.nextBar = snapped;
      }
    } else if (this.nextBar === null) {
      this.nextBar = this.minStart;
    }

    const start = this.nextBar;
    this.barStarts.add(start);
    for (let i = 0; i < 4; i++) this.beats.push(start + i * this.interval);
    if (this.beats.length > 64) {
      this.beats.splice(0, this.beats.length - 64);
      for (const b of this.barStarts) if (b < this.beats[0]) this.barStarts.delete(b);
    }

    const stepMs = this.interval / 2;
    this.kickGroove.addBar(this.barIndex, start, stepMs);
    this.snareGroove.addBar(this.barIndex, start, stepMs);
    if (confident) this.buffer.push(...notesForBar(this.shapeBar(), this.barIndex, start, stepMs));
    this.barIndex++;
    this.nextBar = start + 4 * this.interval;
  }
}
