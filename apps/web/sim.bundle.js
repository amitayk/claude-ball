// packages/engine/src/constants.ts
function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === "object") deepFreeze(v);
  }
  return Object.freeze(obj);
}
var RULES = deepFreeze({
  field: {
    width: 1050,
    height: 680,
    goalHeight: 200,
    /** Radius of the centre circle; the kickoff exclusion zone. */
    centerRadius: 70
  },
  /** Fixed timestep. 30 ticks per simulated second. */
  dt: 1 / 30,
  /** Match length in simulated seconds. */
  matchSeconds: 90,
  /**
   * At kickoff the conceding team starts with the ball at the centre spot and
   * the other team must stay outside the centre circle. The exclusion lifts as
   * soon as the kicking team kicks or the ball leaves the circle — or after
   * this many seconds, so a team can't stall by sitting on the ball.
   */
  kickoffGraceSeconds: 3,
  playersPerSide: 4,
  /**
   * Each kickoff, every player's start position is nudged by up to this many
   * units on each axis (seeded, so a given seed always produces the same
   * game). Gives matches some variety; set to 0 for identical layouts.
   */
  kickoffJitter: 20,
  player: {
    radius: 12,
    /** Max speed in units/second. */
    maxSpeed: 200,
    /**
     * Acceleration (units/second²): how fast a player's velocity can change.
     * Players ramp up to maxSpeed rather than snapping to it (~maxSpeed/accel
     * seconds from rest), and can't reverse instantly — momentum.
     */
    accel: 900,
    /**
     * Extra cost of changing direction, 0..1. Acceleration is scaled down by up
     * to this fraction as the desired direction opposes current motion, so a
     * sharp turn — worst case a 180° — is harder than building speed in a
     * straight line. 0 = turning is free; 0.5 = reversing has half the accel.
     */
    turnPenalty: 0.5
  },
  ball: {
    radius: 8,
    /** Speed below which the ball is considered stopped. */
    stopSpeed: 4,
    /**
     * Rolling friction as a constant deceleration (units/second²): the ball
     * loses this much speed every second until it stops. Constant decel (rather
     * than a per-tick multiply) means a kick's travel distance scales with the
     * square of its speed — harder kicks go proportionally farther and the ball
     * rolls to a natural stop. Approx stop distance ≈ speed² / (2 · decel):
     * a 340 pass ≈ 290u, a 560 shot ≈ 780u on the 1050-wide pitch.
     */
    deceleration: 200,
    /**
     * Kick speeds. A pass is weighted to arrive at its target (speed derived
     * from the travel distance via the deceleration above), clamped to this
     * range. A shot is always struck at maxKickSpeed for pace. With decel 200,
     * maxKickSpeed 560 lets a kick travel up to ~780 units.
     */
    minKickSpeed: 80,
    maxKickSpeed: 560,
    /**
     * Kick scatter: the executed direction is randomly perturbed by up to this
     * many radians (±), scaled by how hard the ball was struck
     * (speed / maxKickSpeed). So a gentle weighted pass is near-perfect while a
     * full-pace shot or long ball sprays — harder is less accurate. 0 disables.
     * 0.08 rad ≈ 4.6° at max power (~60u sideways over a full-pitch kick).
     */
    maxKickInaccuracy: 0.08
  },
  /** A player controls the ball when within this distance of it. */
  controlDistance: 28,
  /**
   * A ball moving faster than this is "hot" (just passed/shot): it can only be
   * taken by genuine contact (hotCaptureDistance), so passes fly past players
   * near the lane instead of sticking to them. Set above player.maxSpeed (200)
   * so a dribbled ball (carried at the owner's speed) stays controllable.
   */
  hotBallSpeed: 250,
  /** Capture distance for a hot ball: player radius + ball radius = real contact. */
  hotCaptureDistance: 20,
  /**
   * Possession hysteresis: the current owner keeps the ball while it stays
   * within controlDistance * this factor, and a challenger can only steal it by
   * being at least `stealMargin` units closer than the owner. This stops a
   * contested loose ball from strobing between several nearby players.
   */
  possessionRetainFactor: 1.5,
  stealMargin: 6,
  /** Seconds a player must wait between kicks. */
  kickCooldown: 0.35
});

