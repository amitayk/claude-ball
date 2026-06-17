import type { Intent, PlayerView, Side, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { RULES } from "./constants.js";
import type { Rng } from "./rng.js";
import { goalMouth, kickoff, type PlayerState, type WorldState } from "./world.js";

const dt = RULES.dt;

const clampLen = (v: Vec2, max: number): Vec2 => {
  const l = Math.hypot(v.x, v.y);
  return l > max ? { x: (v.x / l) * max, y: (v.y / l) * max } : v;
};
const dirTo = (from: Vec2, to: Vec2): Vec2 => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
};

/** Read-only view of one player, frozen so brains can't mutate engine state. */
function toPlayerView(p: PlayerState, ownerId: number | null): PlayerView {
  return {
    id: p.id,
    side: p.side,
    pos: { x: p.pos.x, y: p.pos.y },
    vel: { x: p.vel.x, y: p.vel.y },
    hasBall: ownerId === p.id,
  };
}

/** Build the per-side WorldView passed to a brain. */
export function viewFor(world: WorldState, side: Side): WorldView {
  const attackDir: 1 | -1 = side === "home" ? 1 : -1;
  const teammates: PlayerView[] = [];
  const opponents: PlayerView[] = [];
  for (const p of world.players) {
    (p.side === side ? teammates : opponents).push(toPlayerView(p, world.ball.ownerId));
  }
  return {
    tick: world.tick,
    dt,
    field: { ...RULES.field },
    side,
    phase: world.phase,
    kickoffSide: world.kickoffSide,
    attackDir,
    targetGoalX: side === "home" ? RULES.field.width : 0,
    ownGoalX: side === "home" ? 0 : RULES.field.width,
    ball: {
      pos: { x: world.ball.pos.x, y: world.ball.pos.y },
      vel: { x: world.ball.vel.x, y: world.ball.vel.y },
      ownerId: world.ball.ownerId,
    },
    teammates,
    opponents,
    score: { ...world.score },
  };
}

/** Resolve which player (if any) controls the ball: nearest within range.
 * Players still in kick cooldown can't take possession, so a player who just
 * passed/shot doesn't instantly re-acquire his own kick. */
function resolveOwner(world: WorldState): number | null {
  const ball = world.ball;
  const distTo = (p: PlayerState) => Math.hypot(p.pos.x - ball.pos.x, p.pos.y - ball.pos.y);

  // A hot (recently kicked) ball needs genuine contact to be controlled; a
  // cooled (slow) ball can be picked up at the normal range.
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.y);
  const captureRange =
    ballSpeed > RULES.hotBallSpeed ? RULES.hotCaptureDistance : RULES.controlDistance;

  // Nearest eligible (not in kick cooldown) player and its distance.
  let nearest: PlayerState | null = null;
  let nearestD = Infinity;
  for (const p of world.players) {
    if (p.kickCooldown > 0) continue;
    const d = distTo(p);
    if (d < nearestD) {
      nearestD = d;
      nearest = p;
    }
  }
  if (!nearest) return null;

  // Possession hysteresis: if there's a current owner still in range, they keep
  // the ball unless a challenger is clearly closer — no per-tick strobing.
  if (ball.ownerId !== null) {
    const owner = world.players.find((p) => p.id === ball.ownerId);
    if (owner && owner.kickCooldown === 0) {
      const ownerD = distTo(owner);
      if (ownerD <= RULES.controlDistance * RULES.possessionRetainFactor) {
        const stolen = nearest.id !== owner.id && nearestD < ownerD - RULES.stealMargin;
        return stolen ? nearest.id : owner.id;
      }
    }
  }

  // No retaining owner: the nearest player takes it if within capture range.
  return nearestD <= captureRange ? nearest.id : null;
}

