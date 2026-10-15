//! Best-effort tempo and beat-phase estimation from the onset (spectral flux) envelope.
//!
//! Autocorrelation over ~8 s picks the beat period (weighted toward common tempos),
//! a comb filter finds the phase, and confidence combines peak prominence with
//! how stable the estimate has been. This is deliberately conservative: callers
//! should ignore low-confidence estimates rather than chart erratic notes.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TempoEstimate {
    pub bpm: f32,
    /// 0..1.
    pub confidence: f32,
    /// Absolute frame index of the most recent estimated beat.
    pub last_beat_frame: f64,
}

pub const MIN_BPM: f32 = 60.0;
pub const MAX_BPM: f32 = 190.0;
const WINDOW_SECONDS: f32 = 8.0;
const MIN_SECONDS: f32 = 4.0;

pub struct TempoEstimator {
    fps: f32,
    env: VecDeque<f32>,
    capacity: usize,
    /// Absolute index of the next frame to be pushed.
    frames: u64,
    history: VecDeque<f32>,
}

impl TempoEstimator {
    pub fn new(frames_per_second: f32) -> Self {
        let capacity = (WINDOW_SECONDS * frames_per_second) as usize;
        Self { fps: frames_per_second, env: VecDeque::with_capacity(capacity), capacity, frames: 0, history: VecDeque::new() }
    }

    pub fn push(&mut self, flux: f32) {
        if self.env.len() == self.capacity {
            self.env.pop_front();
        }
        self.env.push_back(flux);
        self.frames += 1;
    }

    pub fn reset(&mut self) {
        self.env.clear();
        self.history.clear();
    }