// packages/engine/src/rng.ts
var Rng = class {
  state;
  constructor(seed) {
    this.state = seed >>> 0 || 2654435769;
  }
  /** Uniform float in [0, 1). */
  next() {
    this.state |= 0;
    this.state = this.state + 1831565813 | 0;
    let t = Math.imul(this.state ^ this.state >>> 15, 1 | this.state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  /** Uniform float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }
};

// packages/engine/src/world.ts
var center = () => ({ x: RULES.field.width / 2, y: RULES.field.height / 2 });
function kickoff(rng, kickingSide, prev) {
  const { width, height } = RULES.field;
  const n = RULES.playersPerSide;
  const r = RULES.player.radius;
  const J = RULES.kickoffJitter;
  const c = center();
  const players = [];
  const jitter = (v, lo, hi) => Math.max(lo, Math.min(hi, v + rng.range(-J, J)));
  const ys = Array.from({ length: n }, (_, i) => (i + 1) / (n + 1) * height);
  for (let i = 0; i < n; i++) {
    players.push({
      id: i,
      side: "home",
      pos: { x: jitter(width * 0.25, r, width - r), y: jitter(ys[i], r, height - r) },
      vel: { x: 0, y: 0 },
      kickCooldown: 0
    });
  }
  for (let i = 0; i < n; i++) {
    players.push({
      id: n + i,
      side: "away",
      pos: { x: jitter(width * 0.75, r, width - r), y: jitter(ys[i], r, height - r) },
      vel: { x: 0, y: 0 },
      kickCooldown: 0
    });
  }
  const taker = players.filter((p) => p.side === kickingSide).reduce((best, p) => Math.abs(p.pos.y - c.y) < Math.abs(best.pos.y - c.y) ? p : best);
  taker.pos = { x: c.x, y: c.y };
  taker.vel = { x: 0, y: 0 };
  const tick = prev ? prev.tick : 0;
  return {
    tick,
    players,
    ball: { pos: { ...c }, vel: { x: 0, y: 0 }, ownerId: taker.id, lastTouchedBy: taker.id, lastKick: null },
    score: prev ? { ...prev.score } : { home: 0, away: 0 },
    phase: "kickoff",
    kickoffSide: kickingSide,
    kickoffTick: tick
  };
}
function goalMouth() {
  const { height, goalHeight } = RULES.field;
  return { top: (height - goalHeight) / 2, bottom: (height + goalHeight) / 2 };
}

// packages/engine/src/step.ts
var dt = RULES.dt;
var clampLen = (v, max) => {
  const l = Math.hypot(v.x, v.y);
  return l > max ? { x: v.x / l * max, y: v.y / l * max } : v;
};
var isNum = (n) => typeof n === "number" && Number.isFinite(n);
var isVec = (v) => !!v && typeof v === "object" && isNum(v.x) && isNum(v.y);
var dirTo = (from, to) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
};
function toPlayerView(p, ownerId) {
  return {
    id: p.id,
    side: p.side,
    pos: { x: p.pos.x, y: p.pos.y },
    vel: { x: p.vel.x, y: p.vel.y },
    hasBall: ownerId === p.id
  };
}
function viewFor(world, side) {
  const attackDir = side === "home" ? 1 : -1;
  const teammates = [];
  const opponents = [];
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
      ownerId: world.ball.ownerId
    },
    teammates,
    opponents,
    score: { ...world.score }
  };
}
function resolveOwner(world) {
  const ball = world.ball;
  const distTo = (p) => Math.hypot(p.pos.x - ball.pos.x, p.pos.y - ball.pos.y);
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.y);
  const captureRange = ballSpeed > RULES.hotBallSpeed ? RULES.hotCaptureDistance : RULES.controlDistance;
  let nearest = null;
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
  return nearestD <= captureRange ? nearest.id : null;
}
function applyMovement(p, intent) {
  let desired = { x: 0, y: 0 };
  if (intent) {
    if (intent.kind === "move" && isVec(intent.to)) desired = dirTo(p.pos, intent.to);
    else if (intent.kind === "moveDir" && isVec(intent.dir)) {
      const l = Math.hypot(intent.dir.x, intent.dir.y);
      if (l > 1e-9) desired = { x: intent.dir.x / l, y: intent.dir.y / l };
    }
  }
  const { maxSpeed, accel, turnPenalty } = RULES.player;
  const target = { x: desired.x * maxSpeed, y: desired.y * maxSpeed };
  let a = accel;
  const speed = Math.hypot(p.vel.x, p.vel.y);
  const desiredLen = Math.hypot(desired.x, desired.y);
  if (speed > 1e-6 && desiredLen > 1e-6) {
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
    p.vel = { x: p.vel.x + dvx / dmag * maxDv, y: p.vel.y + dvy / dmag * maxDv };
  }
  p.vel = clampLen(p.vel, maxSpeed);
}
function speedForDistance(dist2) {
  return Math.sqrt(2 * RULES.ball.deceleration * Math.max(0, dist2));
}
function tryKick(world, p, intent, rng) {
  if (!intent || intent.kind !== "pass" && intent.kind !== "shoot") return false;
  if (world.ball.ownerId !== p.id || p.kickCooldown > 0) return false;
  if (!isVec(intent.to)) return false;
  if (intent.kind === "pass" && intent.range !== void 0 && !isNum(intent.range)) return false;
  let d = dirTo(world.ball.pos, intent.to);
  if (d.x === 0 && d.y === 0) return false;
  if (world.phase === "kickoff") {
    const attackDir = p.side === "home" ? 1 : -1;
    if (d.x * attackDir > 0) return false;
  }
  let speed;
  if (intent.kind === "shoot") {
    speed = RULES.ball.maxKickSpeed;
  } else {
    const dist2 = intent.range ?? Math.hypot(intent.to.x - world.ball.pos.x, intent.to.y - world.ball.pos.y);
    speed = Math.max(RULES.ball.minKickSpeed, Math.min(RULES.ball.maxKickSpeed, speedForDistance(dist2)));
  }
  const spread = RULES.ball.maxKickInaccuracy * (speed / RULES.ball.maxKickSpeed);
  if (spread > 0) {
    const a = rng.range(-spread, spread);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    d = { x: d.x * cos - d.y * sin, y: d.x * sin + d.y * cos };
  }
  world.ball.vel = { x: d.x * speed, y: d.y * speed };
  world.ball.ownerId = null;
  world.ball.lastTouchedBy = p.id;
  world.ball.lastKick = intent.kind;
  p.kickCooldown = Math.round(RULES.kickCooldown / dt);
  return true;
}
function integratePlayers(world) {
  const r = RULES.player.radius;
  for (const p of world.players) {
    p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
    p.pos.x = Math.max(r, Math.min(RULES.field.width - r, p.pos.x));
    p.pos.y = Math.max(r, Math.min(RULES.field.height - r, p.pos.y));
    if (p.kickCooldown > 0) p.kickCooldown--;
  }
  for (let i = 0; i < world.players.length; i++) {
    for (let j = i + 1; j < world.players.length; j++) {
      const a = world.players[i];
      const b = world.players[j];
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
function integrateBall(world) {
  const ball = world.ball;
  const { radius } = RULES.ball;
  if (ball.ownerId !== null) {
    const owner = world.players.find((p) => p.id === ball.ownerId);
    const heading = dirTo({ x: 0, y: 0 }, owner.vel);
    const lead = RULES.player.radius + radius + 2;
    ball.pos = { x: owner.pos.x + heading.x * lead, y: owner.pos.y + heading.y * lead };
    ball.vel = { x: owner.vel.x, y: owner.vel.y };
  } else {
    ball.pos = { x: ball.pos.x + ball.vel.x * dt, y: ball.pos.y + ball.vel.y * dt };
    const sp = Math.hypot(ball.vel.x, ball.vel.y);
    const next = sp - RULES.ball.deceleration * dt;
    if (next < RULES.ball.stopSpeed) {
      ball.vel = { x: 0, y: 0 };
    } else {
      ball.vel = { x: ball.vel.x / sp * next, y: ball.vel.y / sp * next };
    }
  }
  const { width, height } = RULES.field;
  const { top, bottom } = goalMouth();
  if (ball.pos.x <= radius) {
    if (ball.pos.y >= top && ball.pos.y <= bottom) return "away";
    ball.pos.x = radius;
    ball.vel.x = Math.abs(ball.vel.x);
  } else if (ball.pos.x >= width - radius) {
    if (ball.pos.y >= top && ball.pos.y <= bottom) return "home";
    ball.pos.x = width - radius;
    ball.vel.x = -Math.abs(ball.vel.x);
  }
  if (ball.pos.y <= radius) {
    ball.pos.y = radius;
    ball.vel.y = Math.abs(ball.vel.y);
  } else if (ball.pos.y >= height - radius) {
    ball.pos.y = height - radius;
    ball.vel.y = -Math.abs(ball.vel.y);
  }
  return null;
}
function step(world, homeIntents, awayIntents, rng) {
  world.ball.ownerId = resolveOwner(world);
  if (world.ball.ownerId !== null) {
    world.ball.lastTouchedBy = world.ball.ownerId;
    world.ball.lastKick = null;
  }
  let kickingSideKicked = false;
  for (const p of world.players) {
    const intents = p.side === "home" ? homeIntents : awayIntents;
    const intent = intents[p.id];
    applyMovement(p, intent);
    const kicked = tryKick(world, p, intent, rng);
    if (kicked && p.side === world.kickoffSide) kickingSideKicked = true;
  }
  if (world.phase === "kickoff" && world.ball.ownerId !== null) {
    const owner = world.players.find((p) => p.id === world.ball.ownerId);
    if (owner && owner.side === world.kickoffSide) {
      const cx = RULES.field.width / 2;
      const cy = RULES.field.height / 2;
      if (Math.hypot(owner.pos.x - cx, owner.pos.y - cy) <= RULES.field.centerRadius) {
        const attackDir = owner.side === "home" ? 1 : -1;
        if (owner.vel.x * attackDir > 0) owner.vel.x = 0;
      }
    }
  }
  integratePlayers(world);
  if (world.phase === "kickoff") enforceKickoffExclusion(world);
  const scorer = integrateBall(world);
  world.tick++;
  if (scorer) {
    world.score[scorer]++;
    const conceding = scorer === "home" ? "away" : "home";
    return kickoff(rng, conceding, world);
  }
  if (world.phase === "kickoff") {
    const cx = RULES.field.width / 2;
    const cy = RULES.field.height / 2;
    const ballOut = Math.hypot(world.ball.pos.x - cx, world.ball.pos.y - cy) > RULES.field.centerRadius;
    const graceOver = world.tick - world.kickoffTick >= Math.round(RULES.kickoffGraceSeconds / dt);
    if (kickingSideKicked || ballOut || graceOver) world.phase = "open";
  }
  return world;
}
function enforceKickoffExclusion(world) {
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
      else p.pos = { x: cx + dx / d * minDist, y: cy + dy / d * minDist };
    }
  }
}

// packages/brain-api/src/vec.ts
var dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// packages/brain-api/src/params.ts
function defaultParams(spec) {
  const out = {};
  if (!spec) return out;
  for (const key of Object.keys(spec)) out[key] = spec[key].default;
  return out;
}
function resolveParams(spec, overrides) {
  const out = defaultParams(spec);
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      const v = overrides[key];
      const s = spec?.[key];
      out[key] = s ? Math.max(s.min, Math.min(s.max, v)) : v;
    }
  }
  return out;
}

// packages/brain-api/src/kickoff.ts
function kickoffBackPass(view) {
  if (view.phase !== "kickoff" || view.kickoffSide !== view.side) return null;
  const carrier = view.teammates.find((t) => t.hasBall);
  if (!carrier) return null;
  let receiver = null;
  for (const t of view.teammates) {
    if (t.id === carrier.id) continue;
    if (!receiver || Math.abs(t.pos.x - view.ownGoalX) < Math.abs(receiver.pos.x - view.ownGoalX)) {
      receiver = t;
    }
  }
  const behindUs = receiver !== null && (receiver.pos.x - carrier.pos.x) * view.attackDir < 0;
  const target = behindUs ? receiver.pos : { x: carrier.pos.x - view.attackDir * 120, y: carrier.pos.y };
  const intents = {};
  for (const t of view.teammates) {
    intents[t.id] = t.id === carrier.id ? { kind: "pass", to: target } : { kind: "idle" };
  }
  return intents;
}

// packages/engine/src/match.ts
function ballMode(world) {
  const ball = world.ball;
  const sideOf = (id) => world.players.find((p) => p.id === id)?.side ?? null;
  if (ball.ownerId !== null) return { mode: "controlled", side: sideOf(ball.ownerId) };
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (ball.lastKick && speed > RULES.hotBallSpeed) {
    return { mode: ball.lastKick === "shoot" ? "shot" : "pass", side: sideOf(ball.lastTouchedBy) };
  }
  return { mode: "loose", side: null };
}
function snapshot(world) {
  const { mode, side } = ballMode(world);
  return {
    t: world.tick,
    ball: { x: round(world.ball.pos.x), y: round(world.ball.pos.y), mode, side },
    players: world.players.map((p) => ({
      id: p.id,
      side: p.side,
      x: round(p.pos.x),
      y: round(p.pos.y),
      ball: world.ball.ownerId === p.id
    })),
    score: { ...world.score },
    phase: world.phase,
    kickoffSide: world.kickoffSide
  };
}
var round = (n) => Math.round(n * 100) / 100;
function safeDecide(brain, world, side, params) {
  try {
    return brain.decide(viewFor(world, side), params) ?? {};
  } catch (err) {
    if (world.tick === 0) {
      console.error(`[${side}] brain threw on tick 0:`, err);
    }
    return {};
  }
}
function runMatch(home, away, opts = {}) {
  const seed = opts.seed ?? 1;
  const ticks = opts.ticks ?? Math.round(RULES.matchSeconds / RULES.dt);
  const homeParams = resolveParams(home.params, opts.homeParams);
  const awayParams = resolveParams(away.params, opts.awayParams);
  const rng = new Rng(seed);
  const openingSide = rng.next() < 0.5 ? "home" : "away";
  let world = kickoff(rng, openingSide);
  const frames = [snapshot(world)];
  const budget = opts.brainBudgetMs;
  let homeMs = 0;
  let awayMs = 0;
  let fault;
  for (let i = 0; i < ticks; i++) {
    let t = performance.now();
    const homeIntents = safeDecide(home, world, "home", homeParams);
    homeMs += performance.now() - t;
    t = performance.now();
    const awayIntents = safeDecide(away, world, "away", awayParams);
    awayMs += performance.now() - t;
    if (budget !== void 0) {
      if (homeMs > budget) fault = { side: "home", reason: `brain exceeded ${budget}ms compute budget` };
      else if (awayMs > budget) fault = { side: "away", reason: `brain exceeded ${budget}ms compute budget` };
      if (fault) break;
    }
    world = step(world, homeIntents, awayIntents, rng);
    frames.push(snapshot(world));
  }
  return {
    meta: {
      seed,
      teams: { home: home.name ?? "home", away: away.name ?? "away" },
      ticks,
      dt: RULES.dt,
      field: { ...RULES.field },
      params: { home: homeParams, away: awayParams },
      ...fault ? { fault } : {}
    },
    score: { ...world.score },
    frames
  };
}

// packages/brains/src/chaser.ts
var chaser = {
  name: "chaser",
  decide(view) {
    const ko = kickoffBackPass(view);
    if (ko) return ko;
    const intents = {};
    const goal = { x: view.targetGoalX, y: view.field.height / 2 };
    for (const me of view.teammates) {
      intents[me.id] = me.hasBall ? { kind: "shoot", to: goal } : { kind: "move", to: view.ball.pos };
    }
    return intents;
  }
};

// packages/brains/src/formation.ts
var formation = {
  name: "formation",
  decide(view) {
    const ko = kickoffBackPass(view);
    if (ko) return ko;
    const intents = {};
    const { width, height } = view.field;
    const goal = { x: view.targetGoalX, y: height / 2 };
    const lanes = view.teammates.map((_, i) => (i + 1) / (view.teammates.length + 1));
    const baseXFractions = [0.1, 0.32, 0.32, 0.6];
    let closest = null;
    let closestD = Infinity;
    for (const t of view.teammates) {
      const d = dist(t.pos, view.ball.pos);
      if (d < closestD) {
        closestD = d;
        closest = t;
      }
    }
    view.teammates.forEach((me, i) => {
      if (me.hasBall) {
        intents[me.id] = withBall(me, view, goal);
        return;
      }
      if (closest && me.id === closest.id) {
        intents[me.id] = { kind: "move", to: view.ball.pos };
        return;
      }
      const fx = baseXFractions[i] ?? 0.4;
      const homeX = view.side === "home" ? fx * width : (1 - fx) * width;
      const laneY = lanes[i] * height;
      const targetY = laneY * 0.5 + view.ball.pos.y * 0.5;
      intents[me.id] = { kind: "move", to: { x: homeX, y: targetY } };
    });
    return intents;
  }
};
function withBall(me, view, goal) {
  const distToGoal = dist(me.pos, goal);
  if (distToGoal < view.field.width * 0.28) {
    return { kind: "shoot", to: goal };
  }
  let bestMate = null;
  let bestAhead = 30;
  for (const t of view.teammates) {
    if (t.id === me.id) continue;
    const ahead = (t.pos.x - me.pos.x) * view.attackDir;
    if (ahead > bestAhead) {
      bestAhead = ahead;
      bestMate = t;
    }
  }
  if (bestMate) return { kind: "pass", to: bestMate.pos };
  return { kind: "move", to: goal };
}

// packages/brains/src/flow.ts
var flow = {
  name: "flow",
  params: {
    shootDistFrac: { default: 0.35, min: 0.1, max: 0.6, step: 0.01, label: "Shoot distance (\xD7width)", help: "Distance from goal (\xD7pitch width) at which it shoots. Higher = shoots from farther out." },
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance", help: "Clearance a pass lane needs from opponents. Higher = lanes count as blocked more easily, so it passes more cautiously." },
    laneIgnoreNear: { default: 35, min: 0, max: 100, step: 1, label: "Ignore opp. nearer than", help: "Opponents this close to the passer are ignored when judging lanes. Higher = attempts passes through more nearby pressure." },
    keeperStandoff: { default: 60, min: 0, max: 300, step: 5, label: "Keeper standoff", help: "How far in front of our goal the keeper sits. Higher = keeper plays farther off its line." },
    enemyCloseDist: { default: 70, min: 0, max: 200, step: 5, label: "Pressure radius", help: "Distance at which an opponent counts as pressuring. Higher = feels pressured from farther away, so it plays safe sooner." },
    playmakerDrop: { default: 90, min: 0, max: 300, step: 5, label: "Playmaker drop", help: "How far behind the ball the playmaker drops. Higher = offers a deeper, safer outlet." },
    forwardPush: { default: 150, min: 0, max: 500, step: 10, label: "Forward push", help: "How far ahead of the ball the forwards run. Higher = pushes the forwards higher up the pitch." },
    channelLeftY: { default: 0.28, min: 0.05, max: 0.5, step: 0.02, label: "Left channel", help: "Vertical lane for the left forward (fraction of height). Higher = positions the left forward lower." },
    channelRightY: { default: 0.72, min: 0.5, max: 0.95, step: 0.02, label: "Right channel", help: "Vertical lane for the right forward (fraction of height). Higher = positions the right forward lower." }
  },
  decide(view, p) {
    const ko = kickoffBackPass(view);
    if (ko) return ko;
    const SHOOT_DIST_FRAC = p.shootDistFrac;
    const LANE_CLEARANCE = p.laneClearance;
    const LANE_IGNORE_NEAR = p.laneIgnoreNear;
    const KEEPER_STANDOFF = p.keeperStandoff;
    const ENEMY_CLOSE_DIST = p.enemyCloseDist;
    const PLAYMAKER_DROP = p.playmakerDrop;
    const FORWARD_PUSH = p.forwardPush;
    const CHANNEL_Y = [p.channelLeftY, p.channelRightY];
    const intents = {};
    const W = view.field.width;
    const H = view.field.height;
    const enemyGoal = { x: view.targetGoalX, y: H / 2 };
    const ownGoalCenter = { x: view.ownGoalX, y: H / 2 };
    const clampX = (x) => Math.max(60, Math.min(W - 60, x));
    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0];
    const playmaker = squad[1];
    const forwards = squad.slice(2);
    const carrier = view.teammates.find((t) => t.hasBall) ?? null;
    const weHaveBall = carrier !== null;
    const laneBlocked = (from, to) => {
      const abx = to.x - from.x;
      const aby = to.y - from.y;
      const len2 = abx * abx + aby * aby;
      const segLen = Math.sqrt(len2);
      return view.opponents.some((o) => {
        let t = len2 > 0 ? ((o.pos.x - from.x) * abx + (o.pos.y - from.y) * aby) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (t * segLen < LANE_IGNORE_NEAR) return false;
        const cx = from.x + abx * t;
        const cy = from.y + aby * t;
        return Math.hypot(o.pos.x - cx, o.pos.y - cy) < LANE_CLEARANCE;
      });
    };
    const pressured = (p2) => view.opponents.some((o) => dist(o.pos, p2) < ENEMY_CLOSE_DIST);
    const RECEIVE_PATH_WIDTH = 110;
    const RECEIVE_MIN_SPEED = 60;
    const ballHeadingToward = (me) => {
      if (view.ball.ownerId !== null) return false;
      if ((view.ball.pos.x - W / 2) * view.attackDir <= 0) return false;
      const bv = view.ball.vel;
      const speed = Math.hypot(bv.x, bv.y);
      if (speed < RECEIVE_MIN_SPEED) return false;
      const rx = me.pos.x - view.ball.pos.x;
      const ry = me.pos.y - view.ball.pos.y;
      if (rx * bv.x + ry * bv.y <= 0) return false;
      if (bv.x * view.attackDir > 1) {
        const tGoal = (view.targetGoalX - view.ball.pos.x) / bv.x;
        const yAtGoal = view.ball.pos.y + bv.y * tGoal;
        if (Math.abs(yAtGoal - H / 2) < view.field.goalHeight / 2) return false;
      }
      const perp = Math.abs(rx * bv.y - ry * bv.x) / speed;
      return perp < RECEIVE_PATH_WIDTH;
    };
    const forwardOutlet = (me) => {
      let best = null;
      let bestD = Infinity;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        const ahead = (t.pos.x - me.pos.x) * view.attackDir;
        if (ahead <= 50 || laneBlocked(me.pos, t.pos)) continue;
        const d = dist(me.pos, t.pos);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    };
    const safeOutlet = (me) => {
      let best = null;
      let bestD = Infinity;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        if (laneBlocked(me.pos, t.pos)) continue;
        const d = dist(me.pos, t.pos);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    };
    const carry = (me) => {
      if (dist(me.pos, enemyGoal) < W * SHOOT_DIST_FRAC && !laneBlocked(me.pos, enemyGoal)) {
        return { kind: "shoot", to: enemyGoal };
      }
      const fwd = forwardOutlet(me);
      if (fwd) return { kind: "pass", to: fwd.pos };
      if (pressured(me.pos)) {
        const safe = safeOutlet(me);
        if (safe) return { kind: "pass", to: safe.pos };
      }
      return { kind: "move", to: enemyGoal };
    };
    const outfield = [playmaker, ...forwards];
    let presser = outfield[0];
    let pressD = Infinity;
    for (const p2 of outfield) {
      const d = dist(p2.pos, view.ball.pos);
      if (d < pressD) {
        pressD = d;
        presser = p2;
      }
    }
    if (keeper.hasBall) {
      const out = safeOutlet(keeper);
      intents[keeper.id] = out ? { kind: "pass", to: out.pos } : carry(keeper);
    } else {
      const d = { x: view.ball.pos.x - ownGoalCenter.x, y: view.ball.pos.y - ownGoalCenter.y };
      const len = Math.hypot(d.x, d.y) || 1;
      intents[keeper.id] = {
        kind: "move",
        to: {
          x: ownGoalCenter.x + d.x / len * KEEPER_STANDOFF,
          y: ownGoalCenter.y + d.y / len * KEEPER_STANDOFF
        }
      };
    }
    if (playmaker.hasBall) {
      intents[playmaker.id] = carry(playmaker);
    } else if (!weHaveBall && presser.id === playmaker.id) {
      intents[playmaker.id] = { kind: "move", to: view.ball.pos };
    } else {
      intents[playmaker.id] = {
        kind: "move",
        to: { x: clampX(view.ball.pos.x - view.attackDir * PLAYMAKER_DROP), y: H / 2 }
      };
    }
    forwards.forEach((me, i) => {
      if (me.hasBall) {
        intents[me.id] = carry(me);
      } else if (ballHeadingToward(me)) {
        intents[me.id] = { kind: "move", to: view.ball.pos };
      } else if (!weHaveBall && presser.id === me.id) {
        intents[me.id] = { kind: "move", to: view.ball.pos };
      } else {
        intents[me.id] = {
          kind: "move",
          to: {
            x: clampX(view.ball.pos.x + view.attackDir * FORWARD_PUSH),
            y: H * (CHANNEL_Y[i] ?? 0.5)
          }
        };
      }
    });
    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  }
};

// packages/brains/src/blitz.ts
var blitz = {
  name: "blitz",
  params: {
    shootDistFrac: { default: 0.45, min: 0.1, max: 0.7, step: 0.01, label: "Shoot distance (\xD7width)", help: "Distance from goal (\xD7pitch width) at which it shoots. Higher = shoots from farther out." },
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance", help: "Clearance a pass lane needs from opponents. Higher = lanes count as blocked more easily, so it passes more cautiously." },
    keeperStandoff: { default: 300, min: 0, max: 400, step: 5, label: "Keeper standoff", help: "How far up the shot line the keeper holds. Higher = keeper steps farther from our goal." },
    strikerGap: { default: 200, min: 50, max: 400, step: 5, label: "Striker gap from goal", help: "How far in front of the enemy goal the striker waits. Higher = striker holds farther from goal." }
  },
  decide(view, p) {
    const ko = kickoffBackPass(view);
    if (ko) return ko;
    const SHOOT_DIST_FRAC = p.shootDistFrac;
    const LANE_CLEARANCE = p.laneClearance;
    const KEEPER_STANDOFF = p.keeperStandoff;
    const STRIKER_GAP = p.strikerGap;
    const intents = {};
    const W = view.field.width;
    const H = view.field.height;
    const enemyGoal = { x: view.targetGoalX, y: H / 2 };
    const ownGoalCenter = { x: view.ownGoalX, y: H / 2 };
    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0];
    const striker = squad[squad.length - 1];
    const pressers = squad.slice(1, squad.length - 1);
    const laneBlocked = (from, to) => {
      const abx = to.x - from.x;
      const aby = to.y - from.y;
      const len2 = abx * abx + aby * aby;
      const segLen = Math.sqrt(len2);
      return view.opponents.some((o) => {
        let t = len2 > 0 ? ((o.pos.x - from.x) * abx + (o.pos.y - from.y) * aby) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (t * segLen < 30) return false;
        const cx = from.x + abx * t;
        const cy = from.y + aby * t;
        return Math.hypot(o.pos.x - cx, o.pos.y - cy) < LANE_CLEARANCE;
      });
    };
    const forwardOutlet = (me) => {
      let best = null;
      let bestAhead = 40;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        const ahead = (t.pos.x - me.pos.x) * view.attackDir;
        if (ahead > bestAhead && !laneBlocked(me.pos, t.pos)) {
          bestAhead = ahead;
          best = t;
        }
      }
      return best;
    };
    const carry = (me) => {
      if (dist(me.pos, enemyGoal) < W * SHOOT_DIST_FRAC && !laneBlocked(me.pos, enemyGoal)) {
        return { kind: "shoot", to: enemyGoal };
      }
      const outlet = forwardOutlet(me);
      if (outlet) {
        const far = dist(me.pos, outlet.pos) > 300;
        return { kind: far ? "shoot" : "pass", to: outlet.pos };
      }
      return { kind: "move", to: enemyGoal };
    };
    if (keeper.hasBall) {
      intents[keeper.id] = !laneBlocked(keeper.pos, enemyGoal) ? { kind: "shoot", to: enemyGoal } : { kind: "shoot", to: striker.pos };
    } else {
      const d = { x: view.ball.pos.x - ownGoalCenter.x, y: view.ball.pos.y - ownGoalCenter.y };
      const len = Math.hypot(d.x, d.y) || 1;
      intents[keeper.id] = {
        kind: "move",
        to: { x: ownGoalCenter.x + d.x / len * KEEPER_STANDOFF, y: ownGoalCenter.y + d.y / len * KEEPER_STANDOFF }
      };
    }
    intents[striker.id] = striker.hasBall ? carry(striker) : { kind: "move", to: { x: view.targetGoalX - view.attackDir * STRIKER_GAP, y: H / 2 } };
    pressers.forEach((me) => {
      intents[me.id] = me.hasBall ? carry(me) : { kind: "move", to: view.ball.pos };
    });
    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  }
};

// packages/brains/src/possession.ts
var possession = {
  name: "possession",
  params: {
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance", help: "Clearance a pass lane needs from opponents. Higher = lanes count as blocked more easily, so it passes more cautiously." },
    laneIgnoreNear: { default: 35, min: 0, max: 100, step: 1, label: "Ignore opp. nearer than", help: "Opponents this close to the passer are ignored when judging lanes. Higher = attempts passes through more nearby pressure." },
    cornerRunSec: { default: 2, min: 0, max: 5, step: 0.1, label: "Corner run time (s)", help: "Seconds the carrier dribbles toward a corner before passing. Higher = holds the ball longer before releasing." },
    cornerInset: { default: 40, min: 10, max: 150, step: 5, label: "Corner inset", help: "How far inside each corner the dribble target sits. Higher = keeps the run farther from the corner." },
    cornerCloseDist: { default: 120, min: 20, max: 400, step: 10, label: "Near-corner = pass now", help: "Distance to its corner at which it passes immediately. Higher = passes sooner instead of running to the corner." },
    wideOpenDist: { default: 150, min: 60, max: 400, step: 10, label: "Wide-open radius", help: "Space a teammate needs to count as wide open. Higher = demands more space before making the early pass." },
    wideOpenMinDist: { default: 150, min: 0, max: 500, step: 10, label: "Wide-open min pass length", help: "Shortest allowed wide-open pass. Higher = only plays longer wide-open passes." },
    finishXFrac: { default: 0.2, min: 0.05, max: 0.5, step: 0.01, label: "Finish zone (\xD7width)", help: "Width fraction by the enemy goal that counts as the finishing zone. Higher = starts shooting from farther out." },
    centralBandFrac: { default: 0.6, min: 0.2, max: 1, step: 0.05, label: "Central band (Y)", help: "Vertical band the carrier centres into before shooting. Higher = will shoot from wider angles (centres less)." },
    defStandoff: { default: 120, min: 20, max: 400, step: 10, label: "Blocker standoff from goal", help: "How far in front of our goal the deepest defender holds. Higher = defends farther up the pitch." },
    shotCornerFrac: { default: 0.8, min: 0, max: 1, step: 0.05, label: "Shot corner (\xD7goal half)", help: "How far toward the post shots aim. Higher = aims closer to the post (more corner, riskier)." }
  },
  decide(view, p) {
    const ko = kickoffBackPass(view);
    if (ko) return ko;
    const LANE_CLEARANCE = p.laneClearance;
    const LANE_IGNORE_NEAR = p.laneIgnoreNear;
    const CORNER_RUN_SEC = p.cornerRunSec;
    const CORNER_INSET = p.cornerInset;
    const CORNER_CLOSE = p.cornerCloseDist;
    const WIDE_OPEN_DIST = p.wideOpenDist;
    const WIDE_OPEN_MIN = p.wideOpenMinDist;
    const FINISH_X_FRAC = p.finishXFrac;
    const CENTRAL_BAND_FRAC = p.centralBandFrac;
    const DEF_STANDOFF = p.defStandoff;
    const SHOT_CORNER_FRAC = p.shotCornerFrac;
    const intents = {};
    const W = view.field.width;
    const H = view.field.height;
    const clampX = (x) => Math.max(20, Math.min(W - 20, x));
    const clampY = (y) => Math.max(20, Math.min(H - 20, y));
    const owner = view.ball.ownerId;
    const ownerIsTeammate = owner != null && view.teammates.some((t) => t.id === owner);
    if (view.tick < lastTick) {
      trackedOwner = null;
      possessionStartTick = view.tick;
      lastOwnerWasTeammate = false;
    }
    lastTick = view.tick;
    if (ownerIsTeammate && owner !== trackedOwner) possessionStartTick = view.tick;
    if (owner != null) lastOwnerWasTeammate = ownerIsTeammate;
    trackedOwner = owner;
    const held = (view.tick - possessionStartTick) * view.dt;
    const ownGoalCenter = { x: view.ownGoalX, y: H / 2 };
    const carrier = view.teammates.find((t) => t.hasBall) ?? null;
    const laneBlocked = (from, to) => {
      const abx = to.x - from.x;
      const aby = to.y - from.y;
      const len2 = abx * abx + aby * aby;
      const segLen = Math.sqrt(len2);
      return view.opponents.some((o) => {
        let t = len2 > 0 ? ((o.pos.x - from.x) * abx + (o.pos.y - from.y) * aby) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (t * segLen < LANE_IGNORE_NEAR) return false;
        const cx = from.x + abx * t;
        const cy = from.y + aby * t;
        return Math.hypot(o.pos.x - cx, o.pos.y - cy) < LANE_CLEARANCE;
      });
    };
    const openness = (pt) => view.opponents.length ? Math.min(...view.opponents.map((o) => dist(o.pos, pt))) : Infinity;
    const corners = [
      { x: CORNER_INSET, y: CORNER_INSET },
      { x: CORNER_INSET, y: H - CORNER_INSET },
      { x: W - CORNER_INSET, y: CORNER_INSET },
      { x: W - CORNER_INSET, y: H - CORNER_INSET }
    ];
    const closestCorner = (pt) => corners.reduce((a, b) => dist(a, pt) <= dist(b, pt) ? a : b);
    const clearOpenTarget = (me) => {
      let best = null;
      let bestScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        if (laneBlocked(me.pos, t.pos)) continue;
        const s = openness(t.pos);
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
      return best;
    };
    const anyOpenTarget = (me) => {
      let best = null;
      let bestScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        const s = openness(t.pos);
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
      return best;
    };
    const wallPassAim = (me) => {
      const C = me.pos;
      let best = null;
      let bestScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        for (const wallY of [0, H]) {
          const mirror = { x: t.pos.x, y: 2 * wallY - t.pos.y };
          const denom = mirror.y - C.y;
          if (Math.abs(denom) < 1e-6) continue;
          const k = (wallY - C.y) / denom;
          if (k <= 0 || k >= 1) continue;
          const bounce = { x: C.x + (mirror.x - C.x) * k, y: wallY };
          if (bounce.x < 0 || bounce.x > W) continue;
          if (laneBlocked(C, bounce) || laneBlocked(bounce, t.pos)) continue;
          const s = openness(t.pos);
          if (s > bestScore) {
            bestScore = s;
            best = { aim: mirror, targetId: t.id };
          }
        }
      }
      return best;
    };
    const wideOpenTarget = (me) => {
      let best = null;
      let bestScore = -1;
      let fwd = null;
      let fwdScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        if (dist(me.pos, t.pos) < WIDE_OPEN_MIN) continue;
        if (laneBlocked(me.pos, t.pos)) continue;
        const s = openness(t.pos);
        if (s < WIDE_OPEN_DIST) continue;
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
        if ((t.pos.x - W / 2) * view.attackDir > 0 && s > fwdScore) {
          fwdScore = s;
          fwd = t;
        }
      }
      return fwd ?? best;
    };
    const passDecision = (me) => {
      const clear = clearOpenTarget(me);
      if (clear) return { aim: clear.pos, targetId: clear.id };
      const wall = wallPassAim(me);
      if (wall) return wall;
      const any = anyOpenTarget(me);
      return any ? { aim: any.pos, targetId: any.id } : null;
    };
    const openFarFrom = (me, from) => {
      const base = Math.atan2(me.pos.y - from.y, me.pos.x - from.x);
      const offs = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2, Math.PI];
      let fallback = null;
      for (const off of offs) {
        const a = base + off;
        const pt = { x: clampX(from.x + Math.cos(a) * 3e3), y: clampY(from.y + Math.sin(a) * 3e3) };
        if (!fallback) fallback = pt;
        if (!laneBlocked(from, pt)) return pt;
      }
      return fallback;
    };
    if (carrier) {
      const inFinishZone = Math.abs(carrier.pos.x - view.targetGoalX) < FINISH_X_FRAC * W;
      if (inFinishZone) {
        const half = CENTRAL_BAND_FRAC / 2 * H;
        const inBand = carrier.pos.y >= H / 2 - half && carrier.pos.y <= H / 2 + half;
        if (inBand) {
          const goalHalf = view.field.goalHeight / 2;
          const farY = carrier.pos.y <= H / 2 ? H / 2 + goalHalf * SHOT_CORNER_FRAC : H / 2 - goalHalf * SHOT_CORNER_FRAC;
          intents[carrier.id] = { kind: "shoot", to: { x: view.targetGoalX, y: farY } };
        } else {
          intents[carrier.id] = { kind: "move", to: { x: carrier.pos.x, y: H / 2 } };
        }
      } else {
        const corner = closestCorner(carrier.pos);
        const wide = wideOpenTarget(carrier);
        const readyToPass = held >= CORNER_RUN_SEC || dist(carrier.pos, corner) < CORNER_CLOSE;
        const decision = wide ? { aim: wide.pos, targetId: wide.id } : readyToPass ? passDecision(carrier) : null;
        if (decision) {
          intents[carrier.id] = { kind: "pass", to: decision.aim };
          lastPassTargetId = decision.targetId;
        } else {
          intents[carrier.id] = { kind: "move", to: corner };
        }
      }
      view.teammates.forEach((me) => {
        if (me.id === carrier.id) return;
        intents[me.id] = { kind: "move", to: openFarFrom(me, carrier.pos) };
      });
    } else if (view.ball.ownerId === null && lastOwnerWasTeammate) {
      const receiver = view.teammates.find((t) => t.id === lastPassTargetId) ?? view.teammates.reduce(
        (a, b) => dist(a.pos, view.ball.pos) <= dist(b.pos, view.ball.pos) ? a : b
      );
      view.teammates.forEach((me) => {
        intents[me.id] = me.id === receiver.id ? { kind: "move", to: view.ball.pos } : { kind: "move", to: openFarFrom(me, view.ball.pos) };
      });
    } else {
      const blocker = view.teammates.reduce(
        (a, b) => dist(a.pos, ownGoalCenter) <= dist(b.pos, ownGoalCenter) ? a : b
      );
      const holder = view.opponents.find((o) => o.id === view.ball.ownerId);
      const chaseTarget = holder ? holder.pos : view.ball.pos;
      const bv = view.ball.vel;
      const shotAtUs = view.ball.ownerId === null && Math.hypot(bv.x, bv.y) > 40 && (view.ownGoalX - view.ball.pos.x) * bv.x > 0;
      view.teammates.forEach((me) => {
        if (me.id === blocker.id) {
          if (shotAtUs) {
            intents[me.id] = { kind: "move", to: view.ball.pos };
          } else {
            const dx = view.ball.pos.x - ownGoalCenter.x;
            const dy = view.ball.pos.y - ownGoalCenter.y;
            const len = Math.hypot(dx, dy) || 1;
            intents[me.id] = {
              kind: "move",
              to: {
                x: ownGoalCenter.x + dx / len * DEF_STANDOFF,
                y: ownGoalCenter.y + dy / len * DEF_STANDOFF
              }
            };
          }
        } else {
          intents[me.id] = { kind: "move", to: chaseTarget };
        }
      });
    }
    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  }
};
var trackedOwner = null;
var possessionStartTick = 0;
var lastTick = -1;
var lastOwnerWasTeammate = false;
var lastPassTargetId = null;

// packages/brains/src/index.ts
var catalog = [
  { name: "blitz", brain: blitz, skill: 92, blurb: "Keeper launches to a high striker; two pressers hunt." },
  { name: "chaser", brain: chaser, skill: 83, blurb: "Everyone chases the ball; whoever has it shoots." },
  { name: "formation", brain: formation, skill: 50, blurb: "Holds a 4-player shape; the nearest player presses." },
  { name: "flow", brain: flow, skill: 19, blurb: "Keeper, deep playmaker, two channel runners; passes forward." },
  { name: "possession", brain: possession, skill: 5, blurb: "Keeps the ball, works to the corners, rarely rushes." }
];
var brains = Object.fromEntries(
  catalog.map((e) => [e.name, e.brain])
);

// apps/web/_sim-src.ts
var houseBots = Object.fromEntries(
  catalog.map((e) => [e.name, { brain: e.brain, params: e.brain.params ?? null }])
);
export {
  houseBots,
  runMatch
};
