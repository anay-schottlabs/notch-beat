/** Monotonic millisecond clock. Judgment timing must come from here, never from render or CSS timing. */
export interface Clock {
  now(): number;
}

export const performanceClock: Clock = {
  now: () => performance.now(),
};

/** Deterministic clock for tests and simulations. */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
