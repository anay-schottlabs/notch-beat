import { describe, expect, it } from "vitest";
import { BUSY_PATTERNS, CALM_PATTERNS, EASY_PATTERNS, ROLL_PATTERN, isPlayable, type Step } from "../timing/beatSequence";
import { MusicChart } from "./musicChart";
import { applyDrums, DrumGroove, nextIntensity, wantsRoll } from "./musicShaping";

describe("energy → intensity", () => {
  it("moves between pools with hysteresis", () => {
    expect(nextIntensity("normal", 0.5)).toBe("normal");
    expect(nextIntensity("normal", 0.8)).toBe("busy");
    expect(nextIntensity("busy", 0.65)).toBe("busy"); // doesn't flicker back down
    expect(nextIntensity("busy", 0.4)).toBe("normal");
    expect(nextIntensity("normal", 0.1)).toBe("calm");
    expect(nextIntensity("calm", 0.2)).toBe("calm");
    expect(nextIntensity("calm", 0.9)).toBe("busy");
  });

  it("asks for a roll on a real build-up only, and not too often", () => {
    expect(wantsRoll(0.8, 0.5, 10)).toBe(true);
    expect(wantsRoll(0.3, 0.5, 10)).toBe(false);
    expect(wantsRoll(0.8, 0.95, 10)).toBe(false); // already peaked
    expect(wantsRoll(0.8, 0.5, 2)).toBe(false);
  });
});

describe("DrumGroove", () => {
  it("learns steps where kicks keep landing", () => {
    const g = new DrumGroove();
    const step = 250;
    for (let bar = 0; bar < 6; bar++) {
      const start = bar * 8 * step;
      g.addBar(bar, start, step);
      g.addHits([start + 3, start + 4 * step - 10]); // beats 1 and 3, slightly off
    }
    g.settle(6 * 8 * step);
    expect(g.steps()).toEqual([0, 4]);
  });

  it("ignores one-off hits", () => {
    const g = new DrumGroove();
    for (let bar = 0; bar < 6; bar++) g.addBar(bar, bar * 2000, 250);
    g.addHits([2 * 2000 + 750]);
    g.settle(12_000);
    expect(g.steps()).toEqual([]);
  });

  it("doesn't fold bars that haven't finished playing", () => {
    const g = new DrumGroove();
    g.addBar(0, 0, 250);
    g.addHits([0]);
    g.settle(1000);
    expect(g.steps(0.3)).toEqual([]);
    g.settle(2000);
    expect(g.steps(0.3)).toEqual([0]);
  });
});

