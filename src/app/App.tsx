import { useCallback, useEffect, useRef, useState } from "react";
import { ExpandedPanel } from "../components/ExpandedPanel/ExpandedPanel";
import { NotchPill } from "../components/NotchPill/NotchPill";
import { comboHeat } from "../components/VisualEffects/comboHeat";
import { BAND_COUNT, sampleVisual } from "../components/VisualEffects/visualSignal";
import { useArtworkTheme } from "../hooks/useArtworkTheme";
import { useAudioState } from "../hooks/useAudioState";
import { useGameKeyboard } from "../hooks/useGameKeyboard";
import { useGameSnapshot } from "../hooks/useGameSnapshot";
import { useMediaState } from "../hooks/useMediaState";
import { useNotchGeometry } from "../hooks/useNotchGeometry";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { displayService, type NotchGeometry } from "../services/display/displayService";
import { startDemo } from "./demo";
import { audio, engine, media, nudgeSyncOffset, resetGame, songChanged, togglePlay } from "./session";
import { compactSize, expandedSize, FLARE, windowSize, WING } from "./layout";

import "./Island.css";

type Mode = "compact" | "expanded" | "collapsing";

const COLLAPSE_MS = 420;

export function App() {
  const geometry = useNotchGeometry();
  return geometry ? <Island geometry={geometry} /> : null;
}