    pub fn estimate(&mut self) -> Option<TempoEstimate> {
        let n = self.env.len();
        if (n as f32) < MIN_SECONDS * self.fps {
            return None;
        }
        // Onset envelope with a local mean removed and half-wave rectified, so
        // sustained loud passages don't dominate.
        let raw: Vec<f32> = self.env.iter().copied().collect();
        let k = (0.1 * self.fps) as usize;
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let lo = i.saturating_sub(k);
                let hi = (i + k + 1).min(n);
                let mean = raw[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
                (raw[i] - mean).max(0.0)
            })
            .collect();
        // Light blur so impulses at fractional periods (e.g. 37.5 frames) still correlate.
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let at = |j: isize| x.get(j as usize).copied().unwrap_or(0.0);
                let i = i as isize;
                0.1 * at(i - 2) + 0.2 * at(i - 1) + 0.4 * at(i) + 0.2 * at(i + 1) + 0.1 * at(i + 2)
            })
            .collect();
        let energy: f32 = x.iter().map(|v| v * v).sum::<f32>() / n as f32;
        if energy < 1e-9 {
            self.history.clear();
            return None;
        }

        let lag_min = (60.0 * self.fps / MAX_BPM).floor() as usize;
        let lag_max = ((60.0 * self.fps / MIN_BPM).ceil() as usize).min(n / 2);
        let ac = |lag: usize| -> f32 {
            if lag >= n {
                return 0.0;
            }
            let s: f32 = (0..n - lag).map(|i| x[i] * x[i + lag]).sum();
            s / ((n - lag) as f32 * energy)
        };
        let acs: Vec<f32> = (0..=lag_max * 2).map(ac).collect();

        // Score each lag: its own correlation, support from the double period,
        // and a log-normal prior centred on 120 BPM to settle octave ambiguity.
        let score = |lag: usize| -> f32 {
            let bpm = 60.0 * self.fps / lag as f32;
            let prior = (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp();
            (acs[lag] + 0.5 * acs.get(lag * 2).copied().unwrap_or(0.0)) * prior
        };
        let best = (lag_min..=lag_max).max_by(|&a, &b| score(a).total_cmp(&score(b)))?;

        // Parabolic refinement of the period.
        let period = if best > lag_min && best < lag_max {
            let (a, b, c) = (acs[best - 1], acs[best], acs[best + 1]);
            let denom = a - 2.0 * b + c;
            best as f32 + if denom.abs() > 1e-9 { 0.5 * (a - c) / denom } else { 0.0 }
        } else {
            best as f32
        };
        let bpm = 60.0 * self.fps / period;

        // Prominence of the chosen peak over the typical correlation in range.
        let mut range: Vec<f32> = acs[lag_min..=lag_max].to_vec();
        range.sort_by(f32::total_cmp);
        let median = range[range.len() / 2];
        let prominence = ((acs[best] - median) / 0.3).clamp(0.0, 1.0);

        // Phase: comb filter over the envelope, weighting recent beats more.
        let steps = period.ceil() as usize;
        let beats = (n as f32 / period) as usize;
        let mut best_phase = 0.0f32;
        let mut best_sum = f32::MIN;
        for p in 0..steps {
            let mut sum = 0.0;
            for b in 0..beats {
                let pos = (n - 1) as f32 - p as f32 - b as f32 * period;
                if pos < 0.0 {
                    break;
                }
                let i = pos.round() as usize;
                let lo = i.saturating_sub(1);
                let v = x[lo..=(i + 1).min(n - 1)].iter().copied().fold(0.0, f32::max);
                sum += v * 0.92f32.powi(b as i32);
            }
            if sum > best_sum {
                best_sum = sum;
                best_phase = p as f32;
            }
        }
        let last_beat_frame = (self.frames - 1) as f64 - best_phase as f64;

        // Stability: how many recent estimates agree within 2%.
        if self.history.len() == 8 {
            self.history.pop_front();
        }
        self.history.push_back(bpm);
        let agree = self.history.iter().filter(|b| ((*b - bpm) / bpm).abs() < 0.02).count();
        let stability = agree as f32 / 8.0;
        let confidence = (prominence * (0.3 + 0.7 * stability)).clamp(0.0, 1.0);

        // Report the median of the agreeing estimates, for a steadier tempo.
        let mut agreeing: Vec<f32> = self.history.iter().copied().filter(|b| ((b - bpm) / bpm).abs() < 0.02).collect();
        agreeing.sort_by(f32::total_cmp);
        let bpm = agreeing[agreeing.len() / 2];

        Some(TempoEstimate { bpm, confidence, last_beat_frame })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::analysis::{Analyzer, tests::click_track, tests::noise};

    fn run(samples: &[f32], sr: f32) -> (Option<TempoEstimate>, f32, u64) {
        let mut a = Analyzer::new(sr as f64);
        let mut t = TempoEstimator::new(a.frames_per_second());
        let mut est = None;
        let mut last_centre = 0;
        for chunk in samples.chunks(512) {
            for f in a.push(chunk) {
                t.push(f.flux);
                last_centre = f.centre_sample;
            }
            if t.frames % 24 == 0 {
                est = t.estimate();
            }
        }
        (est.or_else(|| t.estimate()), a.frames_per_second(), last_centre)
    }

    #[test]
    fn finds_tempo_of_click_tracks() {
        let sr = 48000.0;
        for bpm in [92.0f32, 120.0, 128.0, 150.0] {
            let (est, _, _) = run(&click_track(bpm, 12.0, 0.1, sr), sr);
            let est = est.expect("estimate");
            assert!((est.bpm - bpm).abs() < bpm * 0.015, "{bpm} BPM estimated as {est:?}");
            assert!(est.confidence > 0.6, "{bpm} BPM low confidence {est:?}");
        }
    }

    #[test]
    fn finds_beat_phase() {
        let sr = 48000.0;
        let offset = 0.137;
        let (est, _, _) = run(&click_track(120.0, 12.0, offset, sr), sr);
        let est = est.unwrap();
        // Frame i is centred on sample i * HOP + FRAME / 2.
        let beat_time = (est.last_beat_frame * 512.0 + 512.0) / sr as f64;
        let err = ((beat_time - offset as f64).rem_euclid(0.5)).min(0.5 - (beat_time - offset as f64).rem_euclid(0.5));
        assert!(err < 0.03, "beat at {beat_time}, phase error {err}s");
    }

    #[test]
    fn noise_is_not_confident() {
        let sr = 48000.0;
        let mut seed = 99;
        let samples: Vec<f32> = (0..(12.0 * sr) as usize).map(|_| 0.3 * noise(&mut seed)).collect();
        if let (Some(est), _, _) = run(&samples, sr) {
            assert!(est.confidence < 0.6, "noise gave {est:?}");
        }
    }

    #[test]
    fn silence_gives_nothing() {
        let (est, _, _) = run(&vec![0.0; 48000 * 8], 48000.0);
        assert_eq!(est, None);
    }

    #[test]
    fn needs_enough_history() {
        let sr = 48000.0;
        let (est, _, _) = run(&click_track(120.0, 2.0, 0.0, sr), sr);
        assert_eq!(est, None);
    }
}
