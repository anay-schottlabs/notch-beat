//! Per-frame audio features: level, three band energies, spectral-flux onset strength and transients.

use std::{collections::VecDeque, sync::Arc};

use rustfft::{Fft, FftPlanner, num_complex::Complex};
use serde::Serialize;

pub const FRAME: usize = 1024;
pub const HOP: usize = 512;

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq)]
pub struct Features {
    /// Smoothed loudness, 0..1.
    pub level: f32,
    pub low: f32,
    pub mid: f32,
    pub high: f32,
    /// Decaying onset envelope, 0..1 (jumps on a transient).
    pub pulse: f32,
    pub transient: bool,
    /// A strong onset in the bass band (kick drum, bass hit).
    pub kick: bool,
    /// A broadband crack across mids and highs without a bass hit (snare, clap).
    pub snare: bool,
    /// Section energy, 0..1 relative to this song's range (set by the energy tracker).
    pub energy: f32,
    /// How steadily energy is rising, 0..1 (set by the energy tracker).
    pub buildup: f32,
}

/// One analysed frame.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    /// Absolute sample index of the frame centre (frame i is centred on i * HOP + FRAME / 2).
    pub centre_sample: u64,
    pub features: Features,
    /// Raw onset strength (spectral flux) for tempo estimation; 0 in silence.
    pub flux: f32,
    pub silent: bool,
    /// Frame loudness in dBFS.
    pub rms_db: f32,
}

pub struct Analyzer {
    sample_rate: f32,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    buf: Vec<f32>,
    /// Absolute index of buf[0].
    buf_start: u64,
    prev_log: Vec<f32>,
    bands: [(usize, usize); 3],
    band_max: [f32; 3],
    smooth: Features,
    flux_hist: VecDeque<f32>,
    frames_since_transient: u32,
    low_db_hist: VecDeque<f32>,
    frames_since_kick: u32,
    mid_db_hist: VecDeque<f32>,
    high_db_hist: VecDeque<f32>,
    frames_since_snare: u32,
}

const SILENCE_DB: f32 = -60.0;

