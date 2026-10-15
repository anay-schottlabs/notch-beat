//! Supervises the capture helper and turns its stream into frontend events.
//!
//! Capture runs only while the user has enabled it AND Spotify is running.
//! Nothing is recorded or stored: samples are analysed and dropped.

use std::{
    io::{BufReader, Read},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{
    analysis::{Analyzer, FRAME, HOP},
    protocol::{Message, read_message},
    sections::SectionTracker,
    tempo::TempoEstimator,
};
use crate::spotify::{PlayerState, SpotifyService};

pub const STATUS_EVENT: &str = "audio-status";
pub const FEATURES_EVENT: &str = "audio-features";
pub const BEAT_EVENT: &str = "audio-beat";
pub const DROP_EVENT: &str = "audio-drop";
pub const KICK_EVENT: &str = "audio-kick";
pub const SNARE_EVENT: &str = "audio-snare";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AudioStatus {
    Off,
    /// Enabled, but Spotify isn't running.
    WaitingForSpotify,
    Starting,
    Active,
    /// Capturing, but nothing audible while Spotify says it's playing — usually a denied permission.
    Silent,
    Error { message: String },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatPayload {
    pub bpm: f32,
    pub confidence: f32,
    /// How long ago (ms) the latest estimated beat was heard, at emit time.
    /// Includes the output device latency; may be slightly negative.
    pub age_ms: f64,
}

struct Running {
    child: Child,
    /// Dropping stdin tells the helper to shut down cleanly.
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct AudioService {
    enabled: Mutex<bool>,
    status: Mutex<Option<AudioStatus>>,
    running: Mutex<Option<Running>>,
    failures: Mutex<Vec<Instant>>,
    /// Set when the song changes: tempo and section history start over.
    reset_song: std::sync::atomic::AtomicBool,
}

impl AudioService {
    fn set_status(&self, app: &AppHandle, status: AudioStatus) {
        let mut cur = self.status.lock().unwrap();
        if cur.as_ref() != Some(&status) {
            *cur = Some(status.clone());
            let _ = app.emit(STATUS_EVENT, status);
        }
    }

    pub fn status(&self) -> AudioStatus {
        self.status.lock().unwrap().clone().unwrap_or(AudioStatus::Off)
    }

    fn stop(&self) {
        if let Some(mut r) = self.running.lock().unwrap().take() {
            drop(r.stdin.take());
            // Give it a moment to tear down its tap, then make sure it's gone.
            for _ in 0..20 {
                if matches!(r.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

fn helper_path() -> Option<PathBuf> {
    let path = std::env::current_exe().ok()?.parent()?.join("notchbeat-audiotap");
    path.exists().then_some(path)
}

// ---- mach time ----

#[repr(C)]
struct Timebase {
    numer: u32,
    denom: u32,
}

unsafe extern "C" {
    fn mach_absolute_time() -> u64;
    fn mach_timebase_info(info: *mut Timebase) -> i32;
}

fn ticks_per_ms() -> f64 {
    let mut tb = Timebase { numer: 0, denom: 0 };
    unsafe { mach_timebase_info(&mut tb) };
    1e6 * tb.denom as f64 / tb.numer as f64
}

fn now_ticks() -> u64 {
    unsafe { mach_absolute_time() }
}

// ---- lifecycle ----

pub fn start(app: &AppHandle) {
    let service = Arc::new(AudioService::default());
    app.manage(service.clone());
    service.set_status(app, AudioStatus::Off);

    let app = app.clone();
    thread::spawn(move || loop {
        supervise(&app, &service);
        thread::sleep(Duration::from_millis(500));
    });
}

fn supervise(app: &AppHandle, service: &Arc<AudioService>) {
    let enabled = *service.enabled.lock().unwrap();
    let spotify = app.state::<Arc<SpotifyService>>().snapshot();

    if !enabled {
        service.stop();
        service.set_status(app, AudioStatus::Off);
        return;
    }
    if !spotify.running {
        service.stop();
        service.set_status(app, AudioStatus::WaitingForSpotify);
        return;
    }
    if matches!(service.status(), AudioStatus::Error { .. }) {
        return; // stays stopped until the user toggles capture again
    }

    // Reap a helper that exited on its own.
    let exited = {
        let mut running = service.running.lock().unwrap();
        match running.as_mut().map(|r| r.child.try_wait()) {
            Some(Ok(Some(code))) => {
                running.take();
                Some(code.code())
            }
            _ => None,
        }
    };
    if let Some(code) = exited {
        // Exit 3 = output device changed: restart right away without counting a failure.
        if code != Some(3) {
            let mut failures = service.failures.lock().unwrap();
            failures.retain(|t| t.elapsed() < Duration::from_secs(30));
            failures.push(Instant::now());
            if failures.len() >= 3 {
                service.set_status(app, AudioStatus::Error { message: "Audio capture keeps failing; toggle it to retry".into() });
                return;
            }
        }
    }

    if service.running.lock().unwrap().is_none() {
        spawn_helper(app, service);
    }
}

fn spawn_helper(app: &AppHandle, service: &Arc<AudioService>) {
    let Some(path) = helper_path() else {
        service.set_status(app, AudioStatus::Error { message: "Capture helper missing from the app bundle".into() });
        return;
    };
    service.set_status(app, AudioStatus::Starting);
    let child = Command::new(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            service.set_status(app, AudioStatus::Error { message: format!("Couldn't start capture: {e}") });
            return;
        }
    };
    let stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let stdin = child.stdin.take();
    *service.running.lock().unwrap() = Some(Running { child, stdin });

    let app2 = app.clone();
    let svc = service.clone();
    thread::spawn(move || {
        let result = pump(&app2, &svc, stdout);
        let mut err = String::new();
        let _ = stderr.read_to_string(&mut err);
        let still_enabled = *svc.enabled.lock().unwrap();
        if let (Err(e), true) = (result, still_enabled) {
            let message = err.lines().last().map(|l| l.trim_start_matches("audiotap: ").to_string()).unwrap_or(e);
            if !message.is_empty() {
                eprintln!("[audio] helper ended: {message}");
            }
        }
    });
}

/// Read the helper's stream until it ends, analysing and emitting as we go.
fn pump(app: &AppHandle, service: &AudioService, stdout: impl Read) -> Result<(), String> {
    let mut reader = BufReader::with_capacity(1 << 16, stdout);
    let (sample_rate, latency_s) = match read_message(&mut reader).map_err(|e| e.to_string())? {
        Message::Header { sample_rate, output_latency } => (sample_rate, output_latency),
        other => return Err(format!("expected header, got {other:?}")),
    };

    let tpm = ticks_per_ms();
    let ticks_per_sample = tpm * 1000.0 / sample_rate;
    let latency_ticks = latency_s * 1000.0 * tpm;
    let mut analyzer = Analyzer::new(sample_rate);
    let mut tempo = TempoEstimator::new(analyzer.frames_per_second());
    let mut sections = SectionTracker::new(analyzer.frames_per_second());
    // Maps absolute sample index -> host ticks, from the latest buffer.
    let mut total_samples: u64 = 0;
    let mut anchor: (u64, u64);
    let mut frame_count: u64 = 0;
    let mut silent_since: Option<Instant> = None;

    service.set_status(app, AudioStatus::Active);
    loop {
        let (host_time, samples) = match read_message(&mut reader) {
            Ok(Message::Audio { host_time, samples }) => (host_time, samples),
            Ok(Message::Header { .. }) => continue,
            Err(e) => return Err(e.to_string()),
        };
        anchor = (total_samples, host_time);
        total_samples += samples.len() as u64;

        if service.reset_song.swap(false, std::sync::atomic::Ordering::Relaxed) {
            tempo.reset();
            sections.reset();
        }
        for frame in analyzer.push(&samples) {
            frame_count += 1;
            tempo.push(frame.flux);
            let section = sections.push(frame.rms_db, frame.silent);
            let mut features = frame.features;
            features.energy = section.energy;
            features.buildup = section.buildup;
            if frame_count % 2 == 0 || features.transient || features.kick || features.snare {
                let _ = app.emit(FEATURES_EVENT, features);
            }
            if section.drop {
                let _ = app.emit(DROP_EVENT, ());
            }
            if features.kick || features.snare {
                // Same "heard time" convention as beats, so drum hits line up with the chart.
                let host = anchor.1 as f64 + (frame.centre_sample as f64 - anchor.0 as f64) * ticks_per_sample;
                let age_ms = (now_ticks() as f64 - (host + latency_ticks)) / tpm;
                let _ = app.emit(if features.kick { KICK_EVENT } else { SNARE_EVENT }, age_ms);
            }

            // Silence while Spotify reports playing for > 4 s usually means capture is blocked.
            if frame.silent {
                let since = *silent_since.get_or_insert_with(Instant::now);
                let playing = app.state::<Arc<SpotifyService>>().snapshot().state == PlayerState::Playing;
                if playing && since.elapsed() > Duration::from_secs(4) {
                    service.set_status(app, AudioStatus::Silent);
                }
                if since.elapsed() > Duration::from_secs(3) {
                    tempo.reset();
                }
            } else {
                silent_since = None;
                service.set_status(app, AudioStatus::Active);
            }

            // Tempo every ~250 ms.
            if frame_count % 24 == 0 {
                let payload = tempo.estimate().map(|est| {
                    let beat_sample = est.last_beat_frame * HOP as f64 + (FRAME / 2) as f64;
                    let beat_host = anchor.1 as f64 + (beat_sample - anchor.0 as f64) * ticks_per_sample;
                    let heard_host = beat_host + latency_ticks;
                    BeatPayload { bpm: est.bpm, confidence: est.confidence, age_ms: (now_ticks() as f64 - heard_host) / tpm }
                });
                let _ = app.emit(BEAT_EVENT, payload);
            }
        }
    }
}

// ---- commands ----

/// The song changed: start tempo and energy tracking afresh.
#[tauri::command]
pub fn audio_new_song(service: tauri::State<'_, Arc<AudioService>>) {
    service.reset_song.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_status(service: tauri::State<'_, Arc<AudioService>>) -> AudioStatus {
    service.status()
}

/// User-initiated. The first time, macOS asks for "System Audio Recording" permission.
#[tauri::command(async)]
pub fn audio_set_enabled(app: AppHandle, enabled: bool) -> AudioStatus {
    let service = app.state::<Arc<AudioService>>().inner().clone();
    *service.enabled.lock().unwrap() = enabled;
    service.failures.lock().unwrap().clear();
    if !enabled {
        service.stop();
    }
    // Clear any error so the supervisor retries, then act immediately.
    service.status.lock().unwrap().take();
    supervise(&app, &service);
    service.status()
}