function Island({ geometry }: { geometry: NotchGeometry }) {
  const [mode, setMode] = useState<Mode>("compact");
  const modeRef = useRef<Mode>("compact");
  const islandRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const game = useGameSnapshot(engine);
  const mediaControls = useMediaState(media);
  const audioState = useAudioState(audio);
  const artworkUrl = useArtworkTheme(mediaControls.media.track);
  const [askingConsent, setAskingConsent] = useState(false);

  const compact = compactSize(geometry);
  const expanded = expandedSize(geometry);
  const size = mode === "expanded" ? expanded : compact;

  // Size the window once per display geometry; afterwards only the hit area changes.
  useEffect(() => {
    const w = windowSize(geometry);
    void displayService.setIslandSize(w.width, w.height);
    const hit = modeRef.current === "compact" ? compactSize(geometry) : expandedSize(geometry);
    void displayService.setHitArea(hit.width, hit.height);
  }, [geometry]);

  const expand = useCallback(
    (takeFocus = true) => {
      if (modeRef.current !== "compact") return;
      modeRef.current = "expanded";
      setMode("expanded");
      const hit = expandedSize(geometry);
      void displayService.setHitArea(hit.width, hit.height);
      if (takeFocus) void displayService.focus().catch(() => {});
    },
    [geometry],
  );

  const collapse = useCallback(() => {
    if (modeRef.current !== "expanded") return;
    engine.pause(); // keep the session; only Restart clears it
    setAskingConsent(false);
    modeRef.current = "collapsing";
    setMode("collapsing");
    window.setTimeout(() => {
      const hit = compactSize(geometry);
      void displayService.setHitArea(hit.width, hit.height);
      modeRef.current = "compact";
      setMode("compact");
      void displayService.releaseFocus();
    }, reducedMotion ? 180 : COLLAPSE_MS);
  }, [geometry, reducedMotion]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void startDemo({ expand: () => expand(false), collapse }).then((s) => (cancelled ? s() : (stop = s)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [expand, collapse]);


  // Spotify moved to another song.
  const trackId = mediaControls.media.track?.id ?? null;
  const lastTrack = useRef(trackId);
  useEffect(() => {
    if (trackId && lastTrack.current && trackId !== lastTrack.current) songChanged();
    if (trackId) lastTrack.current = trackId;
  }, [trackId]);

  // A drop: flash the island and kick the resting notes (opacity/transform only).
  useEffect(
    () =>
      audio.onDrop(() => {
        if (reducedMotion) return;
        const root = islandRef.current;
        root?.querySelector(".island__flash")?.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.12 }, { opacity: 0 }], {
          duration: 900,
          easing: "ease-out",
        });
        root?.querySelectorAll(".pill__mark").forEach((m) =>
          m.animate([{ transform: "scale(1)" }, { transform: "scale(1.9)", offset: 0.15 }, { transform: "scale(1)" }], {
            duration: 700,
            easing: "cubic-bezier(0.2, 0.9, 0.3, 1)",
          }),
        );
      }),
    [reducedMotion],
  );

  // Clicking anywhere outside the island (another app, the desktop) closes the game.
  useEffect(
    () =>
      displayService.onFocusChange((focused) => {
        if (!focused && modeRef.current === "expanded") collapse();
      }),
    [collapse],
  );

  // One Play button for both the game and Spotify: they start, pause and resume together.
  const mediaRef = useRef(mediaControls);
  mediaRef.current = mediaControls;
  const setSpotify = useCallback((playing: boolean) => {
    const { media: m, control } = mediaRef.current;
    if (m.availability !== "ready" || (m.state === "playing") === playing) return;
    control(playing ? "play" : "pause");
  }, []);
  const togglePlayTogether = useCallback(() => {
    const starting = engine.getPhase() !== "playing";
    togglePlay();
    setSpotify(starting);
  }, [setSpotify]);

  // Restart starts the whole song over: the run and Spotify's track, from the top.
  const restart = useCallback(() => {
    resetGame();
    togglePlay();
    const { media: m, control } = mediaRef.current;
    if (m.availability === "ready") control("restart");
  }, []);

  const onConsent = useCallback(
    (allow: boolean) => {
      setAskingConsent(false);
      const start = playAfterConsent.current;
      playAfterConsent.current = false;
      if (!allow) return;
      writeConsent();
      void audio.setEnabled(true);
      if (start) togglePlayTogether();
    },
    [togglePlayTogether],
  );

  // Notes come only from the music, so starting a run turns listening on first.
  const playAfterConsent = useRef(false);
  const play = useCallback(() => {
    if (engine.getPhase() !== "idle" || audio.enabled()) return togglePlayTogether();
    if (readConsent()) {
      void audio.setEnabled(true);
      togglePlayTogether();
    } else {
      playAfterConsent.current = true;
      setAskingConsent(true);
    }
  }, [togglePlayTogether]);

  // Pausing Spotify elsewhere (its app, media keys) pauses the run too.
  const lastMediaState = useRef(mediaControls.media.state);
  useEffect(() => {
    const state = mediaControls.media.state;
    if (lastMediaState.current === "playing" && state === "paused" && engine.getPhase() === "playing") engine.toggle();
    lastMediaState.current = state;
  }, [mediaControls.media.state]);

  useGameKeyboard(engine, mode === "expanded", {
    onToggle: play,
    onReset: restart,
    onCollapse: collapse,
    onNudgeSync: nudgeSyncOffset,
  });

  // Beat pulse for the logo and the island's edge line. Only transform/opacity of
  // those two elements change per frame (compositor-only, no style recalc of the tree).
  const mediaPlaying = mediaControls.media.state === "playing";
  const listening = audioState.availability.status === "active";
  const pulsing = !reducedMotion && (listening || game.phase === "playing");
  useEffect(() => {
    const root = islandRef.current;
    const logos = [...(root?.querySelectorAll<HTMLElement>(".pill__logo") ?? [])];
    const glows = [...(root?.querySelectorAll<HTMLElement>(".pill__glow") ?? [])];
    const line = root?.querySelector<HTMLElement>(".island__pulse");
    if (!line) return;
    // A combo makes the island pulse bigger and brighter as well (visuals only).
    const apply = (p: number, heat = 0) => {
      for (const l of logos) l.style.transform = `scale(${1 + p * (0.25 + 0.25 * heat)})`;
      for (const g of glows) {
        g.style.opacity = String(Math.min(1, p * (0.9 + 0.4 * heat)));
        g.style.transform = `scale(${1.5 + heat * (0.8 + p)})`;
      }
      line.style.opacity = String(Math.min(1, p * (0.8 + 0.4 * heat)));
      line.style.transform = `translateX(-50%) scaleX(${0.4 + p * (0.6 + 0.4 * heat)}) scaleY(${1 + heat})`;
    };
    apply(0);
    if (!pulsing) return;
    const bands = new Float32Array(BAND_COUNT);
    let raf = 0;
    let smooth = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const { pulse } = sampleVisual({ nowMs: now, engine, audio, mediaPlaying }, bands);
      // Fast attack, eased release: steps from ~47 Hz audio updates don't read as flicker.
      smooth += (pulse - smooth) * (pulse > smooth ? 0.7 : 0.25);
      apply(smooth, engine.getPhase() === "playing" ? comboHeat(engine.getScore().combo) : 0);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      apply(0);
    };
  }, [pulsing, mediaPlaying]);

  const isCompact = mode === "compact";
  return (
    <div
      className="island-shell"
      data-mode={mode}
      style={{ width: size.width, height: size.height, "--flare": `${FLARE}px` } as React.CSSProperties}
    >
      <span className="island-flare island-flare--left" />
      <span className="island-flare island-flare--right" />
      <div
        ref={islandRef}
        className="island"
        data-clickable={isCompact}
        style={{ "--radius": `${mode === "expanded" ? 24 : 10}px` } as React.CSSProperties}
        onClick={isCompact ? () => expand() : undefined}
        role={isCompact ? "button" : undefined}
        aria-label={isCompact ? "Open NotchBeat" : undefined}
      >
        <div className="island__glow" style={{ width: expanded.width, height: expanded.height }} />
        <span className="island__pulse" style={{ width: expanded.width * 0.56 }} />
        <div className="island__flash" />
        <div className="island__layer island__compact" style={{ width: compact.width }}>
          <NotchPill notchWidth={geometry.notchWidth} wingWidth={WING} height={compact.height} />
        </div>
        {/* Always mounted (hidden when compact) so expanding never pays for a React mount mid-animation. */}
        <div className="island__layer island__expanded" style={{ width: expanded.width }} aria-hidden={isCompact}>
            <ExpandedPanel
              engine={engine}
              game={game}
              mediaControls={mediaControls}
              artworkUrl={artworkUrl}
              audio={audioState}
              askingConsent={askingConsent}
              width={expanded.width}
              notchHeight={geometry.notchHeight}
              notchWidth={geometry.notchWidth}
              reducedMotion={reducedMotion}
              onToggle={play}
              onReset={restart}
              onConsent={onConsent}
            />
        </div>
      </div>
    </div>
  );
}

const CONSENT_KEY = "notchbeat.listenConsent";

function readConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, "1");
  } catch {
    // Not persisted: the explanation shows again next time.
  }
}
