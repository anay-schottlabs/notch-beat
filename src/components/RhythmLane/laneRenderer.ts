import type { GameEngine, GameEvent } from "../../game/engine";
import { type Judgment, type Lane, type NotePart, noteEnd } from "../../game/types";
import type { Palette } from "../../services/artwork/palette";
import { comboHeat, comboTier } from "../VisualEffects/comboHeat";

/**
 * Layout, in CSS px. Two tracks, like a drummer's two hands: F ("don", warm) on
 * top and J ("ka", cool) below, so chords line up vertically.
 */
const DRUM_W = 84;
const GAP = 8;
/** Left edge of the tracks (right of the combo drum); the lane overlay starts here too. */
export const TRACK_X = DRUM_W + GAP;
const TRACK_GAP = 6;
const TARGET_R = 22;
const NOTE_R = 19;
const RADIUS = 14;

const POP_MS = 240;
const WAVE_MS = 360;
const TEXT_MS = 480;
const MILESTONE_MS = 600;
const GRAVITY = 0.0009; // px/ms²
const SPRITE_SCALE = 1.8; // sprites are rendered larger so hit pops stay crisp

const LANES: readonly Lane[] = ["f", "j"];
const BREAK_MS = 520;
/** Most particles alive at once, so long high-combo streaks can't pile up. */
const MAX_PARTICLES = 520;

type RGB = [number, number, number];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  born: number;
  life: number;
  color: RGB;
  streak: boolean;
}

interface Pop {
  lane: Lane;
  judgment: Judgment;
  part: NotePart;
  born: number;
}

const JUDGMENT_TEXT: Readonly<Record<Judgment, string>> = { perfect: "PERFECT", good: "GOOD", miss: "MISS" };
const TAIL_TEXT: Readonly<Record<Judgment, string>> = { perfect: "HOLD!", good: "HOLD!", miss: "EARLY" };
const ROLL_COLOR: RGB = [255, 200, 61];
const DROP_MS = 900;
const SONG_END_MS = 1800;
/** Sparks per second streaming off a held note. */
const HOLD_SPARK_RATE = 40;

/**
 * Canvas renderer for the lane. Reads the engine every frame (no React), keeps
 * its own short-lived effects from engine events, and blends toward the current
 * palette so colour changes between songs are smooth. Per-frame work is kept to
 * sprite blits and simple fills: notes and track backgrounds are pre-rendered.
 */
