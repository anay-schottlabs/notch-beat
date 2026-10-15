import { describe, expect, it } from "vitest";
import type { Chart } from "./chart";
import { GameEngine, type GameEvent } from "./engine";
import { ManualClock } from "./timing/clock";
import { BeatSequence, BUSY_PATTERNS, CALM_PATTERNS, DEFAULT_SEQUENCE, EASY_PATTERNS, isPlayable, WARMUP_PATTERNS } from "./timing/beatSequence";
import type { Note } from "./types";

/** A fixed list of notes as a chart. */
function fixedChart(notes: Note[]): Chart {
  const queue = [...notes];
  return {
    kind: "practice",
    bpm: 120,
    take: (until) => queue.splice(0, queue.filter((n) => n.timeMs < until).length),
    beatsBetween: () => [],
    isDownbeat: () => false,
  };
}

function setup(notes: Note[]) {
  const clock = new ManualClock(0);
  const engine = new GameEngine({ clock, chart: fixedChart(notes) });
  const events: GameEvent[] = [];
  engine.on((e) => events.push(e));
  engine.start();
  const at = (t: number) => clock.set(t);
  const tails = () => events.filter((e) => e.type === "judgment" && e.part === "tail");
  return { clock, engine, events, at, tails };
}

const HOLD: Note = { id: 1, lane: "f", timeMs: 1000, durationMs: 800, kind: "hold" };

describe("held notes", () => {
  it("completes when released at the end", () => {
    const g = setup([HOLD]);
    g.at(1005);
    expect(g.engine.press("f")).toBe("perfect");
    expect(g.engine.isHolding("f")).toBe(true);
    g.at(1800);
    expect(g.engine.release("f")).toBe("perfect");
    expect(g.engine.isHolding("f")).toBe(false);
    // Head + tail, plus one tick per 100 ms of the 800 ms hold.
    expect(g.engine.getScore().combo).toBe(10);
    expect(g.tails()).toHaveLength(1);
  });

  it("builds the combo while held, a tick at a time", () => {
    const g = setup([HOLD]);
    g.at(1000);
    g.engine.press("f");
    g.at(1350);
    g.engine.update();
    expect(g.engine.getScore().combo).toBe(4); // head + 3 ticks
    expect(g.events.filter((e) => e.type === "holdTick")).toHaveLength(3);
    // Letting go early still breaks it.
    g.at(1400);
    g.engine.release("f");
    expect(g.engine.getScore().combo).toBe(0);
  });

  it("forgives a release just before the end", () => {
    const g = setup([HOLD]);
    g.at(1000);
    g.engine.press("f");
    g.at(1700);
    expect(g.engine.release("f")).toBe("perfect");
  });

  it("drops the hold and breaks combo when released early", () => {
    const g = setup([HOLD]);
    g.at(1000);
    g.engine.press("f");
    g.at(1300);
    expect(g.engine.release("f")).toBe("miss");
    expect(g.engine.getScore().combo).toBe(0);
    // The dropped note lingers greyed out, then goes.
    g.at(1300 + 10);
    g.engine.update();
    expect(g.engine.visibleNotes()[0]?.tailResult).toBe("miss");
    g.at(3000);
    g.engine.update();
    expect(g.engine.visibleNotes()).toHaveLength(0);
  });

  it("completes by itself if held past the end", () => {
    const g = setup([HOLD]);
    g.at(1000);
    g.engine.press("f");
    g.at(2000);
    g.engine.update();
    expect(g.tails()).toHaveLength(1);
    expect(g.engine.isHolding("f")).toBe(false);
    // The late key-up then does nothing.
    expect(g.engine.release("f")).toBeNull();
    expect(g.engine.getScore().combo).toBe(10);
  });

  it("misses the whole hold, once, when the head is missed", () => {
    const g = setup([HOLD]);
    g.at(1500);
    g.engine.update();
    const s = g.engine.getScore();
    expect(s.counts.miss).toBe(1);
    expect(g.tails()).toHaveLength(0);
    expect(g.engine.visibleNotes()[0]).toMatchObject({ result: "miss", tailResult: "miss" });
  });

  it("lets the other hand keep playing during a hold", () => {
    const g = setup([HOLD, { id: 2, lane: "j", timeMs: 1250 }, { id: 3, lane: "j", timeMs: 1500 }]);
    g.at(1000);
    g.engine.press("f");
    g.at(1250);
    expect(g.engine.press("j")).toBe("perfect");
    g.at(1500);
    expect(g.engine.press("j")).toBe("perfect");
    g.at(1800);
    expect(g.engine.release("f")).toBe("perfect");
    expect(g.engine.getScore().combo).toBe(12); // 4 notes + 8 hold ticks
  });

  it("ignores releases with nothing held", () => {
    const g = setup([{ id: 1, lane: "f", timeMs: 1000 }]);
    g.at(1000);
    g.engine.press("f");
    expect(g.engine.release("f")).toBeNull();
    expect(g.engine.release("j")).toBeNull();
  });

  it("counts an active hold as complete when the game pauses", () => {
    const g = setup([HOLD]);
    g.at(1000);
    g.engine.press("f");
    g.at(1200);
    g.engine.pause();
    expect(g.tails()).toHaveLength(1);
    expect(g.engine.isHolding("f")).toBe(false);
  });
});

