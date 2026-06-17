import type { Side, Vec2 } from "@kr/brain-api";
import { RULES } from "./constants.js";
import type { Rng } from "./rng.js";

/** Internal mutable player state (the engine's source of truth). */
export interface PlayerState {
  id: number;
  side: Side;
  pos: Vec2;
  vel: Vec2;
  /** Ticks remaining before this player may kick again. */
  kickCooldown: number;
}

export interface BallState {
  pos: Vec2;
  vel: Vec2;
  ownerId: number | null;
  /** Last player to control or kick the ball (for deriving the ball's mode). */
  lastTouchedBy: number | null;
  /** The kind of the kick that released the ball, cleared once controlled. */
  lastKick: "pass" | "shoot" | null;
}

export interface WorldState {
  tick: number;
  players: PlayerState[];
  ball: BallState;
  score: { home: number; away: number };
}

const center = (): Vec2 => ({ x: RULES.field.width / 2, y: RULES.field.height / 2 });

/**
 * Build a kickoff layout. Home occupies the left half, away the right,
 * mirrored. Player ids: home = 0..N-1, away = N..2N-1.
 *
 * Start positions are jittered by up to RULES.kickoffJitter on each axis using
 * `rng`, so each game (and each post-goal restart) varies a little while
 * staying fully deterministic for a given seed.
 */
export function kickoff(rng: Rng, prev?: WorldState): WorldState {
  const { width, height } = RULES.field;
  const n = RULES.playersPerSide;
  const r = RULES.player.radius;
  const J = RULES.kickoffJitter;
  const players: PlayerState[] = [];

  const jitter = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v + rng.range(-J, J)));

  // Spread players vertically across one quarter / three-quarter x lines.
  const ys = Array.from({ length: n }, (_, i) => ((i + 1) / (n + 1)) * height);

  for (let i = 0; i < n; i++) {
    players.push({
      id: i,
      side: "home",
      pos: { x: jitter(width * 0.25, r, width - r), y: jitter(ys[i]!, r, height - r) },
      vel: { x: 0, y: 0 },
      kickCooldown: 0,
    });
  }
  for (let i = 0; i < n; i++) {
    players.push({
      id: n + i,
      side: "away",
      pos: { x: jitter(width * 0.75, r, width - r), y: jitter(ys[i]!, r, height - r) },
      vel: { x: 0, y: 0 },
      kickCooldown: 0,
    });
  }

  return {
    tick: prev ? prev.tick : 0,
    players,
    ball: { pos: center(), vel: { x: 0, y: 0 }, ownerId: null, lastTouchedBy: null, lastKick: null },
    score: prev ? { ...prev.score } : { home: 0, away: 0 },
  };
}

/** y-range of the goal mouth, shared by both goals. */
export function goalMouth(): { top: number; bottom: number } {
  const { height, goalHeight } = RULES.field;
  return { top: (height - goalHeight) / 2, bottom: (height + goalHeight) / 2 };
}
