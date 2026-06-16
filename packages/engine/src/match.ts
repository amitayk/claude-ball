import type { Brain, TeamIntent } from "@kr/brain-api";
import { RULES } from "./constants.js";
import { kickoff, type WorldState } from "./world.js";
import { step, viewFor } from "./step.js";

export interface ReplayFrame {
  t: number;
  ball: { x: number; y: number };
  players: { id: number; side: "home" | "away"; x: number; y: number; ball: boolean }[];
  score: { home: number; away: number };
}

export interface MatchResult {
  meta: {
    seed: number;
    teams: { home: string; away: string };
    ticks: number;
    dt: number;
    field: { width: number; height: number; goalHeight: number };
  };
  score: { home: number; away: number };
  frames: ReplayFrame[];
}

function snapshot(world: WorldState): ReplayFrame {
  return {
    t: world.tick,
    ball: { x: round(world.ball.pos.x), y: round(world.ball.pos.y) },
    players: world.players.map((p) => ({
      id: p.id,
      side: p.side,
      x: round(p.pos.x),
      y: round(p.pos.y),
      ball: world.ball.ownerId === p.id,
    })),
    score: { ...world.score },
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Call a brain defensively: any throw becomes "no intents" (all idle). */
function safeDecide(brain: Brain, world: WorldState, side: "home" | "away"): TeamIntent {
  try {
    return brain.decide(viewFor(world, side)) ?? {};
  } catch (err) {
    if (world.tick === 0) {
      console.error(`[${side}] brain threw on tick 0:`, err);
    }
    return {};
  }
}

export interface RunOptions {
  seed?: number;
  ticks?: number;
}

/** Run a full deterministic match between two brains and record a replay. */
export function runMatch(home: Brain, away: Brain, opts: RunOptions = {}): MatchResult {
  const seed = opts.seed ?? 1;
  const ticks = opts.ticks ?? Math.round(RULES.matchSeconds / RULES.dt);

  let world = kickoff();
  const frames: ReplayFrame[] = [snapshot(world)];

  for (let i = 0; i < ticks; i++) {
    const homeIntents = safeDecide(home, world, "home");
    const awayIntents = safeDecide(away, world, "away");
    world = step(world, homeIntents, awayIntents);
    frames.push(snapshot(world));
  }

  return {
    meta: {
      seed,
      teams: { home: home.name ?? "home", away: away.name ?? "away" },
      ticks,
      dt: RULES.dt,
      field: { ...RULES.field },
    },
    score: { ...world.score },
    frames,
  };
}
