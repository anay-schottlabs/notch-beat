import type { NotchGeometry } from "../services/display/displayService";

/** Width of each "wing" beside the physical notch in compact mode (room for the logo). */
export const WING = 30;
/** Size of the concave flares that join the island to the screen's top edge. */
export const FLARE = 7;
/** Room for the spring animation to overshoot without clipping. */
export const OVERSHOOT = 16;

/** Expanded panel spacing. The height is derived from these, so the bottom margin always equals the side margin. */
export const PANEL = {
  width: 640,
  pad: 14,
  /** Space between the notch row and the lane. */
  top: 10,
  lane: 124,
  gap: 12,
  actions: 40,
} as const;

export interface Size {
  width: number;
  height: number;
}

export function compactSize(g: NotchGeometry): Size {
  return { width: Math.round(g.notchWidth + WING * 2), height: Math.round(g.notchHeight) };
}

export function expandedSize(g: NotchGeometry): Size {
  const height = g.notchHeight + PANEL.top + PANEL.lane + PANEL.gap + PANEL.actions + PANEL.pad;
  return { width: Math.max(PANEL.width, compactSize(g).width), height: Math.round(height) };
}

/**
 * The native window never resizes (resizing a webview mid-animation causes
 * jumps): it's always big enough for the expanded island plus flares and spring
 * overshoot, and lets clicks through everywhere outside the island.
 */
export function windowSize(g: NotchGeometry): Size {
  const island = expandedSize(g);
  return { width: island.width + FLARE * 2 + OVERSHOOT * 2, height: island.height + OVERSHOOT };
}