function applyMovement(p: PlayerState, intent: Intent | undefined): void {
  let desired: Vec2 = { x: 0, y: 0 };
  if (intent) {
    if (intent.kind === "move") desired = dirTo(p.pos, intent.to);
    else if (intent.kind === "moveDir") {
      const l = Math.hypot(intent.dir.x, intent.dir.y);
      if (l > 1e-9) desired = { x: intent.dir.x / l, y: intent.dir.y / l };
    }
  }

  const { maxSpeed, accel, turnPenalty } = RULES.player;
  // Target velocity for this intent (zero when idle → coast to a stop).
  const target = { x: desired.x * maxSpeed, y: desired.y * maxSpeed };

  // Steer the current velocity toward the target, capped by acceleration. This
  // gives momentum: you ramp up to speed and can't flip direction instantly.
  let a = accel;
  const speed = Math.hypot(p.vel.x, p.vel.y);
  const desiredLen = Math.hypot(desired.x, desired.y);
  if (speed > 1e-6 && desiredLen > 1e-6) {
    // align = cos(angle) between current motion and desired heading: +1 same
    // direction, -1 a full reversal. Reduce acceleration as we turn against it.
    const align = (p.vel.x * desired.x + p.vel.y * desired.y) / speed;
    a *= 1 - turnPenalty * ((1 - align) / 2);
  }
  const maxDv = a * dt;

  const dvx = target.x - p.vel.x;
  const dvy = target.y - p.vel.y;
  const dmag = Math.hypot(dvx, dvy);
  if (dmag <= maxDv || dmag < 1e-9) {
    p.vel = target;
  } else {
    p.vel = { x: p.vel.x + (dvx / dmag) * maxDv, y: p.vel.y + (dvy / dmag) * maxDv };
  }
  p.vel = clampLen(p.vel, maxSpeed);
}

/** Speed needed for a freely-rolling ball to travel `dist` before stopping. */
function speedForDistance(dist: number): number {
  return Math.sqrt(2 * RULES.ball.deceleration * Math.max(0, dist));
}

function tryKick(world: WorldState, p: PlayerState, intent: Intent | undefined): boolean {
  if (!intent || (intent.kind !== "pass" && intent.kind !== "shoot")) return false;
  if (world.ball.ownerId !== p.id || p.kickCooldown > 0) return false;
  const d = dirTo(world.ball.pos, intent.to);
  if (d.x === 0 && d.y === 0) return false; // kicking at our own position: no-op

  // Kickoff rule: the kicking team must play the ball back. A kick toward the
  // enemy half is illegal during the kickoff phase and is ignored — the brain
  // must aim backward (or sideways), and only a legal backward kick opens play.
  if (world.phase === "kickoff") {
    const attackDir = p.side === "home" ? 1 : -1;
    if (d.x * attackDir > 0) return false;
  }

  let speed: number;
  if (intent.kind === "shoot") {
    // A shot is always struck for pace.
    speed = RULES.ball.maxKickSpeed;
  } else {
    // A pass is weighted to come to rest at `to`, or to travel `range` if the
    // brain overrode the distance. Clamp to the kick speed range.
    const dist = intent.range ?? Math.hypot(intent.to.x - world.ball.pos.x, intent.to.y - world.ball.pos.y);
    speed = Math.max(RULES.ball.minKickSpeed, Math.min(RULES.ball.maxKickSpeed, speedForDistance(dist)));
  }
  world.ball.vel = { x: d.x * speed, y: d.y * speed };
  world.ball.ownerId = null;
  world.ball.lastTouchedBy = p.id;
  world.ball.lastKick = intent.kind;
  p.kickCooldown = Math.round(RULES.kickCooldown / dt);
  return true;
}

