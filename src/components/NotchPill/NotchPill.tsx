import "./NotchPill.css";

interface Props {
  notchWidth: number;
  wingWidth: number;
  height: number;
}

/**
 * Resting state: one note on each side of the notch, in the song's colours —
 * the warm F ("don") note on the left and the cool J ("ka") note on the right,
 * matching where those keys sit. The parent pulses them on the beat.
 */
export function NotchPill({ notchWidth, wingWidth, height }: Props) {
  return (
    <div className="pill" style={{ height }}>
      <div className="pill__wing" style={{ width: wingWidth }}>
        <Note lane="f" />
      </div>
      <div style={{ width: notchWidth }} aria-hidden="true" />
      <div className="pill__wing" style={{ width: wingWidth }}>
        <Note lane="j" />
      </div>
    </div>
  );
}

function Note({ lane }: { lane: "f" | "j" }) {
  return (
    <span className={`pill__mark pill__mark--${lane}`} aria-hidden="true">
      <span className="pill__glow" />
      <span className="pill__logo" />
    </span>
  );
}
