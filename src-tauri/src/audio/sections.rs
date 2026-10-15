//! Song-section tracking: how energetic the music is right now (relative to this
//! song), whether it's building up, and when a drop lands.
//!
//! Energy is loudness normalised to the song's own recent range (10th–90th
//! percentile over 30 s), so quiet and loud masters both span 0..1. A drop is a
//! sudden jump (≥ 5 dB within ~1 s) to high energy from a clearly lower stretch,
//! with a cooldown so one drop fires once. A slow crescendo is a build-up, not a drop.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SectionUpdate {
    /// 0..1, relative to this song.
    pub energy: f32,
    /// 0..1: how steadily energy has risen over the last ~6 s.
    pub buildup: f32,
    /// True for the one frame in which a drop is detected.
    pub drop: bool,
}

const HISTORY_SECONDS: f32 = 30.0;
const SAMPLE_EVERY_SECONDS: f32 = 0.25;
const MIN_RANGE_DB: f32 = 8.0;
const DROP_COOLDOWN_SECONDS: f32 = 12.0;

pub struct SectionTracker {
    fps: f32,
    frame: u64,
    /// ~0.5 s loudness average (dB): the "section" level.
    slow_db: Option<f32>,
    /// ~0.12 s loudness average (dB): reacts fast enough to catch the drop itself.
    fast_db: Option<f32>,
    /// slow_db samples over the last 30 s (non-silent only), for normalisation.
    levels: VecDeque<f32>,
    /// Energy samples (every 0.25 s) over the last 10 s, for build-up and drop context.
    energies: VecDeque<f32>,
    last_drop: Option<u64>,
    current: SectionUpdate,
}

impl SectionTracker {
    pub fn new(frames_per_second: f32) -> Self {
        Self {
            fps: frames_per_second,
            frame: 0,
            slow_db: None,
            fast_db: None,
            levels: VecDeque::new(),
            energies: VecDeque::new(),
            last_drop: None,
            current: SectionUpdate::default(),
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.fps);
    }

    fn ema(prev: Option<f32>, x: f32, seconds: f32, fps: f32) -> f32 {
        match prev {
            None => x,
            Some(p) => p + (x - p) / (seconds * fps).max(1.0),
        }
    }

    /// Normalise a loudness to this song's recent range.
    fn normalise(&self, db: f32) -> Option<f32> {
        if self.levels.len() < 8 {
            return None;
        }
        let mut sorted: Vec<f32> = self.levels.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        let lo = sorted[sorted.len() / 10];
        let hi = sorted[sorted.len() * 9 / 10];
        Some(((db - lo) / (hi - lo).max(MIN_RANGE_DB)).clamp(0.0, 1.0))
    }

    pub fn push(&mut self, rms_db: f32, silent: bool) -> SectionUpdate {
        self.frame += 1;
        self.current.drop = false;
        if silent {
            // Silence (paused, between songs) decays energy but isn't part of the song's range.
            self.current.energy *= 0.98;
            self.current.buildup *= 0.98;
            return self.current;
        }
        self.slow_db = Some(Self::ema(self.slow_db, rms_db, 0.5, self.fps));
        self.fast_db = Some(Self::ema(self.fast_db, rms_db, 0.12, self.fps));
        let slow = self.slow_db.unwrap();

        let every = (SAMPLE_EVERY_SECONDS * self.fps).round().max(1.0) as u64;
        if self.frame % every == 0 {
            if self.levels.len() == (HISTORY_SECONDS / SAMPLE_EVERY_SECONDS) as usize {
                self.levels.pop_front();
            }
            self.levels.push_back(slow);
            if let Some(e) = self.normalise(slow) {
                if self.energies.len() == 40 {
                    self.energies.pop_front();
                }
                self.energies.push_back(e);
                self.current.energy = e;
                self.current.buildup = self.buildup();
            }
        }

        self.current.drop = self.check_drop();
        if self.current.drop {
            self.last_drop = Some(self.frame);
        }
        self.current
    }

    /// Least-squares slope of the last 6 s of energy, scaled so +0.5 over 6 s = 1.
    fn buildup(&self) -> f32 {
        let n = self.energies.len().min(24);
        if n < 12 {
            return 0.0;
        }
        let ys: Vec<f32> = self.energies.iter().skip(self.energies.len() - n).copied().collect();
        let mean_x = (n as f32 - 1.0) / 2.0;
        let mean_y = ys.iter().sum::<f32>() / n as f32;
        let (mut num, mut den) = (0.0, 0.0);
        for (i, y) in ys.iter().enumerate() {
            let dx = i as f32 - mean_x;
            num += dx * (y - mean_y);
            den += dx * dx;
        }
        let rise = num / den * n as f32; // over the window
        (rise / 0.5).clamp(0.0, 1.0)
    }

