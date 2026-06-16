/**
 * Seeded deterministic PRNG (mulberry32). Brains must NOT use Math.random;
 * all randomness in a match flows through a seeded instance so replays are
 * reproducible from (seed, brainA, brainB) alone.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid a zero state, which would stick at 0.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}
