import type { Side, Vec2 } from "@kr/brain-api";
import { RULES } from "./constants.js";

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
 */
export function kickoff(prev?: WorldState): WorldState {
  const { width, height, goalHeight } = RULES.field;
  const n = RULES.playersPerSide;
  const players: PlayerState[] = [];

  // Spread players vertically across one quarter / three-quarter x lines.
  const ys = Array.from({ length: n }, (_, i) => ((i + 1) / (n + 1)) * height);

  for (let i = 0; i < n; i++) {
    players.push({
      id: i,
      side: "home",
      pos: { x: width * 0.25, y: ys[i]! },
      vel: { x: 0, y: 0 },
      kickCooldown: 0,
    });
  }
  for (let i = 0; i < n; i++) {
    players.push({
      id: n + i,
      side: "away",
      pos: { x: width * 0.75, y: ys[i]! },
      vel: { x: 0, y: 0 },
      kickCooldown: 0,
    });
  }

  return {
    tick: prev ? prev.tick : 0,
    players,
    ball: { pos: center(), vel: { x: 0, y: 0 }, ownerId: null },
    score: prev ? { ...prev.score } : { home: 0, away: 0 },
  };
}

/** y-range of the goal mouth, shared by both goals. */
export function goalMouth(): { top: number; bottom: number } {
  const { height, goalHeight } = RULES.field;
  return { top: (height - goalHeight) / 2, bottom: (height + goalHeight) / 2 };
}