function integratePlayers(world: WorldState): void {
  const r = RULES.player.radius;
  for (const p of world.players) {
    p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
    p.pos.x = Math.max(r, Math.min(RULES.field.width - r, p.pos.x));
    p.pos.y = Math.max(r, Math.min(RULES.field.height - r, p.pos.y));
    if (p.kickCooldown > 0) p.kickCooldown--;
  }
  // Soft separation so players don't perfectly overlap.
  for (let i = 0; i < world.players.length; i++) {
    for (let j = i + 1; j < world.players.length; j++) {
      const a = world.players[i]!;
      const b = world.players[j]!;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      const min = r * 2;
      if (d > 1e-6 && d < min) {
        const push = (min - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.pos.x -= nx * push;
        a.pos.y -= ny * push;
        b.pos.x += nx * push;
        b.pos.y += ny * push;
      }
    }
  }
}

/** Returns the side that scored this tick, or null. */
function integrateBall(world: WorldState): Side | null {
  const ball = world.ball;
  const { radius } = RULES.ball;

  if (ball.ownerId !== null) {
    // Dribble: ball is carried just ahead of the owner in its travel direction.
    const owner = world.players.find((p) => p.id === ball.ownerId)!;
    const heading = dirTo({ x: 0, y: 0 }, owner.vel);
    const lead = RULES.player.radius + radius + 2;
    ball.pos = { x: owner.pos.x + heading.x * lead, y: owner.pos.y + heading.y * lead };
    ball.vel = { x: owner.vel.x, y: owner.vel.y };
  } else {
    ball.pos = { x: ball.pos.x + ball.vel.x * dt, y: ball.pos.y + ball.vel.y * dt };
    // Constant rolling deceleration: shave a fixed amount of speed per tick.
    const sp = Math.hypot(ball.vel.x, ball.vel.y);
    const next = sp - RULES.ball.deceleration * dt;
    if (next < RULES.ball.stopSpeed) {
      ball.vel = { x: 0, y: 0 };
    } else {
      ball.vel = { x: (ball.vel.x / sp) * next, y: (ball.vel.y / sp) * next };
    }
  }

  const { width, height } = RULES.field;
  const { top, bottom } = goalMouth();

  // Goal check (only meaningful when the ball crosses a goal line within the mouth).
  if (ball.pos.x <= radius) {
    if (ball.pos.y >= top && ball.pos.y <= bottom) return "away"; // scored in home's goal
    ball.pos.x = radius;
    ball.vel.x = Math.abs(ball.vel.x);
  } else if (ball.pos.x >= width - radius) {
    if (ball.pos.y >= top && ball.pos.y <= bottom) return "home";
    ball.pos.x = width - radius;
    ball.vel.x = -Math.abs(ball.vel.x);
  }
  // Top/bottom walls bounce.
  if (ball.pos.y <= radius) {
    ball.pos.y = radius;
    ball.vel.y = Math.abs(ball.vel.y);
  } else if (ball.pos.y >= height - radius) {
    ball.pos.y = height - radius;
    ball.vel.y = -Math.abs(ball.vel.y);
  }
  return null;
}

/**
 * Advance the world one tick given each team's intents. Mutates and returns
 * `world`. On a goal, the score is updated and the field reset to kickoff.
 */
export function step(
  world: WorldState,
  homeIntents: TeamIntent,
  awayIntents: TeamIntent,
  rng: Rng,
): WorldState {
  // 1. Determine possession before acting.
  world.ball.ownerId = resolveOwner(world);
  if (world.ball.ownerId !== null) {
    // Controlled: this player is now the last toucher; the ball is no longer
    // "in flight" from a prior kick.
    world.ball.lastTouchedBy = world.ball.ownerId;
    world.ball.lastKick = null;
  }

  // 2. Apply movement + kicks. Track whether the kicking team has taken its kick.
  let kickingSideKicked = false;
  for (const p of world.players) {
    const intents = p.side === "home" ? homeIntents : awayIntents;
    const intent = intents[p.id];
    applyMovement(p, intent);
    const kicked = tryKick(world, p, intent);
    if (kicked && p.side === world.kickoffSide) kickingSideKicked = true;
  }

  // 3. Integrate physics.
  integratePlayers(world);
  if (world.phase === "kickoff") enforceKickoffExclusion(world);
  const scorer = integrateBall(world);

  world.tick++;

  if (scorer) {
    world.score[scorer]++;
    // The conceding team takes the next kickoff.
    const conceding: Side = scorer === "home" ? "away" : "home";
    return kickoff(rng, conceding, world);
  }

  // 4. Lift the kickoff exclusion once the ball is genuinely in play.
  if (world.phase === "kickoff") {
    const cx = RULES.field.width / 2;
    const cy = RULES.field.height / 2;
    const ballOut = Math.hypot(world.ball.pos.x - cx, world.ball.pos.y - cy) > RULES.field.centerRadius;
    const graceOver = world.tick - world.kickoffTick >= Math.round(RULES.kickoffGraceSeconds / dt);
    if (kickingSideKicked || ballOut || graceOver) world.phase = "open";
  }
  return world;
}

/** Hold the non-kicking team's players outside the centre circle at kickoff. */
function enforceKickoffExclusion(world: WorldState): void {
  const cx = RULES.field.width / 2;
  const cy = RULES.field.height / 2;
  const minDist = RULES.field.centerRadius + RULES.player.radius;
  for (const p of world.players) {
    if (p.side === world.kickoffSide) continue;
    const dx = p.pos.x - cx;
    const dy = p.pos.y - cy;
    const d = Math.hypot(dx, dy);
    if (d < minDist) {
      if (d < 1e-6) p.pos = { x: cx + minDist, y: cy };
      else p.pos = { x: cx + (dx / d) * minDist, y: cy + (dy / d) * minDist };
    }
  }
}
