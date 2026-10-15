import { useEffect, useState } from "react";
import { setPalette } from "../app/theme";
import { artworkFor } from "../services/artwork/artworkService";
import { DEFAULT_PALETTE, paletteFromImage } from "../services/artwork/palette";
import type { TrackInfo } from "../services/media/types";

/** Resolves the track's cover art and recolours the game to match. Returns the art URL. */
export function useArtworkTheme(track: TrackInfo | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = track ? `${track.id}|${track.artworkUrl ?? ""}` : "";

  useEffect(() => {
    if (!track) {
      setUrl(null);
      setPalette(DEFAULT_PALETTE);
      return;
    }
    let alive = true;
    artworkFor(track).then(async (art) => {
      if (!alive) return;
      setUrl(art);
      const palette = art ? await paletteFromImage(art).catch(() => DEFAULT_PALETTE) : DEFAULT_PALETTE;
      if (alive) setPalette(palette);
    });
    return () => {
      alive = false;
    };
    // `key` captures the parts of `track` that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return url;
}
