# NotchBeat

A macOS app that turns the MacBook notch into a small Spotify "now playing" island. Click it and it expands downward into a two-lane rhythm game, played with **D/F** and **J/K**, whose notes follow the song you are listening to.

Built with Tauri 2 (Rust), React, TypeScript and Vite. Native window behaviour uses AppKit through the `objc2` Rust bindings. A small Swift helper (`src-tauri/native/audiotap`) captures Spotify's audio; `build.rs` compiles it automatically.

## Requirements

- macOS 26+ on a MacBook with a notch (developed on an M4 MacBook Air)
- Xcode or the Command Line Tools (for the macOS SDK)
- Node 20+ and npm
- Rust stable (`curl https://sh.rustup.rs | sh`)

## Commands

```sh
npm install

npm run app:dev      # run the real app with hot reload (tauri dev)
npm run app:build    # release .app and .dmg in src-tauri/target/release/bundle/
npm run check        # typecheck + unit tests + frontend build
npm test             # unit tests only (Vitest)
npm run dev          # frontend only, in a browser at http://localhost:1420 (no native features)
```

Open the built app with `open src-tauri/target/release/bundle/macos/NotchBeat.app`.

## Using it

- **At rest** the island is just one small note on each side of the notch (F's colour on the left, J's on the right), pulsing on the beat while NotchBeat is listening or a game is running.
- **Click the island** to open the game. **Click anywhere else** (or press Esc) to close it. Closing pauses the game; it picks up where you left off.
- **Space** plays/pauses the game and Spotify together. Hit the top track's notes with **D** or **F** and the bottom track's with **J** or **K** (either key of a pair works, so you can alternate fingers), or click the tracks. When notes line up on both tracks, hit both at once. **Held notes** (long bars): hit the head, keep the key (or mouse button) down while the bar slides through, and let go at the end. Letting go early drops it. Holds only ever block their own track, so you can keep tapping the other one. **No mashing:** pressing when there's nothing to hit (wrong track, empty track, a second tap) resets your combo. Drumrolls are the one place to mash, and every roll hit adds to the combo. Holding a held note adds one to the combo every 100 ms. **R** (or the Restart button) restarts the run and the song from the top. **[ / ]** shift music-synced notes 5 ms earlier/later.
- **Colours from the album cover:** the lanes, glow and buttons take the cover's own colours. Black-and-white covers give black-and-white lanes (keeping any sepia or cool tint), a single accent on a neutral cover is paired with that neutral, and muted covers stay muted. Colours are only brightened as far as needed to read on the dark panel, and button text flips to black on light lanes.
- **Combo visuals:** the effects grow with your combo (visuals only, never sound). Notes, rings and sparks bloom; the tracks glow and embers rise; bursts, shockwaves and shake get bigger. Tiers at 10, 25 and 50 recolour the combo drum, rings and beat lines, a glowing frame appears from 50, and from 100 it's FEVER with cycling colours. Breaking a streak of 10+ shatters the drum and drains the colour for a moment.
- **Drumrolls** (a pair of gold bars, one on each track): mash F and J as fast as you like; every hit adds one to your combo (and a few points). Rolls never break your combo.
- **Playing to the music** (always; Play turns listening on): the chart follows the song.
  - Quiet sections get sparse notes; normal sections add off-beat pickups; loud sections get busy bars, including sixteenth-note runs that alternate F and J.
  - Build-ups bring a drumroll.
  - Notes follow the song's drums: the kick goes to F (red) and the snare or clap to J (blue), learned over a few bars, so you play the beat you're hearing. Calm sections are just the drums; livelier ones add notes between them.
  - Chords are accents, not the norm: one opens each 4-bar phrase. Busy phrases end with a sixteenth-note fill.
  - A drop sets off a burst across the whole panel; the island flashes on drops even while resting.
- **Song changes:** when Spotify moves to the next song mid-run, you get a "SONG COMPLETE" flourish, and a fresh run starts on the new song by itself.
- **Sound:** NotchBeat makes no sound of its own: no hit sounds, button clicks or metronome. You hear only the song, exactly as Spotify plays it.
- **Buttons:** Play/Pause, Restart (only while paused), and Spotify next. Play/Pause drives the game and Spotify together; pausing Spotify elsewhere (its app, media keys) pauses the run too.
- **Colours** come from the current song's cover art. The art is fetched from Spotify's public oEmbed endpoint with no credentials.
- **Quit** from the NotchBeat menu bar item, which also has Hide/Show Island.

## How it works

| Area | Where | Notes |
|---|---|---|
| Notch geometry, window level and placement | `src-tauri/src/display.rs` | `NSScreen.safeAreaInsets` plus `auxiliaryTopLeft/RightArea` give the notch size. The window sits at `NSStatusWindowLevel` so it can be flush with the screen top, joins all Spaces, and shows with `orderFrontRegardless` (no activation). The island is re-placed whenever displays change (`NSApplicationDidChangeScreenParametersNotification`). |
| Spotify | `src-tauri/src/spotify.rs` | See below. |
| Menu bar item | `src-tauri/src/tray.rs` | |
| Game engine (pure TS, no React) | `src/game/` | `engine.ts` handles session state and judging, `timing/` the clock and deterministic charts, `scoring/` timing windows and score, `input/` key de-duplication, `beatDetection/` the music chart that follows the song's beat. |
| Rendering | `src/components/RhythmLane/laneRenderer.ts` | Canvas, driven by `requestAnimationFrame` only while playing or while effects fade. It reads the engine directly, so frames don't cause React re-renders. |
| Services | `src/services/` | `display`, `spotify`/`media` and `audio`. Each has a typed interface, and the browser fallbacks let the UI run without Tauri. |

