import { memo, useEffect, useRef } from "react";
import { getPalette, subscribePalette } from "../../app/theme";
import type { GameEngine, GamePhase } from "../../game/engine";
import type { Lane } from "../../game/types";
import { eventTime } from "../../hooks/useGameKeyboard";
import { LaneRenderer, TRACK_X } from "./laneRenderer";
import "./RhythmLane.css";

interface Props {
  engine: GameEngine;
  phase: GamePhase;
  width: number;
  height: number;
  reducedMotion: boolean;
  /** Shown under the idle prompt, e.g. an audio-capture problem. */
  notice: string | null;
}

/**
 * Hosts the canvas and its frame loop, which runs only while playing or while
 * effects fade out. Click the top track for F, the bottom one for J.
 */
export const RhythmLane = memo(function RhythmLane({ engine, phase, width, height, reducedMotion, notice }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LaneRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new LaneRenderer(canvas, engine, getPalette, reducedMotion);
    rendererRef.current = renderer;
    renderer.resize(width, height);

    let raf = 0;
    const frame = (now: number) => {
      engine.update();
      renderer.draw(now);
      raf = engine.getPhase() === "playing" || renderer.hasActiveEffects(now) ? requestAnimationFrame(frame) : 0;
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const off = engine.on(wake);
    const offPalette = subscribePalette(wake);
    wake();
    return () => {
      off();
      offPalette();
      cancelAnimationFrame(raf);
      renderer.dispose();
      rendererRef.current = null;
    };
    // reducedMotion is applied below without rebuilding the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, width, height]);

  useEffect(() => rendererRef.current?.setReducedMotion(reducedMotion), [reducedMotion]);

  // Clicking a track hits that lane (top = F, bottom = J); holding the button holds the note.
  const pointerLane = useRef<Lane | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const renderer = rendererRef.current;
    if (!renderer || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    pointerLane.current = renderer.laneAt(y);
    engine.press(pointerLane.current, eventTime(e.nativeEvent));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointerLane.current) return;
    engine.release(pointerLane.current, eventTime(e.nativeEvent));
    pointerLane.current = null;
  };

  return (
    <div className="lane" style={{ width, height }} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <canvas ref={canvasRef} style={{ width, height }} aria-label="Rhythm lanes: click the top track for F, the bottom for J" />
      {phase !== "playing" && (
        <div className="lane__overlay" style={{ left: TRACK_X }}>
          {phase === "idle" ? (
            <>
              <div className="lane__keys">
                <kbd className="f">D F</kbd>
                <kbd className="j">J K</kbd>
                <span>to hit · </span>
                <kbd className="wide">SPACE</kbd>
                <span>to start</span>
              </div>
              {notice && <div className="lane__notice">{notice}</div>}
            </>
          ) : (
            <div className="lane__paused">PAUSED</div>
          )}
        </div>
      )}
    </div>
  );
});
