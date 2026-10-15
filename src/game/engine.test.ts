import { beforeEach, describe, expect, it } from "vitest";
import { GameEngine, type GameEvent } from "./engine";
import { ManualClock } from "./timing/clock";
import { BeatSequence, DEFAULT_SEQUENCE } from "./timing/beatSequence";
import type { Note } from "./types";

const SEQ = { ...DEFAULT_SEQUENCE, bpm: 120, leadInMs: 1000 };
const T0 = 10_000; // arbitrary clock origin, to catch clock-vs-song-time mixups

function setup() {
  const clock = new ManualClock(T0);
  const engine = new GameEngine({ clock, chart: new BeatSequence(SEQ) });
  const events: GameEvent[] = [];
  engine.on((e) => events.push(e));
  const chart = new BeatSequence(SEQ).take(60_000);
  return { clock, engine, events, chart };
}

/** Move the clock to a song time while playing and press. */
function pressAt(ctx: ReturnType<typeof setup>, note: Note, deltaMs: number, lane = note.lane) {
  ctx.clock.set(T0 + note.timeMs + deltaMs);
  return ctx.engine.press(lane);
}

describe("GameEngine", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("starts idle and only judges while playing", () => {
    expect(ctx.engine.getPhase()).toBe("idle");
    expect(ctx.engine.press("f")).toBeNull();
    expect(ctx.engine.getScore().counts).toEqual({ perfect: 0, good: 0, miss: 0 });
    // Presses still produce visual feedback events.
    expect(ctx.events.some((e) => e.type === "press")).toBe(true);
  });

  it("judges perfect, good and early-miss presses against the chart", () => {
    ctx.engine.start();
    const [a, b, c] = ctx.chart;
    expect(pressAt(ctx, a, 10)).toBe("perfect");
    expect(pressAt(ctx, b, -70)).toBe("good");
    expect(pressAt(ctx, c, -105)).toBe("miss");
    const s = ctx.engine.getScore();
    expect(s.counts).toEqual({ perfect: 1, good: 1, miss: 1 });
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(2);
  });

  it("ignores presses in the wrong lane or far from any note", () => {
    ctx.engine.start();
    // A single note (no chord partner at the same time), with no other note nearby.
    const a = ctx.chart.find((n, i, all) => all.every((m, j) => j === i || Math.abs(m.timeMs - n.timeMs) > 200))!;
    ctx.clock.set(T0 + a.timeMs - 1000);
    ctx.engine.update();
    const other = a.lane === "f" ? "j" : "f";
    expect(pressAt(ctx, a, 0, other)).toBeNull();
    ctx.clock.set(T0 + 100); // during lead-in
    expect(ctx.engine.press("f")).toBeNull();
    expect(ctx.engine.getScore().combo).toBe(0);
  });

  it("lets both halves of a chord be hit at the same moment", () => {
    ctx.engine.start();
    const chordTime = ctx.chart.find((n, i, all) => all.some((m, j) => j !== i && m.timeMs === n.timeMs))!.timeMs;
    ctx.clock.set(T0 + chordTime + 3);
    expect(ctx.engine.press("f")).toBe("perfect");
    expect(ctx.engine.press("j")).toBe("perfect");
    expect(ctx.engine.getScore().combo).toBe(2);
  });

  it("misses the other half of a chord if only one lane is hit", () => {
    ctx.engine.start();
    const chordTime = ctx.chart.find((n, i, all) => all.some((m, j) => j !== i && m.timeMs === n.timeMs))!.timeMs;
    const before = ctx.chart.filter((n) => n.timeMs < chordTime).length;
    for (const n of ctx.chart.filter((n) => n.timeMs < chordTime)) {
      ctx.clock.set(T0 + n.timeMs);
      ctx.engine.press(n.lane);
    }
    ctx.clock.set(T0 + chordTime);
    expect(ctx.engine.press("f")).toBe("perfect");
    ctx.clock.set(T0 + chordTime + ctx.engine.windows.goodMs + 1);
    ctx.engine.update();
    const s = ctx.engine.getScore();
    expect(s.counts.perfect).toBe(before + 1);
    expect(s.counts.miss).toBe(1);
    expect(s.combo).toBe(0);
  });

  it("can't score the same note twice", () => {
    ctx.engine.start();
    const [a] = ctx.chart;
    expect(pressAt(ctx, a, 0)).toBe("perfect");
    // At 120bpm the next note is >= 250ms away, outside every window, so this hits nothing.
    expect(pressAt(ctx, a, 5)).toBeNull();
    expect(ctx.engine.getScore().counts.perfect).toBe(1);
  });

  it("misses notes that pass the good window unhit and breaks combo", () => {
    ctx.engine.start();
    const [a, b] = ctx.chart;
    pressAt(ctx, a, 0);
    expect(ctx.engine.getScore().combo).toBe(1);
    ctx.clock.set(T0 + b.timeMs + ctx.engine.windows.goodMs + 1);
    ctx.engine.update();
    const s = ctx.engine.getScore();
    expect(s.counts.miss).toBe(1);
    expect(s.combo).toBe(0);
    expect(ctx.events.filter((e) => e.type === "judgment" && e.judgment === "miss")).toHaveLength(1);
  });

  it("misses every skipped note exactly once", () => {
    ctx.engine.start();
    const until = 8000;
    ctx.clock.set(T0 + until);
    ctx.engine.update();
    ctx.engine.update();
    const expected = ctx.chart.filter((n) => n.timeMs + ctx.engine.windows.goodMs < until).length;
    expect(ctx.engine.getScore().counts.miss).toBe(expected);
  });

  it("freezes song time while paused and excludes the pause on resume", () => {
    ctx.engine.start();
    ctx.clock.advance(1500);
    ctx.engine.pause();
    expect(ctx.engine.songTime()).toBe(1500);
    ctx.clock.advance(5000);
    expect(ctx.engine.songTime()).toBe(1500);
    expect(ctx.engine.press("f")).toBeNull();
    ctx.engine.resume();
    ctx.clock.advance(250);
    expect(ctx.engine.songTime()).toBe(1750);
    // Nothing was auto-missed during the pause.
    expect(ctx.engine.getScore().counts.miss).toBe(0);
  });

  it("uses the input event timestamp, not handling time", () => {
    ctx.engine.start();
    const [a] = ctx.chart;
    ctx.clock.set(T0 + a.timeMs + 80); // handled late...
    expect(ctx.engine.press(a.lane, T0 + a.timeMs + 5)).toBe("perfect"); // ...but pressed on time
  });

  it("clamps timestamps from before a resume into the playing interval", () => {
    ctx.engine.start();
    ctx.clock.advance(500);
    ctx.engine.pause();
    ctx.clock.advance(10_000);
    ctx.engine.resume();
    const resumeSong = ctx.engine.songTime();
    expect(() => ctx.engine.press("f", T0)).not.toThrow();
    const press = ctx.events.filter((e) => e.type === "press").at(-1);
    expect(press && press.type === "press" && press.songMs).toBe(resumeSong);
  });

  it("resets the session to a clean idle state", () => {
    ctx.engine.start();
    pressAt(ctx, ctx.chart[0], 0);
    ctx.engine.reset();
    expect(ctx.engine.getPhase()).toBe("idle");
    expect(ctx.engine.getScore().score).toBe(0);
    expect(ctx.engine.visibleNotes()).toHaveLength(0);
    // The chart restarts from the beginning.
    ctx.clock.set(T0 + 50_000);
    ctx.engine.start();
    ctx.clock.set(T0 + 50_000 + ctx.chart[0].timeMs);
    expect(ctx.engine.press(ctx.chart[0].lane)).toBe("perfect");
  });

  it("publishes a new snapshot only on change", () => {
    const first = ctx.engine.getSnapshot();
    expect(ctx.engine.getSnapshot()).toBe(first);
    ctx.engine.start();
    const playing = ctx.engine.getSnapshot();
    expect(playing).not.toBe(first);
    expect(playing.phase).toBe("playing");
    ctx.clock.advance(10);
    ctx.engine.update();
    expect(ctx.engine.getSnapshot()).toBe(playing);
  });

  it("toggles through start, pause and resume", () => {
    ctx.engine.toggle();
    expect(ctx.engine.getPhase()).toBe("playing");
    ctx.engine.toggle();
    expect(ctx.engine.getPhase()).toBe("paused");
    ctx.engine.toggle();
    expect(ctx.engine.getPhase()).toBe("playing");
  });

  it("reports beat phase after the lead-in only", () => {
    expect(ctx.engine.beatPhase(500)).toBeNull();
    expect(ctx.engine.beatPhase(1000)).toBe(0);
    expect(ctx.engine.beatPhase(1250)).toBeCloseTo(0.5);
  });
});
