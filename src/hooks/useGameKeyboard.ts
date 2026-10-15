import { useEffect, useRef } from "react";
import type { GameEngine } from "../game/engine";
import { InputGate, isTextEntryTarget, KEY_LANES } from "../game/input/inputGate";
import { displayService } from "../services/display/displayService";

export interface KeyboardActions {
  onToggle: () => void;
  onReset: () => void;
  onCollapse: () => void;
  /** Shift music-chart sync by this many ms. */
  onNudgeSync: (deltaMs: number) => void;
}

/**
 * D/F and J/K gameplay plus Space (start/pause), R (restart), [ / ] (sync), Esc (collapse).
 * Active only while `enabled` (the panel is expanded and focused).
 */
export function useGameKeyboard(engine: GameEngine, enabled: boolean, actions: KeyboardActions): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!enabled) return;
    const gate = new InputGate();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextEntryTarget(e.target)) return;
      const lane = KEY_LANES[e.code];
      if (lane) {
        e.preventDefault();
        if (gate.down(e.code, e.repeat)) engine.press(lane, eventTime(e));
        return;
      }
      if (e.repeat) return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          actionsRef.current.onToggle();
          break;
        case "KeyR":
          actionsRef.current.onReset();
          break;
        case "BracketLeft":
          actionsRef.current.onNudgeSync(-5);
          break;
        case "BracketRight":
          actionsRef.current.onNudgeSync(5);
          break;
        case "Escape":
          actionsRef.current.onCollapse();
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const lane = KEY_LANES[e.code];
      // With two keys per lane, the lane is released only when neither is still down.
      if (gate.up(e.code) && lane && !gate.laneHeld(lane)) engine.release(lane, eventTime(e));
    };
    // Keyups that happen while unfocused never arrive, so forget held keys and pause.
    const onFocusLost = () => {
      gate.releaseAll();
      engine.pause();
    };
    const onVisibility = () => document.hidden && onFocusLost();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onFocusLost);
    document.addEventListener("visibilitychange", onVisibility);
    const offFocus = displayService.onFocusChange((focused) => !focused && onFocusLost());
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onFocusLost);
      document.removeEventListener("visibilitychange", onVisibility);
      offFocus();
    };
  }, [engine, enabled]);
}

/** The event's own high-resolution timestamp, if it shares performance.now()'s origin. */
export function eventTime(e: Event): number {
  const now = performance.now();
  return e.timeStamp > 0 && e.timeStamp <= now && now - e.timeStamp < 1000 ? e.timeStamp : now;
}
