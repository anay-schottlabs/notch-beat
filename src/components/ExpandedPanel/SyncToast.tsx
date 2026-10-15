import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSyncOffset, subscribeSyncOffset } from "../../app/session";

/** Briefly shows the music-sync offset after it's nudged with [ or ]. */
export function SyncToast() {
  const offset = useSyncExternalStore(subscribeSyncOffset, getSyncOffset);
  const [visible, setVisible] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), 1100);
    return () => window.clearTimeout(t);
  }, [offset]);

  if (!visible) return null;
  return (
    <div className="sync-toast" role="status">
      Notes {offset === 0 ? "on the beat" : `${Math.abs(offset)} ms ${offset > 0 ? "later" : "earlier"}`}
    </div>
  );
}
