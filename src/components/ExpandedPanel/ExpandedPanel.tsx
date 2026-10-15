import type { GameEngine, GameSnapshot } from "../../game/engine";
import type { AudioState } from "../../hooks/useAudioState";
import type { MediaControls } from "../../hooks/useMediaState";
import { Artwork } from "../NotchPill/Artwork";
import { Icon } from "../icons";
import { RhythmLane } from "../RhythmLane/RhythmLane";
import { audioNotice } from "./audioNotice";
import { SyncToast } from "./SyncToast";
import { PANEL } from "../../app/layout";
import "./ExpandedPanel.css";

interface Props {
  engine: GameEngine;
  game: GameSnapshot;
  mediaControls: MediaControls;
  artworkUrl: string | null;
  audio: AudioState;
  /** Show the one-time explanation before the first permission request. */
  askingConsent: boolean;
  width: number;
  notchHeight: number;
  notchWidth: number;
  reducedMotion: boolean;
  onToggle: () => void;
  onReset: () => void;
  onConsent: (allow: boolean) => void;
}

const PANEL_PAD = PANEL.pad;

const noFocus = (e: React.MouseEvent) => e.preventDefault();

export function ExpandedPanel(props: Props) {
  const { engine, game, mediaControls, audio, width, notchHeight, notchWidth } = props;
  const { media } = mediaControls;
  const wing = (width - notchWidth) / 2;

  return (
    <div className="panel" style={{ width }}>
      <div className="panel__notch-row" style={{ height: notchHeight }}>
        <div className="panel__wing" style={{ width: wing, paddingLeft: PANEL_PAD }}>
          <Artwork url={props.artworkUrl} size={20} />
          <span className="panel__title">{media.track?.title ?? "NotchBeat"}</span>
        </div>
        <div style={{ width: notchWidth }} aria-hidden="true" />
        <div className="panel__wing panel__wing--right" style={{ width: wing, paddingRight: PANEL_PAD }}>
          <span className="panel__artist">{media.track?.artist ?? ""}</span>
        </div>
      </div>

      <div className="panel__body" style={{ padding: `${PANEL.top}px ${PANEL_PAD}px 0`, gap: PANEL.gap }}>
        <div className="panel__lane">
          <RhythmLane
            engine={engine}
            phase={game.phase}
            width={width - PANEL_PAD * 2}
            height={PANEL.lane}
            reducedMotion={props.reducedMotion}
            notice={audioNotice(audio)}
          />
          <SyncToast />
          {props.askingConsent && (
            <div className="consent" role="dialog" aria-label="Listen to Spotify">
              <p>
                <strong>Play to the music?</strong> macOS will ask to let NotchBeat hear <em>only Spotify</em>. The audio is
                analysed live on this Mac and never recorded or sent.
              </p>
              <button className="block" onMouseDown={noFocus} onClick={() => props.onConsent(false)}>
                Not now
              </button>
              <button className="block block--accent" onMouseDown={noFocus} onClick={() => props.onConsent(true)}>
                Continue
              </button>
            </div>
          )}
        </div>

        <div className="panel__actions" style={{ height: PANEL.actions }}>
          <button className="block block--accent block--play" onMouseDown={noFocus} onClick={props.onToggle}>
            <Icon name={game.phase === "playing" ? "pause" : "play"} size={14} />
            <span>{game.phase === "playing" ? "Pause" : game.phase === "paused" ? "Resume" : "Play"}</span>
          </button>
          {game.phase === "paused" && (
            <button className="block block--icon" aria-label="Restart" title="Restart (R)" onMouseDown={noFocus} onClick={props.onReset}>
              <Icon name="reset" size={16} />
            </button>
          )}
          {media.availability === "ready" && (
            <button className="block block--icon" aria-label="Next track" onMouseDown={noFocus} onClick={() => mediaControls.control("next")} disabled={mediaControls.busy}>
              <Icon name="next" size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
