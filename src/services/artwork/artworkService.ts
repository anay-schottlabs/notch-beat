import type { TrackInfo } from "../media/types";

/**
 * Cover art URL for a track. Uses the AppleScript-provided URL when we have it,
 * otherwise Spotify's public oEmbed endpoint (no credentials; it only reveals
 * the track ID to Spotify, which is already playing it).
 */
const cache = new Map<string, Promise<string | null>>();

export function artworkFor(track: TrackInfo): Promise<string | null> {
  if (track.artworkUrl) return Promise.resolve(track.artworkUrl);
  if (!track.id.startsWith("spotify:")) return Promise.resolve(null);
  let pending = cache.get(track.id);
  if (!pending) {
    pending = fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(track.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { thumbnail_url?: unknown } | null) => (typeof j?.thumbnail_url === "string" ? j.thumbnail_url : null))
      .catch(() => null);
    pending.then((url) => url === null && cache.delete(track.id)); // retry later if offline
    cache.set(track.id, pending);
  }
  return pending;
}
