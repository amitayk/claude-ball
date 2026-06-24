import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@claude-ball/brain-api";
import { dist, kickoffBackPass } from "@claude-ball/brain-api";

/**
 * TACTIC ("comet") — a direct long-ball counter-puncher with flair.
 *
 * Comet refuses to grind midfield. A sweeper-keeper (slot0) and a deep
 * distributor (slot1) sit back, guard the mouth, soak pressure and man-mark the
 * enemy outlet; the instant they win the ball they rake a long DIAGONAL switch
 * to one of two fast channel runners (slot2 high-wide on the top flank, slot3
 * on the bottom) camped high and wide on the far side. The runners attack
 * vertically and, the moment one sees the open mouth, unleash a long-range
 * thunderbolt — or, if a marker sits in the lane, bank a WALL PASS off the near
 * sideline to the mirror image of the other runner to spring a 2-on-0.
 *
 * Defensively it does one job ruthlessly: the keeper guards the mouth on a 70u
 * arc (eating chaser's central shots, denying blitz's empty-net launches) and
 * the distributor man-marks the enemy's highest forward (smothering blitz's
 * parked striker) so the long ball is always Comet's, never theirs. It never
 * commits more than two men behind the ball, so the 2-runner counter is always
 * loaded.
 *
 * The numbers below are tunable live from the coach control panel (params).
 */