export class LaneRenderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private colors: Record<Lane | "glow", RGB>;
  private flash: Record<Lane, number> = { f: -1e9, j: -1e9 };
  private pops: Pop[] = [];
  private particles: Particle[] = [];
  private shakeUntil = 0;
  private shakeMag = 0;
  private milestoneAt = -1e9;
  private milestoneCombo = 0;
  private comboBumpAt = -1e9;
  private combo = 0;
  private off: () => void;
  private sprites = new Map<string, HTMLCanvasElement>();
  private lastSpark: Record<Lane, number> = { f: 0, j: 0 };
  private dropAt = -1e9;
  private songEndAt = -1e9;
  private rollBumpAt: Record<Lane, number> = { f: -1e9, j: -1e9 };
  private strayAt: Record<Lane, number> = { f: -1e9, j: -1e9 };
  private trackBgs = new Map<Lane, { key: string; canvas: HTMLCanvasElement }>();
  private glows = new Map<string, HTMLCanvasElement>();
  /** Smoothed combo heat (0..1): every effect gets bigger and brighter with it. */
  private heat = 0;
  private breakAt = -1e9;
  private brokenCombo = 0;
  private lastEmber = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private engine: GameEngine,
    private palette: () => Palette,
    private reducedMotion: boolean,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    const p = palette();
    this.colors = { f: hexToRgb(p.f), j: hexToRgb(p.j), glow: hexToRgb(p.glow) };
    this.combo = engine.getScore().combo;
    this.off = engine.on((e) => this.onEvent(e));
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sprites.clear();
    this.trackBgs.clear();
    this.glows.clear();
    // Build sprites up front so the first note on screen never costs a frame.
    this.noteSprite(this.colors.f);
    this.noteSprite(this.colors.j);
    this.noteSprite([90, 90, 90]);
  }

  dispose(): void {
    this.off();
  }

  private get trackH(): number {
    return (this.height - TRACK_GAP) / 2;
  }

  private trackTop(lane: Lane): number {
    return lane === "f" ? 0 : this.trackH + TRACK_GAP;
  }

  private rowY(lane: Lane): number {
    return this.trackTop(lane) + this.trackH / 2;
  }

  private get targetX(): number {
    return TRACK_X + 10 + TARGET_R;
  }

  /** Lane under a point in CSS px (top track = F, bottom = J). */
  laneAt(y: number): Lane {
    return y < this.height / 2 ? "f" : "j";
  }

  private onEvent(e: GameEvent): void {
    const now = performance.now();
    if (e.type === "press") this.flash[e.lane] = now;
    if (e.type === "phase" && e.phase === "idle") {
      this.pops = [];
      this.combo = 0;
    }
    if (e.type === "roll") return this.onRollHit(e.lane, now);
    if (e.type === "holdTick") return this.onBonus(now);
    if (e.type === "stray") {
      // Hit nothing: grey ring and a small shake. The combo is gone.
      this.strayAt[e.lane] = now;
      this.setCombo(now);
      this.shake(now, 2, 100);
      return;
    }
    if (e.type === "cue") return e.cue === "drop" ? this.onDrop(now) : this.onSongEnd(now);
    if (e.type !== "judgment") return;

    this.pops = this.pops.filter((p) => p.lane !== e.lane || now - p.born < POP_MS);
    this.pops.push({ lane: e.lane, judgment: e.judgment, part: e.part, born: now });
    this.setCombo(now);
    if (e.judgment === "miss") {
      this.shake(now, 2, 110);
      return;
    }
    this.comboBumpAt = now;
    if (this.reducedMotion) return;
    const perfect = e.judgment === "perfect";
    const tail = e.part === "tail";
    // A finished hold gets the biggest burst: it's the payoff. Everything grows with the combo.
    const heat = comboHeat(this.combo);
    const more = 1 + 1.6 * heat;
    this.burst(e.lane, Math.round((tail ? 30 : perfect ? 20 : 11) * more), perfect, now, (tail ? 1.5 : 1.1) * (1 + 0.5 * heat));
    this.shake(now, (tail ? 5 : perfect ? 3.2 : 1.6) * (1 + 0.6 * heat), tail ? 220 : perfect ? 150 : 90);
    if (this.combo > 0 && (this.combo % 25 === 0 || this.combo === 10)) {
      this.milestoneAt = now;
      this.milestoneCombo = this.combo;
      this.burst("f", Math.round(30 * more), true, now, 1.8);
      this.burst("j", Math.round(30 * more), true, now, 1.8);
      this.shake(now, 7 + 3 * heat, 300);
    }
  }

  /** Track the combo; losing a real streak shatters it. */
  private setCombo(now: number): void {
    const prev = this.combo;
    this.combo = this.engine.getScore().combo;
    if (prev >= 10 && this.combo === 0) this.onComboBreak(prev, now);
  }

  /** The streak is gone: grey shards fly off the combo drum and the colour drains for a moment. */
  private onComboBreak(lost: number, now: number): void {
    this.breakAt = now;
    this.brokenCombo = lost;
    if (this.reducedMotion) return;
    const n = Math.round(16 + 24 * comboHeat(lost));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.12 + Math.random() * 0.22;
      this.particles.push({ x: DRUM_W / 2, y: this.height / 2, vx: Math.cos(a) * speed + 0.06, vy: Math.sin(a) * speed - 0.05, size: 3 + Math.random() * 4, born: now, life: 420 + Math.random() * 260, color: Math.random() < 0.3 ? [200, 200, 200] : [110, 110, 110], streak: false });
    }
    this.shake(now, 4 + 4 * comboHeat(lost), 240);
  }

  /** A roll hit or hold tick added one to the combo: tick the drum up (and mark milestones). */
  private onBonus(now: number): void {
    this.setCombo(now);
    this.comboBumpAt = now;
    if (this.combo % 25 === 0) {
      this.milestoneAt = now;
      this.milestoneCombo = this.combo;
    }
  }

  /** Each drumroll hit: a little gold burst off the ring and a bump of the counter. */
  private onRollHit(lane: Lane, now: number): void {
    this.rollBumpAt[lane] = now;
    this.onBonus(now);
    if (this.reducedMotion) return;
    const x = this.targetX;
    const y = this.rowY(lane);
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.08 + Math.random() * 0.14;
      this.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 0.08, size: 3 + Math.random() * 2, born: now, life: 320 + Math.random() * 160, color: i % 3 ? ROLL_COLOR : [255, 255, 255], streak: i % 3 === 0 });
    }
    this.shake(now, 1.2, 60);
  }

  /** The music dropped: everything goes off at once. */
  private onDrop(now: number): void {
    this.dropAt = now;
    if (this.reducedMotion) return;
    for (let i = 0; i < 130; i++) {
      const lane: Lane = i % 2 ? "f" : "j";
      this.particles.push({
        x: TRACK_X + Math.random() * (this.width - TRACK_X),
        y: this.rowY(lane),
        vx: (Math.random() - 0.5) * 0.25,
        vy: -0.15 - Math.random() * 0.2,
        size: 3 + Math.random() * 4,
        born: now,
        life: 500 + Math.random() * 400,
        color: Math.random() < 0.25 ? [255, 255, 255] : mix(this.colors[lane], [255, 255, 255], Math.random() * 0.3),
        streak: Math.random() < 0.3,
      });
    }
    this.burst("f", 34, true, now, 2.1);
    this.burst("j", 34, true, now, 2.1);
    this.shake(now, 10, 380);
  }

  /** The song finished mid-run: confetti and a banner while the next one starts. */
  private onSongEnd(now: number): void {
    this.songEndAt = now;
    this.pops = [];
    this.combo = 0; // the run restarts right after this cue
    if (this.reducedMotion) return;
    const palette: RGB[] = [this.colors.f, this.colors.j, ROLL_COLOR, [255, 255, 255]];
    for (let i = 0; i < 90; i++) {
      this.particles.push({
        x: TRACK_X + Math.random() * (this.width - TRACK_X),
        y: -4 - Math.random() * 20,
        vx: (Math.random() - 0.5) * 0.08,
        vy: 0.02 + Math.random() * 0.06,
        size: 3 + Math.random() * 3,
        born: now + Math.random() * 500,
        life: 1100 + Math.random() * 600,
        color: palette[i % palette.length],
        streak: false,
      });
    }
  }

  private shake(now: number, magnitude: number, ms: number): void {
    if (this.reducedMotion) return;
    this.shakeMag = now < this.shakeUntil ? Math.max(this.shakeMag, magnitude) : magnitude;
    this.shakeUntil = Math.max(this.shakeUntil, now + ms);
  }

  private burst(lane: Lane, count: number, sparks: boolean, now: number, power = 1): void {
    const x = this.targetX;
    const y = this.rowY(lane);
    const base = this.colors[lane];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (0.1 + Math.random() * 0.2) * power;
      const streak = sparks && i % 3 === 0;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 0.07 * power,
        size: streak ? 2 : 3 + Math.random() * 3,
        born: now,
        life: 360 + Math.random() * 240,
        color: streak ? mix(base, [255, 255, 255], 0.7) : mix(base, [255, 255, 255], Math.random() * 0.35),
        streak,
      });
    }
  }

  /** Draw one frame. `now` is performance.now() (the rAF timestamp). */
  draw(now: number): void {
    const { ctx, width: w, height: h, engine } = this;
    const song = engine.songTime(now);
    const tx = this.targetX;
    const pxPerMs = (w - tx) / engine.lookaheadMs;
    const trackW = w - TRACK_X;
    const trackH = this.trackH;

    // Blend toward the current palette.
    const p = this.palette();
    this.colors.f = mix(this.colors.f, hexToRgb(p.f), 0.08);
    this.colors.j = mix(this.colors.j, hexToRgb(p.j), 0.08);
    this.colors.glow = mix(this.colors.glow, hexToRgb(p.glow), 0.08);
    const glow = this.colors.glow;

    // Heat climbs smoothly with the combo and drains fast when it breaks.
    const target = comboHeat(this.combo);
    this.heat += (target - this.heat) * (target > this.heat ? 0.06 : 0.2);
    const heat = this.reducedMotion ? 0 : this.heat;
    const tier = comboTier(this.combo);
    const fever = tier === 4 ? feverColor(now) : null;
    const accent: RGB = fever ?? (tier === 3 ? ROLL_COLOR : tier === 2 ? this.colors.j : tier === 1 ? this.colors.f : [255, 255, 255]);
    const playing = engine.getPhase() === "playing";
    if (playing && heat > 0.35 && now - this.lastEmber > 1000 / (60 * (heat - 0.3))) {
      // Embers drifting up off the tracks: denser the longer the streak.
      this.lastEmber = now;
      const lane: Lane = Math.random() < 0.5 ? "f" : "j";
      const c = fever && Math.random() < 0.5 ? fever : Math.random() < 0.2 ? ROLL_COLOR : this.colors[lane];
      this.particles.push({ x: TRACK_X + 20 + Math.random() * (w - TRACK_X - 20), y: this.trackTop(lane) + this.trackH, vx: -0.04 - Math.random() * 0.06, vy: -0.05 - Math.random() * 0.08 * (1 + heat), size: 2 + Math.random() * 2.5 * (1 + heat), born: now, life: 700 + Math.random() * 600, color: mix(c, [255, 255, 255], 0.25), streak: false });
    }
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    if (now < this.shakeUntil) {
      const m = this.shakeMag * clamp01((this.shakeUntil - now) / 150);
      ctx.translate((Math.random() - 0.5) * 2 * m, (Math.random() - 0.5) * 2 * m);
    }

    const beatPhase = playing ? engine.beatPhase(song) : null;
    const beatPulse = beatPhase === null || this.reducedMotion ? 0 : (1 - beatPhase) ** 3;

    // --- Combo drum ---
    const bump = this.reducedMotion ? 0 : Math.max(0, 1 - (now - this.comboBumpAt) / 160);
    ctx.fillStyle = rgba(mix(glow, [255, 255, 255], 0.06), 1);
    roundRect(ctx, 0, 0, DRUM_W, h, RADIUS);
    ctx.fill();
    if (heat > 0.05) {
      // The drum burns in the tier's colour, breathing with the beat.
      this.bloom(DRUM_W / 2, h / 2, 56 + 22 * heat + 10 * beatPulse * heat, accent, 0.25 + 0.6 * heat + 0.4 * bump * heat);
    }
    ctx.lineWidth = 3 + 1.5 * heat;
    ctx.strokeStyle = tier > 0 ? rgba(accent, 0.55 + 0.45 * bump) : "rgba(255,255,255,0.10)";
    roundRect(ctx, 1.5, 1.5, DRUM_W - 3, h - 3, RADIUS - 1.5);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const breaking = clamp01(1 - (now - this.breakAt) / BREAK_MS);
    ctx.font = `800 ${Math.round(32 * (1 + (0.18 + 0.2 * heat) * bump))}px -apple-system, system-ui, sans-serif`;
    if (heat > 0.05) {
      ctx.shadowColor = rgba(accent, 1);
      ctx.shadowBlur = 6 + 14 * heat;
    }
    ctx.fillStyle = breaking > 0 ? `rgba(150,150,150,${0.6 + 0.4 * breaking})` : tier > 0 ? "#fff" : "rgba(255,255,255,0.85)";
    const label = breaking > 0 && this.combo === 0 ? String(this.brokenCombo) : this.combo > 0 ? String(this.combo) : "–";
    const crack = breaking > 0 && !this.reducedMotion ? (Math.random() - 0.5) * 6 * breaking : 0;
    ctx.fillText(label, DRUM_W / 2 + crack, h / 2 + 10 * (1 - breaking) * (breaking > 0 ? 1 : 0));
    ctx.shadowBlur = 0;

    // Held notes keep their track and ring lit, and stream sparks.
    for (const lane of LANES) {
      if (!engine.isHolding(lane)) continue;
      this.flash[lane] = now - 40;
      if (!this.reducedMotion && now - this.lastSpark[lane] > 1000 / (HOLD_SPARK_RATE * (1 + heat))) {
        this.lastSpark[lane] = now;
        const c = this.colors[lane];
        this.particles.push({
          x: tx,
          y: this.rowY(lane) + (Math.random() - 0.5) * NOTE_R,
          vx: -0.05 - Math.random() * 0.12,
          vy: -0.06 - Math.random() * 0.1,
          size: 2 + Math.random() * 3,
          born: now,
          life: 260 + Math.random() * 200,
          color: Math.random() < 0.3 ? [255, 255, 255] : mix(c, [255, 255, 255], 0.3),
          streak: Math.random() < 0.25,
        });
      }
    }

    // --- Tracks ---
    for (const lane of LANES) {
      const top = this.trackTop(lane);
      ctx.drawImage(this.trackBackground(lane, glow, trackW, trackH), TRACK_X, top, trackW, trackH);
      // Press flash: the track lights in its colour.
      const f = clamp01(1 - (now - this.flash[lane]) / 160);
      if (f > 0) {
        ctx.fillStyle = rgba(this.colors[lane], (0.3 + 0.2 * heat) * f);
        roundRect(ctx, TRACK_X, top, trackW, trackH, RADIUS);
        ctx.fill();
      }
      // Combo aura: a glow rising from the target end of the track, pulsing on the beat.
      if (heat > 0.05) {
        const c = fever && lane === "j" ? fever : this.colors[lane];
        this.bloomRect(TRACK_X - trackW * 0.2, top - trackH * 0.4, trackW * (0.55 + 0.6 * heat), trackH * 1.8, c, heat * (0.22 + 0.25 * beatPulse));
      }
    }

    // Milestone flash across everything.
    const ms = clamp01(1 - (now - this.milestoneAt) / MILESTONE_MS);
    if (ms > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 * ms})`;
      roundRect(ctx, 0, 0, w, h, RADIUS);
      ctx.fill();
      this.bloomRect(TRACK_X, -h * 0.3, trackW, h * 1.6, accent, 0.6 * ms);
    }

    // Combo break: the colour drains out of the lanes for a moment.
    const drain = clamp01(1 - (now - this.breakAt) / BREAK_MS);
    if (drain > 0) {
      ctx.fillStyle = `rgba(20,20,20,${0.45 * drain})`;
      roundRect(ctx, TRACK_X, 0, trackW, h, RADIUS);
      ctx.fill();
    }

    // Beat bars span both tracks, so chords read as one hit.
    if (engine.getPhase() !== "idle") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(TRACK_X, 0, trackW, h);
      ctx.clip();
      for (const beat of engine.beatsBetween(song - 200, song + engine.lookaheadMs)) {
        const x = tx + (beat - song) * pxPerMs;
        if (x < TRACK_X + 4) continue;
        const down = engine.isDownbeat(beat);
        ctx.fillStyle = down ? rgba(mix([255, 255, 255], accent, heat), 0.16 + 0.24 * heat) : rgba(mix([255, 255, 255], accent, heat), 0.07 + 0.1 * heat);
        ctx.fillRect(x - (down ? 2 : 1), 4, down ? 4 : 2, h - 8);
      }
      ctx.restore();
    }

    // Hit targets: thick rings that breathe with the beat.
    const tr = TARGET_R * (1 + 0.07 * beatPulse);
    for (const lane of LANES) {
      const y = this.rowY(lane);
      const lit = clamp01(1 - (now - this.flash[lane]) / 180);
      const ringGlow = 0.12 + 0.4 * heat + 0.35 * beatPulse * heat + 0.8 * lit;
      this.bloom(tx, y, tr * (2.2 + 1.2 * heat + 0.8 * lit), lit > 0 ? this.colors[lane] : accent, ringGlow);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.arc(tx, y, tr, 0, Math.PI * 2);
      ctx.fill();
      const f = clamp01(1 - (now - this.flash[lane]) / 140);
      if (f > 0) {
        ctx.fillStyle = rgba(this.colors[lane], 0.8 * f);
        ctx.beginPath();
        ctx.arc(tx, y, tr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.lineWidth = 4;
      ctx.strokeStyle = rgba(mix([255, 255, 255], accent, 0.6 * heat), 0.5 + 0.35 * beatPulse + 0.15 * heat);
      ctx.beginPath();
      ctx.arc(tx, y, tr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Notes, farthest first so nearer ones overlap them.
    ctx.save();
    ctx.beginPath();
    ctx.rect(TRACK_X, 0, trackW, h);
    ctx.clip();
    const notes = engine.visibleNotes();
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      // A held note's head stays pinned to the ring while its body slides through.
      const x = n.holding ? tx : tx + (n.timeMs - song) * pxPerMs;
      if (n.kind === "roll") {
        this.roll(n.timeMs, noteEnd(n), song, tx, pxPerMs, now, n.rollHits ?? 0);
        continue;
      }
      const endX = n.durationMs ? tx + (noteEnd(n) - song) * pxPerMs : x;
      if (x > w + NOTE_R + 4 || endX < TRACK_X - NOTE_R - 4) continue;
      const y = this.rowY(n.lane);
      const dead = n.result === "miss" || n.tailResult === "miss";
      // Fade out before reaching the combo drum (WebKit doesn't reliably clip these draws).
      const edgeFade = clamp01((x - (TRACK_X + NOTE_R)) / (tx - TRACK_X - NOTE_R));
      const fade = (dead ? 0.6 * clamp01(1 - (song - noteEnd(n)) / 400) : 1) * (n.holding ? 1 : edgeFade);
      if (fade <= 0) continue;
      const color: RGB = dead ? [90, 90, 90] : this.colors[n.lane];
      if (!dead && !this.reducedMotion) {
        // Light trail behind the note (notes travel left) and a soft halo, both stronger with the combo.
        if (heat > 0.15 && !n.durationMs) this.bloomRect(x, y - NOTE_R * 0.9, NOTE_R * (2 + 5 * heat), NOTE_R * 1.8, color, fade * 0.5 * heat, true);
        this.bloom(x, y, NOTE_R * (1.9 + 1.3 * heat), color, fade * (0.28 + 0.5 * heat));
      }
      if (n.kind === "hold") this.holdBody(Math.max(x, TRACK_X + NOTE_R), endX, y, color, fade, !!n.holding, now);
      this.note(x, y, NOTE_R * (n.holding && !this.reducedMotion ? 1.08 + 0.05 * Math.sin(now / 45) : 1), color, fade);
    }

    // Stray presses: the ring goes grey for a moment.
    for (const lane of LANES) {
      const t = (now - this.strayAt[lane]) / 220;
      if (t < 0 || t >= 1) continue;
      ctx.lineWidth = 5;
      ctx.strokeStyle = `rgba(110,110,110,${0.9 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(tx, this.rowY(lane), tr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Hit pops: the note swells and bursts at its target, plus a shockwave.
    this.pops = this.pops.filter((p) => now - p.born < TEXT_MS);
    for (const pop of this.pops) {
      const age = now - pop.born;
      const y = this.rowY(pop.lane);
      const color = this.colors[pop.lane];
      if (pop.judgment === "miss") {
        const t = age / 260;
        if (t < 1) {
          ctx.lineWidth = 4;
          ctx.strokeStyle = `rgba(120,120,120,${0.8 * (1 - t)})`;
          ctx.beginPath();
          ctx.arc(tx, y, tr, 0, Math.PI * 2);
          ctx.stroke();
        }
        continue;
      }
      const big = pop.judgment === "perfect";
      if (age < POP_MS) {
        const t = age / POP_MS;
        if (!this.reducedMotion) this.bloom(tx, y, NOTE_R * (2.6 + 2.4 * heat) * (0.7 + 0.6 * easeOut(t)), color, (1 - t) * (big ? 1 : 0.6) * (0.7 + 0.5 * heat));
        this.note(tx, y, NOTE_R * (1 + (this.reducedMotion ? 0 : 0.7 + 0.3 * heat) * easeOut(t)), color, 1 - t);
      }
      if (age < WAVE_MS * (1 + 0.4 * heat) && !this.reducedMotion) {
        const t = age / (WAVE_MS * (1 + 0.4 * heat));
        ctx.lineWidth = (big ? 8 : 5) * (1 + 0.5 * heat) * (1 - t);
        ctx.strokeStyle = big ? rgba(mix([255, 255, 255], accent, 0.5 * heat), 1 - t) : rgba(color, 1 - t);
        arcRightOf(ctx, tx, y, tr + easeOut(t) * (big ? 40 : 26) * (1 + 0.8 * heat), TRACK_X + 2);
        ctx.stroke();
        if (big && heat > 0.5) {
          // A second, later ring once the streak is hot.
          const t2 = clamp01((age - 70) / WAVE_MS);
          if (t2 > 0 && t2 < 1) {
            ctx.lineWidth = 4 * (1 - t2);
            ctx.strokeStyle = rgba(color, (1 - t2) * heat);
            arcRightOf(ctx, tx, y, tr + easeOut(t2) * 70 * heat, TRACK_X + 2);
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore(); // track clip

    // Particles fly freely over the whole lane.
    this.particles = this.particles.filter((pt) => now - pt.born < pt.life);
    ctx.globalCompositeOperation = "lighter";
    for (const pt of this.particles) {
      const age = now - pt.born;
      if (age < 0) continue; // scheduled to appear a little later
      const t = age / pt.life;
      const drag = Math.exp(-age / 420);
      const x = pt.x + pt.vx * 420 * (1 - drag);
      const y = pt.y + pt.vy * 420 * (1 - drag) + 0.5 * GRAVITY * age * age;
      ctx.globalAlpha = 1 - t * t;
      if (pt.streak) {
        ctx.strokeStyle = rgba(pt.color, 1);
        ctx.lineWidth = 2 + heat;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - pt.vx * 60 * drag, y - pt.vy * 60 * drag);
        ctx.stroke();
      } else {
        const s = pt.size * (1 - 0.5 * t);
        // Bloom: each spark carries a soft halo.
        if (s > 2.5) this.bloom(x, y, s * 2.4, pt.color, (1 - t * t) * 0.55);
        ctx.fillStyle = rgba(pt.color, 1);
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // Judgment text beside each lane's target.
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const lane of LANES) {
      const pop = this.latestPop(lane);
      if (!pop) continue;
      const age = now - pop.born;
      const t = age / TEXT_MS;
      const scale = this.reducedMotion ? 1 : 1 + 0.35 * Math.max(0, 1 - age / 120);
      const x = tx + TARGET_R + 8 + (this.reducedMotion ? 0 : 6 * easeOut(t));
      ctx.globalAlpha = clamp01(1.4 - t * 1.4);
      ctx.font = `900 ${Math.round(16 * scale)}px -apple-system, system-ui, sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      const text = (pop.part === "tail" ? TAIL_TEXT : JUDGMENT_TEXT)[pop.judgment];
      const y = this.rowY(lane);
      ctx.strokeText(text, x, y);
      ctx.fillStyle = pop.judgment === "perfect" ? "#fff" : pop.judgment === "good" ? rgba(this.colors[lane], 1) : "#9a9a9a";
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;

    // Drop: a palette flash across everything, plus rings from both targets.
    const drop = clamp01(1 - (now - this.dropAt) / DROP_MS);
    if (drop > 0) {
      ctx.fillStyle = rgba(mix(this.colors.f, [255, 255, 255], 0.4), 0.4 * drop * drop);
      roundRect(ctx, 0, 0, w, h, RADIUS);
      ctx.fill();
      this.bloomRect(-w * 0.1, -h * 0.5, w * 1.2, h * 2, this.colors.j, 0.7 * drop);
      for (const lane of LANES) this.bloom(tx, this.rowY(lane), 60 + 80 * (1 - drop), this.colors[lane], drop);
      if (!this.reducedMotion) {
        for (let k = 0; k < 3; k++) {
          const t = clamp01((now - this.dropAt - k * 110) / 600);
          if (t <= 0 || t >= 1) continue;
          ctx.lineWidth = 9 * (1 - t);
          ctx.strokeStyle = `rgba(255,255,255,${1 - t})`;
          for (const lane of LANES) {
            arcRightOf(ctx, tx, this.rowY(lane), TARGET_R + easeOut(t) * 140, TRACK_X + 2);
            ctx.stroke();
          }
        }
      }
    }

    // Song complete: a banner while the confetti falls and the next run starts.
    const end = clamp01(1 - (now - this.songEndAt) / SONG_END_MS);
    if (end > 0) {
      const appear = clamp01((now - this.songEndAt) / 160);
      ctx.globalAlpha = Math.min(appear, end * 2.5);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.round(24 * (1 + 0.25 * (1 - appear)))}px -apple-system, system-ui, sans-serif`;
      ctx.lineWidth = 6;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      const cx = TRACK_X + trackW / 2;
      ctx.strokeText("SONG COMPLETE", cx, h / 2);
      ctx.fillStyle = "#fff";
      ctx.fillText("SONG COMPLETE", cx, h / 2);
      ctx.globalAlpha = 1;
    }

    // Milestone banner.
    if (ms > 0) {
      ctx.globalAlpha = ms;
      ctx.textAlign = "center";
      ctx.font = `900 ${Math.round(26 + 12 * (1 - ms))}px -apple-system, system-ui, sans-serif`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      const label = `${this.milestoneCombo} COMBO!`;
      const cx = TRACK_X + trackW / 2 + 40;
      ctx.strokeText(label, cx, h / 2);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, cx, h / 2);
      ctx.globalAlpha = 1;
    }

    // A glowing frame around the lanes from 50 combo; it cycles colour in fever.
    if (heat > 0.6) {
      const a = clamp01((heat - 0.6) / 0.3) * (0.55 + 0.45 * beatPulse);
      ctx.globalCompositeOperation = "lighter";
      for (const [lw, alpha] of [[7, 0.2], [2.5, 0.9]] as const) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = rgba(accent, a * alpha);
        roundRect(ctx, TRACK_X + 1, 1, trackW - 2, h - 2, RADIUS);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    ctx.restore(); // shake
  }

  /** Additive soft glow centred on (x, y) with radius r. */
  private bloom(x: number, y: number, r: number, color: RGB, alpha: number): void {
    if (alpha <= 0.01 || r <= 0) return;
    const { ctx } = this;
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(this.glowSprite(color), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = op;
  }

  /** Additive glow stretched over a rectangle; `trail` uses only its left half's fade, for note trails. */
  private bloomRect(x: number, y: number, w: number, h: number, color: RGB, alpha: number, trail = false): void {
    if (alpha <= 0.01 || w <= 0) return;
    const { ctx } = this;
    const sprite = this.glowSprite(color);
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, alpha);
    if (trail) ctx.drawImage(sprite, sprite.width / 2, 0, sprite.width / 2, sprite.height, x, y, w, h);
    else ctx.drawImage(sprite, x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = op;
  }

  /** Radial glow sprite (bright core fading to nothing), cached per quantised colour. */
  private glowSprite(color: RGB): HTMLCanvasElement {
    const q = color.map((c) => Math.round(c / 8) * 8) as RGB;
    const key = q.join(",");
    let sprite = this.glows.get(key);
    if (sprite) return sprite;
    const size = 64;
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = size;
    const c = sprite.getContext("2d")!;
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, rgba(mix(q, [255, 255, 255], 0.5), 1));
    g.addColorStop(0.25, rgba(q, 0.6));
    g.addColorStop(0.6, rgba(q, 0.18));
    g.addColorStop(1, rgba(q, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    if (this.glows.size > 40) this.glows.delete(this.glows.keys().next().value!);
    this.glows.set(key, sprite);
    return sprite;
  }

  /**
   * A drumroll: one gold bar on each track, in parallel. While it's under the rings
   * the heads pin there; each bar brightens on its own key's hits, and the hit
   * count sits between the tracks.
   */
  private roll(start: number, end: number, song: number, tx: number, pxPerMs: number, now: number, hits: number): void {
    const { ctx } = this;
    const active = song >= start && song <= end;
    const x0 = active ? tx : tx + (start - song) * pxPerMs;
    const x1 = tx + (end - song) * pxPerMs;
    if (x1 < TRACK_X) return;
    const r = NOTE_R;
    const left = Math.max(x0 - r, TRACK_X + 2);
    const spacing = 32;
    const offset = this.reducedMotion ? 0 : (now / (active ? 4 : 10)) % spacing;

    for (const lane of LANES) {
      const cy = this.rowY(lane);
      const top = cy - r;
      ctx.fillStyle = "#000";
      roundRect(ctx, left - 2.5, top - 2.5, x1 - left + r + 5, r * 2 + 5, r + 2.5);
      ctx.fill();
      ctx.fillStyle = "#fff";
      roundRect(ctx, left, top, x1 - left + r, r * 2, r);
      ctx.fill();
      const bump = this.reducedMotion ? 0 : clamp01(1 - (now - this.rollBumpAt[lane]) / 120);
      if (active && !this.reducedMotion) this.bloom(tx, cy, r * (2.4 + 1.5 * bump), ROLL_COLOR, 0.4 + 0.6 * bump);
      ctx.fillStyle = rgba(active ? mix(ROLL_COLOR, [255, 255, 255], 0.15 + 0.45 * bump) : ROLL_COLOR, 1);
      roundRect(ctx, left + 3, top + 3, x1 - left + r - 6, r * 2 - 6, r - 3);
      ctx.fill();
      // Chevrons hint "go fast". Bounded by hand: WKWebView's canvas clip isn't reliable.
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 3;
      for (let bx = left + r - offset; bx < x1; bx += spacing) {
        if (bx < left + r * 0.6) continue;
        ctx.beginPath();
        ctx.moveTo(bx + 5, cy - 6);
        ctx.lineTo(bx, cy);
        ctx.lineTo(bx + 5, cy + 6);
        ctx.stroke();
      }
    }

    if (active || hits > 0) {
      const bump = this.reducedMotion ? 0 : clamp01(1 - (now - Math.max(this.rollBumpAt.f, this.rollBumpAt.j)) / 120);
      const x = Math.max(x0, tx) + r + 10;
      const y = this.height / 2;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.round(20 * (1 + 0.3 * bump))}px -apple-system, system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      const label = hits > 0 ? `×${hits}` : "MASH!";
      ctx.strokeText(label, x, y);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x, y);
    }
  }

  /** A hold's body: a thick bar with the note's black outline and white rim; lit while held. */
  private holdBody(x0: number, x1: number, y: number, color: RGB, alpha: number, held: boolean, now: number): void {
    const { ctx } = this;
    if (x1 <= x0) return;
    const r = NOTE_R - 4;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#000";
    roundRect(ctx, x0, y - r - 2.5, x1 - x0 + r + 2.5, (r + 2.5) * 2, r + 2.5);
    ctx.fill();
    ctx.fillStyle = "#fff";
    roundRect(ctx, x0, y - r, x1 - x0 + r, r * 2, r);
    ctx.fill();
    ctx.fillStyle = rgba(held ? mix(color, [255, 255, 255], 0.25) : mix(color, [0, 0, 0], 0.15), 1);
    roundRect(ctx, x0, y - r + 3, x1 - x0 + r - 3, (r - 3) * 2, r - 3);
    ctx.fill();
    if (held && !this.reducedMotion) {
      this.bloomRect(x0 - r, y - r * 3, x1 - x0 + r * 3, r * 6, color, 0.55 * alpha);
      // Energy flowing into the ring: bright bands sliding toward the head.
      ctx.save();
      roundRect(ctx, x0, y - r + 3, x1 - x0 + r - 3, (r - 3) * 2, r - 3);
      ctx.clip();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      const spacing = 22;
      const offset = (now / 6) % spacing;
      for (let bx = x0 - offset + spacing; bx < x1 + r; bx += spacing) ctx.fillRect(bx, y - r, 6, r * 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private latestPop(lane: Lane): Pop | undefined {
    for (let i = this.pops.length - 1; i >= 0; i--) if (this.pops[i].lane === lane) return this.pops[i];
    return undefined;
  }

  /** Taiko-style note (black outline, thick white rim, shaded face), drawn from a cached sprite. */
  private note(x: number, y: number, r: number, color: RGB, alpha: number): void {
    const sprite = this.noteSprite(color);
    const size = (r + 2.5) * 2;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    this.ctx.globalAlpha = 1;
  }

  private noteSprite(color: RGB): HTMLCanvasElement {
    // Quantise so a palette blend reuses a handful of sprites instead of one per frame.
    const q = color.map((c) => Math.round(c / 6) * 6) as RGB;
    const key = q.join(",");
    let sprite = this.sprites.get(key);
    if (sprite) return sprite;
    const k = SPRITE_SCALE;
    const r = NOTE_R * k;
    const size = Math.ceil((r + 2.5 * k) * 2 * this.dpr);
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = size;
    const c = sprite.getContext("2d")!;
    c.scale(this.dpr, this.dpr);
    const m = size / this.dpr / 2;
    c.fillStyle = "#000";
    c.beginPath();
    c.arc(m, m, r + 2.5 * k, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#fff";
    c.beginPath();
    c.arc(m, m, r, 0, Math.PI * 2);
    c.fill();
    const face = c.createRadialGradient(m - r * 0.3, m - r * 0.35, r * 0.1, m, m, r);
    face.addColorStop(0, rgba(mix(q, [255, 255, 255], 0.35), 1));
    face.addColorStop(1, rgba(q, 1));
    c.fillStyle = face;
    c.beginPath();
    c.arc(m, m, r - 3 * k, 0, Math.PI * 2);
    c.fill();
    if (this.sprites.size > 24) this.sprites.delete(this.sprites.keys().next().value!);
    this.sprites.set(key, sprite);
    return sprite;
  }

  /** Track background, tinted toward its lane colour near the target; cached until colours change. */
  private trackBackground(lane: Lane, glow: RGB, w: number, h: number): HTMLCanvasElement {
    const tint = this.colors[lane];
    const key = [...glow, ...tint].map((c) => Math.round(c / 4)).join(",");
    const cached = this.trackBgs.get(lane);
    if (cached?.key === key) return cached.canvas;
    const canvas = cached?.canvas ?? document.createElement("canvas");
    canvas.width = Math.ceil(w * this.dpr);
    canvas.height = Math.ceil(h * this.dpr);
    const c = canvas.getContext("2d")!;
    c.scale(this.dpr, this.dpr);
    const bg = c.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, rgba(mix(mix(glow, tint, 0.25), [255, 255, 255], 0.08), 1));
    bg.addColorStop(0.35, rgba(mix(glow, [255, 255, 255], 0.06), 1));
    bg.addColorStop(1, rgba(mix(glow, [0, 0, 0], 0.4), 1));
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(0, 0, w, h, RADIUS);
    c.fill();
    this.trackBgs.set(lane, { key, canvas });
    return canvas;
  }

  /** True while effects are still animating, so the loop keeps running after a pause. */
  hasActiveEffects(now: number): boolean {
    const p = this.palette();
    const blending = !close(this.colors.f, hexToRgb(p.f)) || !close(this.colors.j, hexToRgb(p.j)) || !close(this.colors.glow, hexToRgb(p.glow));
    return (
      blending ||
      this.particles.length > 0 ||
      this.pops.length > 0 ||
      now < this.shakeUntil ||
      now - this.milestoneAt < MILESTONE_MS ||
      now - this.dropAt < DROP_MS ||
      now - this.songEndAt < SONG_END_MS ||
      now - Math.max(this.rollBumpAt.f, this.rollBumpAt.j) < 170 ||
      now - this.strayAt.f < 220 ||
      now - this.strayAt.j < 220 ||
      now - this.flash.f < 170 ||
      now - this.flash.j < 170 ||
      now - this.comboBumpAt < 170 ||
      now - this.breakAt < BREAK_MS ||
      Math.abs(this.heat - comboHeat(this.combo)) > 0.01
    );
  }
}

/**
 * Path for the part of a circle that lies right of `minX`. Used instead of a
 * clip region, which WKWebView doesn't reliably apply to these strokes.
 */
function arcRightOf(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, minX: number): void {
  ctx.beginPath();
  if (cx - r >= minX) {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    return;
  }
  const a = Math.acos(Math.max(-1, Math.min(1, (minX - cx) / r)));
  ctx.arc(cx, cy, r, -a, a);
}

/** Fever colour: cycles hue over ~2.4 s. */
function feverColor(now: number): RGB {
  const h = (now / 2400) % 1;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return 255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return mix([f(0), f(8), f(4)], [255, 255, 255], 0.15);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function close(a: RGB, b: RGB): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 3;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp01(a)})`;
}
