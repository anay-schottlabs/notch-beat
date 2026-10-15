import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../platform";

export interface NotchGeometry {
  hasNotch: boolean;
  notchWidth: number;
  notchHeight: number;
  screenWidth: number;
  screenHeight: number;
  scaleFactor: number;
}

/** Window placement backend. The Tauri one pins the window to the notch; the browser one is a no-op. */
export interface DisplayService {
  geometry(): Promise<NotchGeometry>;
  onGeometryChange(cb: (g: NotchGeometry) => void): () => void;
  /** Size the window, centred on the notch with its top edge at the screen top. */
  setIslandSize(width: number, height: number): Promise<void>;
  /** The clickable area (centred at the top of the window); clicks pass through elsewhere. */
  setHitArea(width: number, height: number): Promise<void>;
  /** Take keyboard focus (needed for F/J) — only when the user expands the game. */
  focus(): Promise<void>;
  /** Give focus back to the previously active app. */
  releaseFocus(): Promise<void>;
  onFocusChange(cb: (focused: boolean) => void): () => void;
  quit(): Promise<void>;
}

/** Real notch geometry from the test MacBook, used when previewing in a browser. */
export const PREVIEW_GEOMETRY: NotchGeometry = {
  hasNotch: true,
  notchWidth: 179,
  notchHeight: 32,
  screenWidth: 1470,
  screenHeight: 956,
  scaleFactor: 2,
};

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => (cancelled ? u() : (unlisten = u)));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

const tauriDisplay: DisplayService = {
  geometry: () => invoke<NotchGeometry>("get_notch_geometry"),
  onGeometryChange: (cb) => subscribe("notch-geometry-changed", cb),
  setIslandSize: (width, height) => invoke("set_island_size", { width, height }),
  setHitArea: (width, height) => invoke("set_hit_area", { width, height }),
  focus: () => invoke("focus_island"),
  releaseFocus: () => invoke("release_focus"),
  onFocusChange: (cb) => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged((e) => cb(e.payload))
      .then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
  quit: () => invoke("quit_app"),
};

const browserDisplay: DisplayService = {
  geometry: async () => PREVIEW_GEOMETRY,
  onGeometryChange: () => () => {},
  setIslandSize: async () => {},
  setHitArea: async () => {},
  focus: async () => window.focus(),
  releaseFocus: async () => {},
  onFocusChange: (cb) => {
    const on = () => cb(true);
    const off = () => cb(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  },
  quit: async () => {},
};

export const displayService: DisplayService = isTauri ? tauriDisplay : browserDisplay;
