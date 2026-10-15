import type { Lane } from "../types";

/** D and F play the top (F) lane; J and K play the bottom (J) lane. */
export const KEY_LANES: Readonly<Record<string, Lane>> = {
  KeyD: "f",
  KeyF: "f",
  KeyJ: "j",
  KeyK: "j",
};

/**
 * Turns raw key events into one press per physical keystroke:
 * auto-repeat and duplicate keydowns while a key is held are ignored.
 */
export class InputGate {
  private held = new Set<string>();

  /** Returns true if this keydown should count as a new press. */
  down(code: string, repeat = false): boolean {
    if (repeat || this.held.has(code)) return false;
    this.held.add(code);
    return true;
  }

  /** Returns true if this keyup ends a press we counted (so it should count as a release). */
  up(code: string): boolean {
    return this.held.delete(code);
  }

  /** Call on blur: keyups that happen while unfocused never arrive. */
  releaseAll(): void {
    this.held.clear();
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** True while any key for `lane` is down (a hold continues until the last one is let go). */
  laneHeld(lane: Lane): boolean {
    for (const code of this.held) if (KEY_LANES[code] === lane) return true;
    return false;
  }
}

/** True when the event target accepts text, so typing never triggers gameplay. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "color"].includes(type);
}
