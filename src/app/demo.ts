import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../services/platform";
import { BeatSequence, DEFAULT_SEQUENCE } from "../game/timing/beatSequence";
import { engine, songChanged } from "./session";

/**
 * Dev-only self-driving mode for measuring animation smoothness
 * (launch with `open --env NOTCHBEAT_DEMO=island|game NotchBeat.app`).
 * "island" expands and collapses every 2 s; "game" opens and autoplays.
 * Never takes keyboard focus.
 */
export async function startDemo(controls: { expand: () => void; collapse: () => void }): Promise<() => void> {
  const mode = isTauri ? await invoke<string | null>("demo_mode").catch(() => null) : null;
  const stopMonitor = mode ? monitorFrames() : () => {};
  if (mode === "island") {
    let open = false;
    const t = window.setInterval(() => {
      open = !open;
      (open ? controls.expand : controls.collapse)();
    }, 2000);
    return () => {
      window.clearInterval(t);
      stopMonitor();
    };
  }
  if (mode === "game" || mode === "moments") {
    controls.expand();
    // Without music the game has no notes, so the demo plays a fixed generated chart.
    window.setTimeout(() => {
      engine.reset(new BeatSequence(DEFAULT_SEQUENCE));
      engine.toggle();
    }, 800);
    const timers: number[] = [];
    if (mode === "moments") {
      // Fire the musical moments on a timer so they can be seen without music.
      timers.push(window.setTimeout(() => engine.cue("drop"), 4500));
      timers.push(window.setTimeout(songChanged, 8500));
    }
    let raf = 0;
    let lastMash = 0;
    const play = (now: number) => {
      raf = requestAnimationFrame(play);
      const song = engine.songTime();
      if (engine.activeRoll(song) && now - lastMash > 70) {
        lastMash = now;
        engine.press(Math.random() < 0.5 ? "f" : "j");
      }
      for (const n of engine.visibleNotes()) if (!n.result && n.kind !== "roll" && song >= n.timeMs - 4) engine.press(n.lane);
    };
    raf = requestAnimationFrame(play);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      stopMonitor();
    };
  }
  return () => {};
}

/** Logs main-thread frame pacing once a second: count, median, worst, and frames over 20/34 ms. */
function monitorFrames(): () => void {
  let raf = 0;
  let last = 0;
  let gaps: number[] = [];
  const start = performance.now();
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (last) {
      gaps.push(now - last);
      if (now - last > 34) void invoke("demo_log", { line: `long frame ${(now - last).toFixed(0)}ms ending at +${(now - start).toFixed(0)}ms` });
    }
    last = now;
  };
  raf = requestAnimationFrame(tick);
  const report = window.setInterval(() => {
    if (!gaps.length) return;
    const sorted = [...gaps].sort((a, b) => a - b);
    const line = `frames=${gaps.length} median=${sorted[sorted.length >> 1].toFixed(1)}ms max=${sorted.at(-1)!.toFixed(1)}ms over20=${gaps.filter((g) => g > 20).length} over34=${gaps.filter((g) => g > 34).length} phase=${engine.getPhase()}`;
    void invoke("demo_log", { line });
    gaps = [];
  }, 1000);
  return () => {
    cancelAnimationFrame(raf);
    window.clearInterval(report);
  };
}
