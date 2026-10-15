import { useCallback, useEffect, useState } from "react";
import { type MediaCommand, type MediaService, type MediaSnapshot, UNSUPPORTED_MEDIA } from "../services/media/types";

export interface MediaControls {
  media: MediaSnapshot;
  control: (command: MediaCommand) => void;
  connect: () => void;
  busy: boolean;
}

export function useMediaState(service: MediaService): MediaControls {
  const [media, setMedia] = useState<MediaSnapshot>(UNSUPPORTED_MEDIA);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // subscribe() delivers the current snapshot first, then every change.
    return service.subscribe(setMedia);
  }, [service]);

  const run = useCallback(async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setMedia((m) => ({ ...m, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, []);

  const control = useCallback((c: MediaCommand) => void run(() => service.control(c)), [run, service]);
  const connect = useCallback(() => void run(async () => setMedia(await service.connect())), [run, service]);

  return { media, control, connect, busy };
}