describe("hold charts", () => {
  it("only uses playable patterns", () => {
    for (const p of [...WARMUP_PATTERNS, ...CALM_PATTERNS, ...EASY_PATTERNS, ...BUSY_PATTERNS]) expect(isPlayable(p)).toBe(true);
    // Sixteenth runs alternate lanes, so notes never overlap on one track.
    const lanes = (st: unknown) => (st === "both" ? ["f", "j"] : st === "f" || st === "j" ? [st] : []);
    for (const p of BUSY_PATTERNS.filter((p) => p.length === 16)) {
      for (let i = 1; i < 16; i++) expect(lanes(p[i]).some((l) => lanes(p[i - 1]).includes(l))).toBe(false);
    }
  });

  it("rejects overlapping or overrunning holds", () => {
    expect(isPlayable([{ hold: "f", steps: 3 }, null, "f", null, null, null, null, null])).toBe(false);
    expect(isPlayable([{ hold: "f", steps: 3 }, null, "both", null, null, null, null, null])).toBe(false);
    expect(isPlayable([null, null, null, null, null, { hold: "j", steps: 3 }, null, null])).toBe(false);
    expect(isPlayable([{ hold: "f", steps: 3 }, "j", "j", "j", "f", null, null, null])).toBe(true);
  });

  it("generates holds in the practice chart, never overlapping a note in the same lane", () => {
    const notes = new BeatSequence(DEFAULT_SEQUENCE).take(120_000);
    const holds = notes.filter((n) => n.durationMs);
    expect(holds.length).toBeGreaterThan(3);
    for (const h of holds) {
      const end = h.timeMs + h.durationMs!;
      expect(notes.some((n) => n !== h && n.lane === h.lane && n.timeMs >= h.timeMs && n.timeMs <= end)).toBe(false);
    }
  });
});

describe("drumrolls", () => {
  const ROLL: Note = { id: 9, lane: "f", timeMs: 1000, durationMs: 1000, kind: "roll" };

  it("counts every press, from either key, while the roll passes", () => {
    const g = setup([ROLL]);
    for (let t = 1000; t < 2000; t += 50) {
      g.at(t);
      expect(g.engine.press(t % 100 === 0 ? "f" : "j")).toBeNull();
    }
    const rolls = g.events.filter((e) => e.type === "roll");
    expect(rolls).toHaveLength(20);
    expect(rolls.at(-1)).toMatchObject({ type: "roll", hits: 20 });
  });

  it("never misses, and each hit adds to the combo", () => {
    const g = setup([{ id: 1, lane: "j", timeMs: 500 }, ROLL]);
    g.at(500);
    g.engine.press("j");
    g.at(1200);
    g.engine.press("f");
    g.at(3000);
    g.engine.update();
    const s = g.engine.getScore();
    expect(s.counts.miss).toBe(0);
    expect(s.combo).toBe(2); // the tap, then one roll hit
    expect(s.maxCombo).toBe(2);
    expect(g.engine.visibleNotes()).toHaveLength(0);
  });

  it("reports the active roll for rendering", () => {
    const g = setup([ROLL]);
    g.at(900);
    g.engine.update();
    expect(g.engine.activeRoll()).toBeUndefined();
    g.at(1500);
    expect(g.engine.activeRoll()?.id).toBe(9);
  });

  it("appears in practice charts, ending on a chord", () => {
    const notes = new BeatSequence(DEFAULT_SEQUENCE).take(120_000);
    const rolls = notes.filter((n) => n.kind === "roll");
    expect(rolls.length).toBeGreaterThan(0);
    for (const r of rolls) {
      const end = r.timeMs + r.durationMs!;
      expect(notes.some((n) => n !== r && n.timeMs >= r.timeMs && n.timeMs <= end)).toBe(false);
    }
  });
});

