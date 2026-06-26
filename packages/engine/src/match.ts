import type { Brain, Metrics, ParamValues, Side, TeamIntent } from "@claude-ball/brain-api";
import { collectMetrics, resolveParams } from "@claude-ball/brain-api";
import { RULES } from "./constants.js";
import { Rng } from "./rng.js";
import { kickoff, type WorldState } from "./world.js";
import { step, viewFor } from "./step.js";

/**
 * What the ball is doing this tick:
 *   controlled — a player has it
 *   pass/shot  — released by a kick and still travelling fast
 *   loose      — uncontrolled and slow enough to be contested by anyone
 */
export type BallMode = "controlled" | "pass" | "shot" | "loose";

export interface ReplayFrame {
  t: number;
  ball: { x: number; y: number; mode: BallMode; side: "home" | "away" | null };
  players: { id: number; side: "home" | "away"; x: number; y: number; ball: boolean }[];
  score: { home: number; away: number };
  phase: "kickoff" | "open";
  kickoffSide: "home" | "away";
}

export interface MatchResult {
  meta: {
    seed: number;
    teams: { home: string; away: string };
    ticks: number;
    dt: number;
    field: { width: number; height: number; goalHeight: number };
    /** Resolved param values each side played with. */
    params: { home: ParamValues; away: ParamValues };
    /** Set if a brain was stopped for exceeding its compute budget. */
    fault?: { side: "home" | "away"; reason: string };
  };
  score: { home: number; away: number };
  frames: ReplayFrame[];
  /**
   * Per-frame live metrics reported by the HOME brain via `reportMetrics()`,
   * aligned 1:1 with `frames` (null where nothing was reported). Used by the
   * coach workbench's "Your metrics" panel; ignored elsewhere.
   */
  homeMetrics: (Metrics | null)[];
}

function ballMode(world: WorldState): { mode: BallMode; side: "home" | "away" | null } {
  const ball = world.ball;
  const sideOf = (id: number | null) => world.players.find((p) => p.id === id)?.side ?? null;
  if (ball.ownerId !== null) return { mode: "controlled", side: sideOf(ball.ownerId) };
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (ball.lastKick && speed > RULES.hotBallSpeed) {
    return { mode: ball.lastKick === "shoot" ? "shot" : "pass", side: sideOf(ball.lastTouchedBy) };
  }
  return { mode: "loose", side: null };
}

function snapshot(world: WorldState): ReplayFrame {
  const { mode, side } = ballMode(world);
  return {
    t: world.tick,
    ball: { x: round(world.ball.pos.x), y: round(world.ball.pos.y), mode, side },
    players: world.players.map((p) => ({
      id: p.id,
      side: p.side,
      x: round(p.pos.x),
      y: round(p.pos.y),
      ball: world.ball.ownerId === p.id,
    })),
    score: { ...world.score },
    phase: world.phase,
    kickoffSide: world.kickoffSide,
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Call a brain defensively: any throw becomes "no intents" (all idle). */
function safeDecide(
  brain: Brain,
  world: WorldState,
  side: "home" | "away",
  params: ParamValues,
): TeamIntent {
  try {
    return brain.decide(viewFor(world, side), params) ?? {};
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
  /** Param overrides merged over each brain's declared defaults. */
  homeParams?: ParamValues;
  awayParams?: ParamValues;
  /**
   * Optional cap on cumulative `decide()` wall-time per brain for the whole
   * match (ms). If a brain exceeds it the match stops and `meta.fault` is set.
   * Guards against slow/runaway brains. Leave unset for pure, timing-free runs
   * (e.g. reproducible CLI matches). Note: a brain that hangs forever in a
   * single tick can't be interrupted in-process — that needs the Phase-4 worker
   * sandbox; this only catches brains that are slow but keep returning.
   */
  brainBudgetMs?: number;
}

/** Run a full deterministic match between two brains and record a replay. */
export function runMatch(home: Brain, away: Brain, opts: RunOptions = {}): MatchResult {
  const seed = opts.seed ?? 1;
  const ticks = opts.ticks ?? Math.round(RULES.matchSeconds / RULES.dt);

  const homeParams = resolveParams(home.params, opts.homeParams);
  const awayParams = resolveParams(away.params, opts.awayParams);

  const rng = new Rng(seed);
  // The opening kickoff side is decided by the seed; thereafter the conceding
  // team takes it (handled in step()).
  const openingSide: Side = rng.next() < 0.5 ? "home" : "away";
  let world = kickoff(rng, openingSide);
  const frames: ReplayFrame[] = [snapshot(world)];
  // homeMetrics[i] is whatever the home brain reported on the tick that produced
  // frames[i] (null for the opening snapshot). Kept in lockstep with `frames`.
  const homeMetrics: (Metrics | null)[] = [null];

  const budget = opts.brainBudgetMs;
  let homeMs = 0;
  let awayMs = 0;
  let fault: { side: "home" | "away"; reason: string } | undefined;

  for (let i = 0; i < ticks; i++) {
    let t = performance.now();
    const homeIntents = safeDecide(home, world, "home", homeParams);
    homeMs += performance.now() - t;
    // Grab the home brain's reported metrics for this tick (clears the channel).
    const tickMetrics = collectMetrics();
    t = performance.now();
    const awayIntents = safeDecide(away, world, "away", awayParams);
    awayMs += performance.now() - t;
    collectMetrics(); // discard any away report so it can't bleed into next tick

    if (budget !== undefined) {
      if (homeMs > budget) fault = { side: "home", reason: `brain exceeded ${budget}ms compute budget` };
      else if (awayMs > budget) fault = { side: "away", reason: `brain exceeded ${budget}ms compute budget` };
      if (fault) break;
    }

    world = step(world, homeIntents, awayIntents, rng);
    frames.push(snapshot(world));
    homeMetrics.push(tickMetrics);
  }

  return {
    meta: {
      seed,
      teams: { home: home.name ?? "home", away: away.name ?? "away" },
      ticks,
      dt: RULES.dt,
      field: { ...RULES.field },
      params: { home: homeParams, away: awayParams },
      ...(fault ? { fault } : {}),
    },
    score: { ...world.score },
    frames,
    homeMetrics,
  };
}