**Timing.** Judgments use song time derived from `performance.now()`, with pauses excluded. The press time is the input event's own `timeStamp`, not the time it was handled. The default windows are ±35 ms for Perfect, ±75 ms for Good, and an early press within ±115 ms counts as a Miss. Notes that pass the Good window unhit are Misses. Change the windows in `src/game/scoring/judge.ts`.

**Window strategy.** The window is transparent and borderless. Before expanding, it grows to the panel size (invisibly), so the spring animation happens entirely in CSS with no window jumps. On collapse the CSS animation runs first, then the window shrinks back, so clicks outside the pill reach the apps underneath.

## Spotify integration

NotchBeat uses two sources, chosen so it never shows a permission prompt you didn't ask for:

1. **Distributed notifications** (`com.spotify.client.PlaybackStateChanged`). Spotify broadcasts the track, artist, album and play state whenever they change. This needs no permission and works from launch.
2. **AppleScript / Apple Events.** This provides the current state at launch, album artwork and the play/pause/next/previous controls. macOS asks once for Automation permission the first time you press a Spotify button in the panel. After that, NotchBeat refreshes the state automatically. Permission status is checked silently with `AEDeterminePermissionToAutomateTarget`. Every script is guarded with `if application … is running`, so NotchBeat never launches Spotify.

No credentials, Web API keys or network calls are involved, apart from loading artwork images from `i.scdn.co`.

## Fit and smoothness

- **Notch fit.** The island's height is the taller of the notch's safe-area inset and the menu bar (33 pt on a 15" Air), so it covers the camera housing's bottom edge. To fine-tune on a particular Mac: `defaults write com.notchbeat.app NotchHeightAdjust -float 0.5` (points, ±8; relaunch). `defaults delete com.notchbeat.app NotchHeightAdjust` resets it.
- **No window resizing.** The native window keeps one fixed size, and clicks pass through everywhere except the island: a 25 Hz cursor check toggles `ignoresMouseEvents`. That check reads only the cursor position, so it needs no permissions.
- **Measuring.** `open --env NOTCHBEAT_DEMO=island NotchBeat.app` (or `=game`) makes the app expand/collapse or autoplay by itself. It logs frame pacing once a second to stdout (`open --stdout log.txt …`), along with any frame over 34 ms.

## How the music shaping works

All of this is computed live from Spotify's audio (`src-tauri/src/audio/`):

- **Energy:** loudness over the last ~0.5 s, normalised to the song's own 10th–90th percentile range over the last 30 s, so quiet and loud masters both span 0–1.
- **Build-up:** the slope of energy over the last ~6 s.
- **Drop:** a jump of at least 5 dB within about a second to high energy, from a clearly lower stretch, with a 12 s cooldown. A slow crescendo counts as a build-up, not a drop.
- **Kicks:** bass-band energy rising at least 6 dB over a few frames, near the song's bass peak, and stronger than the mids and highs. Kicks are timestamped in "heard" time (including output latency), like beats.

Notes are placed ~1.6 s ahead, so they can't react to a kick that hasn't happened yet. Instead the chart learns which steps of the bar the kicks have landed on in recent bars (`KickGroove`) and puts chords there. That's accurate for steady grooves and does nothing for one-off hits.

## Known limitations

- **Music only.** There is no practice mode. Pressing Play turns listening on (asking first the very first time), and notes rest until the analyser has found a steady beat. Songs without a clear beat get few or no notes.
- **Tuned on synthetic audio.** Drop, kick and energy thresholds were tuned on synthetic signals, not a range of real songs.
- **Track at launch without permission.** If Spotify is already playing when NotchBeat starts and Automation permission hasn't been granted, the track appears only after Spotify's next change (track, play or pause). Pressing a Spotify button in the panel grants it and fetches the track immediately.
- **Transparent window uses a private API.** It relies on Tauri's `macOSPrivateApi` (WebKit's `drawsBackground`), which is widely used but undocumented. It rules out Mac App Store distribution.
- **Dev mode permissions.** In `npm run app:dev` the binary isn't bundled, so macOS attributes the Automation permission to your terminal app. The bundled `.app` gets its own entry.
- **Notchless displays.** The island centres at the top of the main screen and matches the menu bar height. When a notch display is connected, NotchBeat always prefers it.
- **Signing.** `tauri.conf.json` signs ad hoc (`"-"`), without the hardened runtime and without notarisation. With ad-hoc signing every rebuild counts as a new app to macOS, so it asks for audio and Automation permission again. To keep permissions across rebuilds, sign with your own Apple Development certificate: create `src-tauri/tauri.macos.conf.json` (git-ignored; Tauri merges it on macOS) containing `{ "bundle": { "macOS": { "signingIdentity": "Apple Development: …" } } }`. `security find-identity -v -p codesigning` lists your certificates. Moving the app to another Mac may need right-click → Open.