describe("restart (song changed mid-run)", () => {
  it("starts a fresh run on a new chart without passing through idle", () => {
    const g = setup([{ id: 1, lane: "f", timeMs: 1000 }]);
    g.at(1000);
    g.engine.press("f");
    const phases = () => g.events.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
    const before = phases().length;
    g.at(5000);
    g.engine.restart(fixedChart([{ id: 7, lane: "j", timeMs: 2000 }]));
    expect(g.engine.getPhase()).toBe("playing");
    expect(phases().slice(before)).not.toContain("idle");
    expect(g.engine.getScore().combo).toBe(0);
    expect(g.engine.songTime()).toBe(0);
    g.at(7000);
    expect(g.engine.press("j")).toBe("perfect");
  });
});

describe("stray presses (no spamming)", () => {
  const TAPS: Note[] = [
    { id: 1, lane: "f", timeMs: 1000 },
    { id: 2, lane: "j", timeMs: 1500 },
    { id: 3, lane: "f", timeMs: 3000 },
  ];

  it("resets the combo when a press hits nothing", () => {
    const g = setup(TAPS);
    g.at(1000);
    g.engine.press("f");
    g.at(1500);
    g.engine.press("j");
    expect(g.engine.getScore().combo).toBe(2);
    g.at(2200); // nothing near
    expect(g.engine.press("f")).toBeNull();
    expect(g.engine.getScore().combo).toBe(0);
    expect(g.events.some((e) => e.type === "stray")).toBe(true);
  });

  it("counts a press in the wrong lane as a stray", () => {
    const g = setup(TAPS);
    g.at(1000);
    g.engine.press("f");
    g.at(1500);
    g.engine.press("f"); // the note here is on J
    expect(g.engine.getScore().combo).toBe(0);
  });

  it("doesn't count as a missed note", () => {
    const g = setup(TAPS);
    g.at(1000);
    g.engine.press("f");
    g.at(1500);
    g.engine.press("j");
    g.at(2200);
    g.engine.press("j");
    expect(g.engine.getScore().counts).toEqual({ perfect: 2, good: 0, miss: 0 });
  });

  it("punishes a second tap on an already-hit note", () => {
    const g = setup(TAPS);
    g.at(1000);
    g.engine.press("f");
    g.at(1020);
    g.engine.press("f");
    expect(g.engine.getScore().combo).toBe(0);
  });

  it("lets you mash during a drumroll", () => {
    const g = setup([{ id: 1, lane: "j", timeMs: 500 }, { id: 9, lane: "f", timeMs: 1000, durationMs: 1000, kind: "roll" }]);
    g.at(500);
    g.engine.press("j");
    for (let t = 1000; t < 2000; t += 40) {
      g.at(t);
      g.engine.press(t % 80 ? "f" : "j");
    }
    expect(g.engine.getScore().combo).toBe(26); // the tap plus 25 roll hits
    expect(g.events.some((e) => e.type === "stray")).toBe(false);
  });

  it("has no effect while paused or before starting", () => {
    const clock = new ManualClock(0);
    const engine = new GameEngine({ clock, chart: fixedChart(TAPS) });
    const events: GameEvent[] = [];
    engine.on((e) => events.push(e));
    engine.press("f");
    expect(events.some((e) => e.type === "stray")).toBe(false);
  });
});