    fn check_drop(&self) -> bool {
        // Enough context to know what "lower before" means.
        if self.energies.len() < 24 {
            return false;
        }
        if let Some(last) = self.last_drop {
            if ((self.frame - last) as f32) < DROP_COOLDOWN_SECONDS * self.fps {
                return false;
            }
        }
        let Some(now) = self.fast_db.and_then(|db| self.normalise(db)) else { return false };
        let n = self.energies.len();
        // The stretch from ~8 s to ~1.5 s ago, and where we were ~1 s ago.
        let before: Vec<f32> = self.energies.iter().take(n.saturating_sub(6)).copied().collect();
        let prior = before.iter().sum::<f32>() / before.len().max(1) as f32;
        let one_second_ago = self.energies[n.saturating_sub(4)];
        // Also a real jump in loudness, not just a big step in a still-narrow normalised range.
        let db_jump = self.fast_db.unwrap_or(0.0) - self.levels[self.levels.len().saturating_sub(4)];
        now > 0.75 && now - prior > 0.35 && now - one_second_ago > 0.3 && db_jump >= 5.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::analysis::{Analyzer, tests::noise};

    const SR: f32 = 48000.0;

    /// Noise at a given level (dBFS-ish) for `seconds`.
    fn noise_at(db: f32, seconds: f32, seed: &mut u32) -> Vec<f32> {
        let amp = 10f32.powf(db / 20.0) * 1.7;
        (0..(seconds * SR) as usize).map(|_| amp * noise(seed)).collect()
    }

    fn run(samples: &[f32]) -> Vec<(f32, SectionUpdate)> {
        let mut a = Analyzer::new(SR as f64);
        let mut s = SectionTracker::new(a.frames_per_second());
        a.push(samples).into_iter().map(|f| (f.centre_sample as f32 / SR, s.push(f.rms_db, f.silent))).collect()
    }

    #[test]
    fn steady_music_has_no_drop() {
        let mut seed = 1;
        let out = run(&noise_at(-15.0, 25.0, &mut seed));
        assert!(out.iter().all(|(_, u)| !u.drop));
    }

    #[test]
    fn sudden_jump_is_one_drop_on_time() {
        let mut seed = 2;
        let mut samples = noise_at(-34.0, 12.0, &mut seed);
        samples.extend(noise_at(-8.0, 10.0, &mut seed));
        let out = run(&samples);
        let drops: Vec<f32> = out.iter().filter(|(_, u)| u.drop).map(|(t, _)| *t).collect();
        assert_eq!(drops.len(), 1, "drops at {drops:?}");
        assert!(drops[0] >= 12.0 && drops[0] < 12.5, "drop detected at {}", drops[0]);
        // Energy is high after the drop.
        assert!(out.last().unwrap().1.energy > 0.8);
    }

    #[test]
    fn slow_crescendo_is_a_buildup_not_a_drop() {
        let mut seed = 3;
        let mut samples = noise_at(-34.0, 10.0, &mut seed);
        // Ramp up 26 dB over 14 s.
        let steps = 28;
        for i in 0..steps {
            samples.extend(noise_at(-34.0 + 26.0 * i as f32 / steps as f32, 0.5, &mut seed));
        }
        let out = run(&samples);
        assert!(out.iter().all(|(_, u)| !u.drop), "a crescendo triggered a drop");
        let peak_buildup = out.iter().map(|(_, u)| u.buildup).fold(0.0, f32::max);
        assert!(peak_buildup > 0.5, "buildup only reached {peak_buildup}");
    }

    #[test]
    fn energy_is_relative_to_the_song() {
        let mut seed = 4;
        let mut samples = noise_at(-30.0, 8.0, &mut seed);
        samples.extend(noise_at(-12.0, 8.0, &mut seed));
        samples.extend(noise_at(-30.0, 4.0, &mut seed));
        let out = run(&samples);
        let at = |t: f32| out.iter().find(|(ft, _)| *ft >= t).unwrap().1.energy;
        assert!(at(15.0) > 0.8, "loud section energy {}", at(15.0));
        assert!(at(19.5) < 0.3, "quiet section energy {}", at(19.5));
    }

    #[test]
    fn reset_forgets_the_previous_song() {
        let mut a = Analyzer::new(SR as f64);
        let mut s = SectionTracker::new(a.frames_per_second());
        let mut seed = 5;
        for f in a.push(&noise_at(-10.0, 10.0, &mut seed)) {
            s.push(f.rms_db, f.silent);
        }
        s.reset();
        assert_eq!(s.push(-10.0, false), SectionUpdate::default());
    }
}