export const comet: Brain = {
  name: "comet",
  params: {
    launchThreshold: {
      default: 0.55,
      min: 0,
      max: 1,
      step: 0.05,
      label: "Launch threshold",
      help: "How readily the keeper/distributor goes long instead of building short. Higher = launches the diagonal sooner (needs less of an upfield gap), so play is more direct.",
    },
    runnerDepth: {
      default: 0.55,
      min: 0,
      max: 1,
      step: 0.05,
      label: "Runner depth",
      help: "How high up the pitch the two channel runners camp. Higher = runners hold closer to the enemy goal, making the counter more direct and vertical.",
    },
    shotRange: {
      default: 0.55,
      min: 0.15,
      max: 0.7,
      step: 0.01,
      label: "Shot range (×width)",
      help: "Distance from goal (as a fraction of pitch width) inside which runners attempt long shots. Higher = crazier, longer-range thunderbolts (more spectacle, lower accuracy).",
    },
    wallPassBias: {
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      label: "Wall-pass bias",
      help: "Preference for banking the ball off a sideline when the straight lane is blocked. Higher = uses the signature wall pass more often instead of carrying or feeding short.",
    },
    markTightness: {
      default: 0.7,
      min: 0,
      max: 1,
      step: 0.05,
      label: "Outlet mark tightness",
      help: "How aggressively the distributor man-marks the enemy's high striker. Higher = sits tighter/goal-side to fully deny their long ball (less help building our own attack).",
    },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const LAUNCH = p.launchThreshold!;
    const RUNNER_DEPTH = p.runnerDepth!;
    const SHOT_RANGE = p.shotRange!;
    const WALL_BIAS = p.wallPassBias!;
    const MARK_TIGHT = p.markTightness!;

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const goalHalf = view.field.goalHeight / 2; // 100
    const clampX = (x: number) => Math.max(16, Math.min(W - 16, x));
    const clampY = (y: number) => Math.max(16, Math.min(H - 16, y));

    const enemyGoal: Vec2 = { x: view.targetGoalX, y: H / 2 };
    const ownGoalCenter: Vec2 = { x: view.ownGoalX, y: H / 2 };

    // Fixed role slots (teammates arrive in id order).
    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0]!;
    const distributor = squad[1]!;
    const runnerTop = squad[2]!; // camps low-y (top of pitch)
    const runnerBot = squad[3]!; // camps high-y (bottom of pitch)
    const runners = [runnerTop, runnerBot];

    const carrier = view.teammates.find((t) => t.hasBall) ?? null;
    const weHaveBall = carrier !== null;

    // --- lane test (shared geometry with the rest of the pool) -----------
    const LANE_CLEARANCE = 40;
    const LANE_IGNORE_NEAR = 32;
    const laneBlocked = (from: Vec2, to: Vec2): boolean => {
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
    const openness = (pt: Vec2) =>
      view.opponents.length ? Math.min(...view.opponents.map((o) => dist(o.pos, pt))) : Infinity;

    // The enemy's most-advanced forward (their parked outlet striker): the
    // opponent furthest toward OUR goal along attackDir.
    const enemyForward = (): PlayerView | null => {
      let best: PlayerView | null = null;
      let bestAhead = -Infinity;
      for (const o of view.opponents) {
        const ahead = (ownGoalCenter.x - o.pos.x) * view.attackDir; // bigger = nearer our goal
        if (ahead > bestAhead) {
          bestAhead = ahead;
          best = o;
        }
      }
      return best;
    };

    // ---- runner station target (high & wide on its flank) ---------------
    // x: closer to enemy goal as RUNNER_DEPTH rises. y: hug the top/bottom thirds.
    const runnerStation = (r: PlayerView, isTop: boolean): Vec2 => {
      const baseX = view.targetGoalX - view.attackDir * (1 - RUNNER_DEPTH) * 520;
      let x = baseX;
      // Vertical burst onto the end of the diagonal when we own it deep.
      if (weHaveBall) x += view.attackDir * 120;
      // Drop ~80u when we lose possession to stay available as the next outlet.
      if (!weHaveBall && view.ball.ownerId !== null) x -= view.attackDir * 80;
      const y = isTop ? 150 : H - 150; // 150 / 530
      return { x: clampX(x), y: clampY(y) };
    };

    // ---- diagonal switch: pick the most-open runner to launch to --------
    // Prefer the runner on the OPPOSITE flank from the ball (a true switch of
    // play) and with a clean sight; weighted by openness + how upfield he is.
    const launchTarget = (from: Vec2): PlayerView | null => {
      let best: PlayerView | null = null;
      let bestScore = -Infinity;
      for (const r of runners) {
        const open = openness(r.pos);
        const ahead = (r.pos.x - from.x) * view.attackDir; // reward forward switches
        const lanePenalty = laneBlocked(from, r.pos) ? -400 : 0;
        // Switch-of-play bonus: runner on the far side of the pitch from the ball.
        const switchBonus = (r.pos.y - H / 2) * (from.y - H / 2) < 0 ? 120 : 0;
        const score = open + ahead * 0.6 + lanePenalty + switchBonus;
        if (score > bestScore) {
          bestScore = score;
          best = r;
        }
      }
      return best;
    };

    // ---- wall pass: bank off the near sideline to the OTHER runner -------
    // Returns the mirror aim point + travel range, or null if no clean bank.
    const wallPassAim = (me: PlayerView, mate: PlayerView): { aim: Vec2; range: number } | null => {
      const C = me.pos;
      let best: { aim: Vec2; range: number } | null = null;
      let bestScore = -1;
      for (const wallY of [0, H]) {
        const mirror: Vec2 = { x: mate.pos.x, y: 2 * wallY - mate.pos.y };
        const denom = mirror.y - C.y;
        if (Math.abs(denom) < 1e-6) continue;
        const k = (wallY - C.y) / denom; // fraction of C->mirror that hits the wall
        if (k <= 0.05 || k >= 0.95) continue;
        const bounce: Vec2 = { x: C.x + (mirror.x - C.x) * k, y: wallY };
        if (bounce.x < 0 || bounce.x > W) continue;
        if (laneBlocked(C, bounce) || laneBlocked(bounce, mate.pos)) continue;
        const s = openness(mate.pos);
        if (s > bestScore) {
          bestScore = s;
          best = { aim: mirror, range: dist(C, bounce) + dist(bounce, mate.pos) };
        }
      }
      return best;
    };

    // ============ ON THE BALL ============================================
    if (carrier) {
      const isRunner = carrier.id === runnerTop.id || carrier.id === runnerBot.id;
      const distToGoal = dist(carrier.pos, enemyGoal);

      if (isRunner) {
        // RUNNER ON THE BALL: drive at goal, then thunderbolt; if the lane is
        // shut, bank a wall pass to the mirror runner; else carry vertically.
        const other = carrier.id === runnerTop.id ? runnerBot : runnerTop;
        const shooterLow = carrier.pos.y <= H / 2;
        // Aim at the open corner away from the keeper/markers in the mouth.
        const aimCornerY = shooterLow ? H / 2 + goalHalf * 0.78 : H / 2 - goalHalf * 0.78;
        const shotAim: Vec2 = { x: view.targetGoalX, y: aimCornerY };

        const closeShot = distToGoal < 170; // near-zero scatter — slot the corner
        const inRange = distToGoal < W * SHOT_RANGE;
        const laneToGoal = !laneBlocked(carrier.pos, shotAim) || !laneBlocked(carrier.pos, enemyGoal);

        if (closeShot) {
          intents[carrier.id] = { kind: "shoot", to: shotAim };
        } else if (inRange && laneToGoal) {
          // Clean sight of the mouth from distance: let fly.
          intents[carrier.id] = { kind: "shoot", to: shotAim };
        } else {
          // Lane shut. Consider the signature bank shot to the mirror runner.
          const wall = WALL_BIAS > 0 ? wallPassAim(carrier, other) : null;
          const directOpen = !laneBlocked(carrier.pos, other.pos);
          if (wall && (!directOpen || WALL_BIAS >= 0.5)) {
            intents[carrier.id] = { kind: "pass", to: wall.aim, range: wall.range };
          } else if (directOpen && openness(other.pos) > openness(carrier.pos)) {
            intents[carrier.id] = { kind: "pass", to: other.pos };
          } else {
            // Carry vertically at the goal to manufacture an angle.
            intents[carrier.id] = { kind: "move", to: { x: view.targetGoalX, y: clampY(carrier.pos.y < H / 2 ? carrier.pos.y + 40 : carrier.pos.y - 40) } };
          }
        }
      } else {
        // KEEPER / DISTRIBUTOR ON THE BALL: rake the long diagonal to a runner.
        // launchThreshold lowers the upfield-gap bar; at high values we go long
        // almost always (very direct).
        const target = launchTarget(carrier.pos);
        const targetOpen = target ? openness(target.pos) : 0;
        const targetClear = target ? !laneBlocked(carrier.pos, target.pos) : false;
        // Required openness shrinks as LAUNCH rises (more eager to switch).
        const need = 80 - LAUNCH * 70; // LAUNCH 0 -> 80u gap, 1 -> 10u gap
        if (target && targetClear && targetOpen > need) {
          intents[carrier.id] = { kind: "pass", to: target.pos };
        } else if (target) {
          // No clean diagonal: try a wall-pass switch to that runner, else the
          // distributor carries it upfield a touch to open the lane.
          const wall = WALL_BIAS > 0 ? wallPassAim(carrier, target) : null;
          if (wall) {
            intents[carrier.id] = { kind: "pass", to: wall.aim, range: wall.range };
          } else if (carrier.id === keeper.id) {
            // Keeper: never carry out; drive it to the distributor as a safe outlet.
            intents[carrier.id] = { kind: "pass", to: distributor.pos };
          } else {
            // Distributor: carry into our half toward midfield to shake the mark.
            intents[carrier.id] = {
              kind: "move",
              to: { x: clampX(carrier.pos.x + view.attackDir * 120), y: clampY(carrier.pos.y) },
            };
          }
        } else {
          intents[carrier.id] = { kind: "move", to: { x: clampX(carrier.pos.x + view.attackDir * 120), y: carrier.pos.y } };
        }
      }
    }

    const enemyCarrier = view.opponents.find((o) => o.id === view.ball.ownerId) ?? null;
    // An enemy carrier inside our defensive third is an imminent shot threat.
    const enemyCarrierDeep =
      enemyCarrier && (enemyCarrier.pos.x - view.ownGoalX) * view.attackDir < W * 0.34
        ? enemyCarrier
        : null;

    // ============ KEEPER (sweeper, guards the mouth) =====================
    if (!(keeper.id in intents)) {
      const dx = view.ball.pos.x - ownGoalCenter.x;
      const dy = view.ball.pos.y - ownGoalCenter.y;
      const len = Math.hypot(dx, dy) || 1;
      // Sweep a loose ball inside our third if the keeper is nearest to it.
      const ballInOwnThird = (view.ball.pos.x - view.ownGoalX) * view.attackDir < W / 3;
      const looseInThird = view.ball.ownerId === null && ballInOwnThird;
      const keeperNearestLoose =
        looseInThird &&
        view.teammates.every(
          (t) => t.id === keeper.id || dist(t.pos, view.ball.pos) >= dist(keeper.pos, view.ball.pos),
        );
      // Is a ball flying at our goal (a shot/launch)? Project where it crosses
      // our goal line and slide there to block it — this eats blitz's full-field
      // empty-net shots and chaser's central ones.
      const bv = view.ball.vel;
      const bspeed = Math.hypot(bv.x, bv.y);
      const incoming =
        view.ball.ownerId === null && bspeed > 120 && (view.ownGoalX - view.ball.pos.x) * view.attackDir > 0;
      let blockY: number | null = null;
      if (incoming && Math.abs(bv.x) > 1) {
        const tGoal = (view.ownGoalX - view.ball.pos.x) / bv.x;
        if (tGoal > 0) blockY = view.ball.pos.y + bv.y * tGoal;
      }
      // If an enemy is dribbling at our goal in the third, step out and close
      // him down to deny the shot — but stay roughly on the ball-to-goal line so
      // we are also a screen. The keeper is the front-line challenger here; the
      // distributor drops to guard the mouth behind.
      const challengeDeep =
        enemyCarrierDeep !== null &&
        view.teammates.every(
          (t) =>
            t.id === keeper.id ||
            dist(t.pos, enemyCarrierDeep!.pos) >= dist(keeper.pos, enemyCarrierDeep!.pos),
        );
      if (challengeDeep && enemyCarrierDeep) {
        // Aim a touch goal-side of the carrier so contact pushes him off line.
        const cx = enemyCarrierDeep.pos.x - ownGoalCenter.x;
        const cy = enemyCarrierDeep.pos.y - ownGoalCenter.y;
        const cl = Math.hypot(cx, cy) || 1;
        intents[keeper.id] = {
          kind: "move",
          to: {
            x: enemyCarrierDeep.pos.x - (cx / cl) * 14,
            y: enemyCarrierDeep.pos.y - (cy / cl) * 14,
          },
        };
      } else if (keeperNearestLoose) {
        intents[keeper.id] = { kind: "move", to: view.ball.pos };
      } else if (blockY !== null) {
        // Intercept on a short arc in front of goal at the projected crossing y.
        const STANDOFF = 55;
        intents[keeper.id] = {
          kind: "move",
          to: {
            x: ownGoalCenter.x + view.attackDir * STANDOFF,
            y: Math.max(245, Math.min(435, blockY)),
          },
        };
      } else {
        // Hug a 70u arc on the ball-to-goal line, clamped to the mouth band.
        const STANDOFF = 70;
        intents[keeper.id] = {
          kind: "move",
          to: {
            x: ownGoalCenter.x + (dx / len) * STANDOFF,
            y: Math.max(250, Math.min(430, ownGoalCenter.y + (dy / len) * STANDOFF)),
          },
        };
      }
    }

    // ============ DISTRIBUTOR (outlet + man-marker + 2nd defender) =======
    if (!(distributor.id in intents)) {
      const fwd = enemyForward();
      // A forward worth man-marking is one PARKED in our defensive third as a
      // long-ball outlet (the blitz striker). Distance from our goal:
      const fwdGoalDist = fwd ? Math.abs(fwd.pos.x - view.ownGoalX) : Infinity;
      const fwdParkedDeep = fwd !== null && fwdGoalDist < W * 0.32;
      if (weHaveBall) {
        // We have it: be a deep central outlet for the build-up.
        const baseX = view.ownGoalX + view.attackDir * 280;
        const y = H / 2 + (view.ball.pos.y - H / 2) * 0.5;
        intents[distributor.id] = { kind: "move", to: { x: clampX(baseX), y: clampY(y) } };
      } else if (enemyCarrierDeep) {
        // Keeper is out challenging the deep carrier: the distributor becomes
        // the last line, guarding the mouth on a tight arc on the ball's y-lane.
        const dx = view.ball.pos.x - ownGoalCenter.x;
        const dy = view.ball.pos.y - ownGoalCenter.y;
        const len = Math.hypot(dx, dy) || 1;
        const STANDOFF = 36;
        intents[distributor.id] = {
          kind: "move",
          to: {
            x: ownGoalCenter.x + (dx / len) * STANDOFF,
            y: Math.max(250, Math.min(430, ownGoalCenter.y + (dy / len) * STANDOFF)),
          },
        };
      } else {
        // SECOND DEFENDER / OUTLET-DENIER: hold a deep central screen on the
        // ball-to-goal line at a wider standoff than the keeper, so the two of us
        // wall the whole mouth on a central attack. If the enemy parks a striker
        // deep & central (blitz's outlet), bias our y toward his lane to body the
        // long ball — markTightness slides between pure mouth-guard and tight
        // man-mark, but we never abandon the central screen.
        const dx = view.ball.pos.x - ownGoalCenter.x;
        const dy = view.ball.pos.y - ownGoalCenter.y;
        const len = Math.hypot(dx, dy) || 1;
        const STANDOFF = 150;
        let toY = Math.max(210, Math.min(470, ownGoalCenter.y + (dy / len) * STANDOFF));
        if (fwdParkedDeep && fwd && Math.abs(fwd.pos.y - H / 2) < 160) {
          const markY = ownGoalCenter.y + (fwd.pos.y - ownGoalCenter.y) * (0.55 - MARK_TIGHT * 0.15);
          toY = Math.max(210, Math.min(470, toY * (1 - MARK_TIGHT) + markY * MARK_TIGHT));
        }
        intents[distributor.id] = {
          kind: "move",
          to: {
            x: clampX(ownGoalCenter.x + (dx / len) * STANDOFF),
            y: clampY(toY),
          },
        };
      }
    }

    // ============ RUNNERS (hold high-wide; hunt 50/50s to spring counters) =
    // The two runners are the counter threat — they do NOT track back hard. But
    // the NEARER runner does hunt the ball when we don't own it: he presses an
    // enemy carrier (forcing a hurried release) or chases a loose ball that's up
    // for grabs (e.g. blitz's launch to its striker, or any scramble), winning
    // it high to fire the counter. The OTHER runner always stays high and wide as
    // the loaded outlet for the switch. Exception: if the ball is deep in our own
    // third the two defenders handle it and both runners hold station, so the
    // counter is ready the instant we win it back.
    const ballDeepOwnThird = (view.ball.pos.x - view.ownGoalX) * view.attackDir < W * 0.22;
    // A LOOSE ball anywhere short of the enemy's deep third is a 50/50 we want to
    // win to spring the counter (e.g. blitz's launch to its striker, or any
    // scramble). The nearer runner hunts it; the other holds wide as the outlet.
    const looseUpForGrabs =
      view.ball.ownerId === null &&
      (view.ball.pos.x - view.ownGoalX) * view.attackDir > W * 0.18 &&
      (view.targetGoalX - view.ball.pos.x) * view.attackDir > W * 0.22;
    let presser: PlayerView | null = null;
    if (!weHaveBall && (enemyCarrier || looseUpForGrabs) && !ballDeepOwnThird) {
      presser =
        dist(runnerTop.pos, view.ball.pos) <= dist(runnerBot.pos, view.ball.pos) ? runnerTop : runnerBot;
    }
    runners.forEach((r, i) => {
      if (r.id in intents) return;
      if (presser && r.id === presser.id) {
        intents[r.id] = { kind: "move", to: view.ball.pos };
        return;
      }
      // If our pass/switch is in flight roughly toward this runner, go meet it.
      if (view.ball.ownerId === null && weHaveBallPassToward(view, r)) {
        intents[r.id] = { kind: "move", to: view.ball.pos };
        return;
      }
      intents[r.id] = { kind: "move", to: runnerStation(r, i === 0) };
    });

    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

/**
 * Is a loose ball in flight, in our attacking half, heading roughly toward this
 * runner? If so he should come to meet the switch instead of holding station.
 */
function weHaveBallPassToward(view: WorldView, me: PlayerView): boolean {
  const W = view.field.width;
  const H = view.field.height;
  const bv = view.ball.vel;
  const speed = Math.hypot(bv.x, bv.y);
  if (speed < 80) return false;
  // Only chase balls heading upfield (toward the enemy goal), not our own shots/clearances.
  if (bv.x * view.attackDir <= 0) return false;
  const rx = me.pos.x - view.ball.pos.x;
  const ry = me.pos.y - view.ball.pos.y;
  if (rx * bv.x + ry * bv.y <= 0) return false; // ball moving away from me
  // Ignore a ball heading into the enemy goal mouth — that's a shot, not a pass to me.
  if (bv.x * view.attackDir > 1) {
    const tGoal = (view.targetGoalX - view.ball.pos.x) / bv.x;
    const yAtGoal = view.ball.pos.y + bv.y * tGoal;
    if (Math.abs(yAtGoal - H / 2) < view.field.goalHeight / 2) return false;
  }
  const perp = Math.abs(rx * bv.y - ry * bv.x) / speed;
  return perp < 120 && W > 0;
}

export default comet;
