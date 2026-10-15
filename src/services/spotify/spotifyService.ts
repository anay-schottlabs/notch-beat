import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import { type MediaService, type MediaSnapshot, UNSUPPORTED_MEDIA } from "../media/types";

/** Wire format of the Rust `SpotifySnapshot`. */
interface RawSnapshot {
  installed: boolean;
  running: boolean;
  state: "playing" | "paused" | "stopped" | "unknown";
  track: {
    id: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number | null;
    artworkUrl: string | null;
  } | null;
  permission: "granted" | "denied" | "notDetermined" | "unknown";
  error: string | null;
}

export function fromRaw(raw: RawSnapshot): MediaSnapshot {
  return {
    provider: "spotify",
    availability: !raw.installed ? "notInstalled" : !raw.running ? "notRunning" : "ready",
    state: raw.state,
    track: raw.track && raw.track.title ? raw.track : null,
    permission: raw.permission,
    error: raw.error,
  };
}

const tauriSpotify: MediaService = {
  snapshot: async () => fromRaw(await invoke<RawSnapshot>("spotify_snapshot")),
  subscribe: (cb) => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // Fetch the snapshot only once the listener is live, so no update falls in between.
    listen<RawSnapshot>("spotify-state", (e) => cb(fromRaw(e.payload))).then((u) => {
      if (cancelled) return u();
      unlisten = u;
      invoke<RawSnapshot>("spotify_snapshot").then((raw) => !cancelled && cb(fromRaw(raw)), () => {});
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
  control: (command) => invoke("spotify_control", { command }),
  connect: async () => fromRaw(await invoke<RawSnapshot>("spotify_connect")),
};

const unsupported: MediaService = {
  snapshot: async () => UNSUPPORTED_MEDIA,
  subscribe: (cb) => {
    cb(UNSUPPORTED_MEDIA);
    return () => {};
  },
  control: async () => {},
  connect: async () => UNSUPPORTED_MEDIA,
};

export const spotifyService: MediaService = isTauri ? tauriSpotify : unsupported;