describe("applyDrums", () => {
  const backbeat = { kick: [0, 4], snare: [2, 6] };
  const lanes = (p: readonly Step[]) => p.map((s) => (s === "both" ? "B" : typeof s === "string" ? s : s ? "o" : "."));

  it("puts the kick on F and the snare on J", () => {
    const out = applyDrums([null, null, null, null, null, null, null, null], backbeat, { intensity: "normal", barInPhrase: 1, phrase: 0 });
    expect(lanes(out).join("")).toBe("f.j.f.j.");
  });

  it("alternates kick and snare under a four-on-the-floor clap instead of chording every beat", () => {
    const floor = { kick: [0, 2, 4, 6], snare: [2, 6] };
    const out = applyDrums(["both", null, "both", null, "both", null, "both", null], floor, { intensity: "normal", barInPhrase: 1, phrase: 0 });
    expect(out.filter((s) => s === "both")).toHaveLength(0);
    expect(lanes(out).join("")).toBe("f.j.f.j.");
  });

  it("keeps chords for the phrase's opening accent only", () => {
    for (const pattern of [...EASY_PATTERNS, ...BUSY_PATTERNS]) {
      for (let bar = 0; bar < 4; bar++) {
        const out = applyDrums(pattern, backbeat, { intensity: "normal", barInPhrase: bar, phrase: 0 });
        const chords = out.flatMap((s, i) => (s === "both" ? [i] : []));
        expect(chords).toEqual(bar === 0 && typeof out[0] === "string" ? [0] : []);
      }
    }
  });

  it("plays only the drums in calm sections", () => {
    const out = applyDrums(["f", "j", "f", "j", "f", "j", "f", "j"], backbeat, { intensity: "calm", barInPhrase: 0, phrase: 0 });
    expect(lanes(out).join("")).toBe("f.j.f.j.");
  });

  it("ends a busy phrase with a sixteenth fill", () => {
    const out = applyDrums(["f", null, "j", null, "f", null, "j", null], backbeat, { intensity: "busy", barInPhrase: 3, phrase: 0 });
    expect(out).toHaveLength(16);
    expect(out.slice(8).filter(Boolean).length).toBeGreaterThanOrEqual(5);
  });

  it("stays playable, never stacks one lane on adjacent sixteenths, and leaves rolls alone", () => {
    const one = (s: Step) => (s === "both" ? ["f", "j"] : typeof s === "string" ? [s] : []);
    for (const pattern of [...CALM_PATTERNS, ...EASY_PATTERNS, ...BUSY_PATTERNS]) {
      for (const intensity of ["calm", "normal", "busy"] as const) {
        for (let bar = 0; bar < 4; bar++) {
          const out = applyDrums(pattern, { kick: [0, 3, 4], snare: [2, 6] }, { intensity, barInPhrase: bar, phrase: bar });
          expect(isPlayable(out)).toBe(true);
          if (out.length === 16) for (let i = 1; i < 16; i++) expect(one(out[i]).some((l) => one(out[i - 1]).includes(l))).toBe(false);
        }
      }
    }
    expect(applyDrums(ROLL_PATTERN, backbeat, { intensity: "busy", barInPhrase: 0, phrase: 0 })).toEqual([...ROLL_PATTERN]);
  });
});

describe("MusicChart follows the song", () => {
  const est = { bpm: 120, phaseMs: 0, confidence: 0.9 };
  const chart = (section: { energy: number; buildup: number }, kicks: number[] = []) =>
    new MusicChart({ estimate: () => est, clockToSong: (c) => c, section: () => section, kicks: () => kicks, now: () => 60_000 }, 120);
  const density = (c: MusicChart) => c.take(40_000).length;

  it("writes busier charts for louder sections", () => {
    const quiet = density(chart({ energy: 0.1, buildup: 0 }));
    const loud = density(chart({ energy: 0.95, buildup: 0 }));
    expect(loud).toBeGreaterThan(quiet * 1.5);
  });

  it("puts a drumroll into a build-up", () => {
    const notes = chart({ energy: 0.5, buildup: 0.9 }).take(20_000);
    expect(notes.some((n) => n.kind === "roll")).toBe(true);
  });

  it("follows the song's kick and snare", () => {
    // Kicks on beats 1 and 3, snares on 2 and 4 (bars start at 2000 + 2000k), heard as time passes.
    const kicks: number[] = [];
    const snares: number[] = [];
    for (let t = 2000; t < 40_000; t += 1000) {
      kicks.push(t);
      snares.push(t + 500);
    }
    let now = 0;
    const c = new MusicChart(
      {
        estimate: () => est,
        clockToSong: (t) => t,
        section: () => ({ energy: 0.1, buildup: 0 }),
        kicks: () => kicks.filter((k) => k <= now),
        snares: () => snares.filter((k) => k <= now),
        now: () => now,
      },
      120,
    );
    const notes = [];
    for (now = 0; now <= 40_000; now += 250) notes.push(...c.take(now + 1600));
    const late = notes.filter((n) => n.timeMs > 20_000 && n.timeMs < 40_000 && n.kind !== "hold");
    expect(late.length).toBeGreaterThan(20);
    const onKick = late.filter((n) => (n.timeMs - 2000) % 1000 === 0);
    const onSnare = late.filter((n) => (n.timeMs - 2500) % 1000 === 0);
    expect(onKick.every((n) => n.lane === "f")).toBe(true);
    expect(onSnare.every((n) => n.lane === "j")).toBe(true);
    // Calm: nothing but the drums.
    expect(onKick.length + onSnare.length).toBe(late.length);
  });
});