impl Analyzer {
    pub fn new(sample_rate: f64) -> Self {
        let sample_rate = sample_rate as f32;
        let fft = FftPlanner::new().plan_fft_forward(FRAME);
        let window = (0..FRAME)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FRAME as f32).cos())
            .collect();
        let bin = |hz: f32| ((hz * FRAME as f32 / sample_rate).round() as usize).clamp(1, FRAME / 2);
        Self {
            sample_rate,
            fft,
            window,
            scratch: vec![Complex::default(); FRAME],
            buf: Vec::with_capacity(FRAME * 4),
            buf_start: 0,
            prev_log: vec![0.0; FRAME / 2],
            bands: [(bin(30.0), bin(200.0)), (bin(200.0), bin(2000.0)), (bin(2000.0), bin(10000.0))],
            band_max: [-30.0; 3],
            smooth: Features::default(),
            flux_hist: VecDeque::with_capacity(64),
            frames_since_transient: u32::MAX / 2,
            low_db_hist: VecDeque::with_capacity(4),
            frames_since_kick: u32::MAX / 2,
            mid_db_hist: VecDeque::with_capacity(4),
            high_db_hist: VecDeque::with_capacity(4),
            frames_since_snare: u32::MAX / 2,
        }
    }

    pub fn frames_per_second(&self) -> f32 {
        self.sample_rate / HOP as f32
    }

    /// Feed samples; returns every frame completed by them.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Frame> {
        self.buf.extend_from_slice(samples);
        let mut frames = Vec::new();
        while self.buf.len() >= FRAME {
            frames.push(self.process());
            self.buf.drain(..HOP);
            self.buf_start += HOP as u64;
        }
        frames
    }

    fn process(&mut self) -> Frame {
        let centre_sample = self.buf_start + FRAME as u64 / 2;

        let mut sum_sq = 0.0f32;
        for (i, c) in self.scratch.iter_mut().enumerate() {
            let s = self.buf[i];
            sum_sq += s * s;
            *c = Complex::new(s * self.window[i], 0.0);
        }
        let rms_db = 10.0 * (sum_sq / FRAME as f32 + 1e-12).log10();
        let silent = rms_db < SILENCE_DB;
        self.fft.process(&mut self.scratch);

        // Spectral flux on log magnitudes, up to the top of the high band.
        let top = self.bands[2].1;
        let mut flux = 0.0f32;
        for k in 1..top {
            let mag = self.scratch[k].norm();
            let log = (1.0 + 100.0 * mag).ln();
            let d = log - self.prev_log[k];
            if d > 0.0 {
                flux += d;
            }
            self.prev_log[k] = log;
        }
        flux = if silent { 0.0 } else { flux / top as f32 };

        // Band energies in dB, normalised against a slowly decaying per-band peak.
        let mut band_vals = [0.0f32; 3];
        let mut band_dbs = [f32::MIN; 3];
        for (b, &(lo, hi)) in self.bands.iter().enumerate() {
            let e: f32 = self.scratch[lo..hi].iter().map(|c| c.norm_sqr()).sum::<f32>() / (hi - lo).max(1) as f32;
            let db = 10.0 * (e + 1e-12).log10();
            band_dbs[b] = db;
            self.band_max[b] = (self.band_max[b] - 0.02).max(db); // ~2 dB/s decay at ~94 fps
            band_vals[b] = if silent { 0.0 } else { ((db - (self.band_max[b] - 40.0)) / 40.0).clamp(0.0, 1.0) };
        }
        let level = if silent { 0.0 } else { ((rms_db - SILENCE_DB) / 55.0).clamp(0.0, 1.0) };

        // Transient: flux well above its recent mean, with an 80 ms refractory period.
        let mean = if self.flux_hist.is_empty() { 0.0 } else { self.flux_hist.iter().sum::<f32>() / self.flux_hist.len() as f32 };
        self.frames_since_transient = self.frames_since_transient.saturating_add(1);
        let refractory = (0.08 * self.frames_per_second()) as u32;
        let transient = !silent && flux > mean * 1.6 + 0.002 && self.frames_since_transient >= refractory;
        if transient {
            self.frames_since_transient = 0;
        }
        if self.flux_hist.len() == 40 {
            self.flux_hist.pop_front();
        }
        self.flux_hist.push_back(flux);

        // Kick: bass energy jumps ≥ 6 dB over the last few frames, to near this song's
        // bass peak. Measured in energy, not log-flux, so noise in quiet bins can't fake it.
        let low_db = band_dbs[0];
        let recent = if self.low_db_hist.is_empty() { low_db } else { self.low_db_hist.iter().sum::<f32>() / self.low_db_hist.len() as f32 };
        self.frames_since_kick = self.frames_since_kick.saturating_add(1);
        let kick = !silent
            && low_db - recent > 6.0
            && low_db > self.band_max[0] - 18.0
            && low_db > band_dbs[1].max(band_dbs[2]) - 3.0 // bass-dominant, not treble leaking down
            && self.frames_since_kick >= (0.12 * self.frames_per_second()) as u32;
        if kick {
            self.frames_since_kick = 0;
        }
        if self.low_db_hist.len() == 4 {
            self.low_db_hist.pop_front();
        }
        self.low_db_hist.push_back(low_db);

        // Snare/clap: mids and highs both jump together (a hi-hat only lifts the highs),
        // loud for this song, and not on a kick (a kick with a clap counts as the kick).
        // Rise against ~4 frames ago, so an onset split across two frames still counts.
        let before = |h: &VecDeque<f32>, now: f32| h.front().copied().unwrap_or(now);
        let (mid_db, high_db) = (band_dbs[1], band_dbs[2]);
        let mid_rise = mid_db - before(&self.mid_db_hist, mid_db);
        let high_rise = high_db - before(&self.high_db_hist, high_db);
        self.frames_since_snare = self.frames_since_snare.saturating_add(1);
        let snare = !silent
            && !kick
            && low_db - recent < mid_rise - 2.0 // rises more in the mids than the bass (a kick is the other way round)
            && self.frames_since_kick > 3
            && mid_rise > 5.0
            && high_rise > 5.0
            && mid_db > self.band_max[1] - 13.0
            && self.frames_since_snare >= (0.12 * self.frames_per_second()) as u32;
        if snare {
            self.frames_since_snare = 0;
        }
        for (hist, db) in [(&mut self.mid_db_hist, mid_db), (&mut self.high_db_hist, high_db)] {
            if hist.len() == 4 {
                hist.pop_front();
            }
            hist.push_back(db);
        }

        let ease = |cur: f32, target: f32| cur + (target - cur) * if target > cur { 0.55 } else { 0.15 };
        let s = &mut self.smooth;
        s.level = ease(s.level, level);
        s.low = ease(s.low, band_vals[0]);
        s.mid = ease(s.mid, band_vals[1]);
        s.high = ease(s.high, band_vals[2]);
        s.pulse = if transient { (flux / (mean * 3.0 + 1e-6)).clamp(0.5, 1.0) } else { s.pulse * 0.86 };
        s.transient = transient;
        s.kick = kick;
        s.snare = snare;

        Frame { centre_sample, features: *s, flux, silent, rms_db }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Deterministic noise in [-1, 1].
    pub fn noise(seed: &mut u32) -> f32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        (*seed as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// 20 ms noise bursts at `bpm`, starting at `offset` seconds, over a quiet tone bed.
    pub fn click_track(bpm: f32, seconds: f32, offset: f32, sr: f32) -> Vec<f32> {
        let mut seed = 7;
        let period = 60.0 / bpm;
        (0..(seconds * sr) as usize)
            .map(|i| {
                let t = i as f32 / sr;
                let bed = 0.02 * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
                let since = (t - offset).rem_euclid(period);
                let burst = if t >= offset && since < 0.02 { 0.8 * (1.0 - since / 0.02) * noise(&mut seed) } else { 0.0 };
                bed + burst
            })
            .collect()
    }

    #[test]
    fn silence_is_silent() {
        let mut a = Analyzer::new(48000.0);
        let frames = a.push(&vec![0.0; 48000]);
        assert!(frames.len() > 80);
        assert!(frames.iter().all(|f| f.silent && f.flux == 0.0 && !f.features.transient && f.features.level == 0.0));
    }

    #[test]
    fn detects_clicks_as_transients() {
        let sr = 48000.0;
        let mut a = Analyzer::new(sr as f64);
        let frames = a.push(&click_track(120.0, 6.0, 0.25, sr));
        // Skip the first 100 ms, where the tone bed starting from silence is itself an onset.
        let hits: Vec<f32> = frames
            .iter()
            .filter(|f| f.features.transient)
            .map(|f| f.centre_sample as f32 / sr)
            .filter(|t| *t > 0.1)
            .collect();
        // 12 clicks in 6 s at 120 BPM (first at 0.25 s); allow the first to be missed while warming up.
        assert!((11..=12).contains(&hits.len()), "transients at {hits:?}");
        for t in &hits {
            let off = (t - 0.25).rem_euclid(0.5);
            assert!(off < 0.03 || off > 0.47, "transient at {t} is off-beat");
        }
    }

    /// Bass thumps (60 Hz decaying sine) every 0.5 s, over a steady hi-hat-like noise bed.
    pub fn kick_track(seconds: f32, sr: f32) -> Vec<f32> {
        let mut seed = 3;
        (0..(seconds * sr) as usize)
            .map(|i| {
                let t = i as f32 / sr;
                let since = t.rem_euclid(0.5);
                let kick = 0.9 * (-since * 18.0).exp() * (2.0 * std::f32::consts::PI * 60.0 * since).sin();
                kick + 0.05 * noise(&mut seed)
            })
            .collect()
    }

    #[test]
    fn tells_snares_from_kicks_and_hats() {
        // Backbeat: kick on 1 and 3, snare (broadband noise burst) on 2 and 4, hats on every eighth.
        let sr = 48000.0;
        let beat = 0.5;
        let mut seed = 7;
        let samples: Vec<f32> = (0..(8.0 * sr) as usize)
            .map(|i| {
                let t = i as f32 / sr;
                let b = (t / beat).floor() as i32;
                let since = t - b as f32 * beat;
                let since_eighth = t % (beat / 2.0);
                let kick = if b % 2 == 0 { 0.9 * (-since * 18.0).exp() * (2.0 * std::f32::consts::PI * 60.0 * since).sin() } else { 0.0 };
                let snare = if b % 2 == 1 { 0.6 * (-since * 25.0).exp() * noise(&mut seed) } else { 0.0 };
                // Hats: very short, quiet, high (differenced noise is mostly treble).
                let n0 = noise(&mut seed);
                let hat = 0.08 * (-since_eighth * 120.0).exp() * (n0 - noise(&mut seed));
                kick + snare + hat + 0.01 * n0
            })
            .collect();
        let mut a = Analyzer::new(sr as f64);
        let frames = a.push(&samples);
        let at = |pick: fn(&Features) -> bool| -> Vec<f32> {
            frames.iter().filter(|f| pick(&f.features)).map(|f| f.centre_sample as f32 / sr).filter(|t| *t > 1.0).collect()
        };
        let snares = at(|f| f.snare);
        assert!((6..=8).contains(&snares.len()), "snares at {snares:?}");
        for t in &snares {
            let beat_index = (t / beat).round() as i32;
            assert!(beat_index % 2 == 1 && (t - beat_index as f32 * beat).abs() < 0.04, "snare at {t} is not on 2 or 4");
        }
        let kicks = at(|f| f.kick);
        assert!(kicks.iter().all(|t| ((t / beat).round() as i32) % 2 == 0), "kick on a snare beat: {kicks:?}");
    }

    #[test]
    fn detects_kicks_in_the_bass() {
        let sr = 48000.0;
        let mut a = Analyzer::new(sr as f64);
        let frames = a.push(&kick_track(6.0, sr));
        let kicks: Vec<f32> = frames.iter().filter(|f| f.features.kick).map(|f| f.centre_sample as f32 / sr).filter(|t| *t > 0.3).collect();
        assert!((10..=12).contains(&kicks.len()), "kicks at {kicks:?}");
        for t in &kicks {
            let off = t.rem_euclid(0.5);
            assert!(off < 0.04 || off > 0.46, "kick at {t} is off-beat");
        }
        // Treble clicks are transients but not kicks.
        let mut b = Analyzer::new(sr as f64);
        let clicks = b.push(&click_track_hp(6.0, sr));
        assert!(clicks.iter().filter(|f| f.features.kick).count() <= 2);
    }

    /// High-passed clicks: bursts of alternating samples (energy near Nyquist).
    fn click_track_hp(seconds: f32, sr: f32) -> Vec<f32> {
        (0..(seconds * sr) as usize)
            .map(|i| {
                let t = i as f32 / sr;
                let since = t.rem_euclid(0.5);
                let bed = 0.02 * (2.0 * std::f32::consts::PI * 3000.0 * t).sin();
                bed + if since < 0.01 { if i % 2 == 0 { 0.6 } else { -0.6 } } else { 0.0 }
            })
            .collect()
    }

    #[test]
    fn bands_follow_spectrum() {
        let sr = 48000.0;
        let mut a = Analyzer::new(sr as f64);
        let bass: Vec<f32> = (0..48000).map(|i| 0.5 * (2.0 * std::f32::consts::PI * 80.0 * i as f32 / sr).sin()).collect();
        let f = *a.push(&bass).last().unwrap();
        assert!(f.features.low > 0.8, "{:?}", f.features);
        assert!(f.features.low > f.features.high + 0.3, "{:?}", f.features);
        assert!(f.features.level > 0.5);
    }
}
