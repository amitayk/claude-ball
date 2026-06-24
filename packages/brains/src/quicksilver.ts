import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@claude-ball/brain-api";
import { dist, kickoffBackPass } from "@claude-ball/brain-api";

/**
 * TACTIC ("quicksilver") — a fast, fluid transition side with a tiki-taka
 * passing core but a quicksilver edge: it keeps the ball with short triangle
 * passing, but the instant it wins it or a lane opens it breaks vertically and
 * strikes — gegenpressing to win it back high and finishing from range into the
 * open net whenever the lane is clean (the pool's bots have no real keeper, so an
 * open lane to goal is a goal).
 *
 * Shape (by id, lowest..highest):
 *   - KEEPER/ANCHOR (lowest id): sits just off our line and tracks the projected
 *     shot-y so the opponent can't long-ball or chip past it (kills blitz's
 *     empty-net long shot and keeper-launch). On the ball it plays a short safe
 *     pass to an open teammate — never a long ball.
 *   - INTERIOR PLAYMAKERS A & B (mid ids): off the ball they hold support nodes a
 *     triangle-angle apart around the carrier (A biased high, B low) so there are
 *     always two short forward/sideways angles. First two gegenpressers.
 *   - FORWARD (highest id): stays advanced as a high outlet, finds a pocket at
 *     shoot range, receives the penetrating pass and finishes the open corner.
 *
 * On the ball: shoot if in range with a clean lane; else play the most-advanced
 * clean teammate (penetrate); else recycle to keep it; under pressure release
 * one-touch. Off the ball: a tight rotating triangle. Defence: gegenpress — the
 * nearest 1-2 swarm the ball-winner, the rest screens the lane to our goal.
 *
 * The numbers below are tunable live from the coach control panel (params).
 */
export const quicksilver: Brain = {
  name: "quicksilver",
  params: {
    passLength: {
      default: 0.34,
      min: 0,
      max: 1,
      step: 0.02,
      label: "Pass length / tempo",
      help: "Preferred short-pass distance band and how direct the build-up is. Higher = plays longer, more direct balls (bigger triangles, fewer touches); lower = tighter one-touch tiki-taka.",
    },
    supportTightness: {
      default: 140,
      min: 70,
      max: 220,
      step: 5,
      label: "Support tightness (triangle size)",
      help: "Radius at which off-ball playmakers sit around the carrier. Higher = wider triangles with longer support passes; lower = players hug the carrier for very short, safe one-touch passing.",
    },
    counterPressRadius: {
      default: 250,
      min: 120,
      max: 380,
      step: 10,
      label: "Gegenpress radius",
      help: "How far from a turnover the swarm triggers and how early the carrier releases under pressure. Higher = presses and panics-passes from farther away (more aggressive counter-press, but more space behind).",
    },
    shootRange: {
      default: 0.36,
      min: 0.12,
      max: 0.55,
      step: 0.01,
      label: "Shoot range (xWidth)",
      help: "Distance from the target goal (as a fraction of pitch width) inside which it will finish. Higher = shoots/places from farther out; lower = insists on working closer before finishing for near-zero scatter.",
    },
    laneClearance: {
      default: 34,
      min: 12,
      max: 70,
      step: 2,
      label: "Lane clearance",
      help: "Clearance a pass/shot lane needs from opponents to count as open. Higher = lanes count as blocked more easily, so it recycles sideways/back more and only plays the penetrating pass or shot when it is truly clean.",
    },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const PASS_LENGTH = p.passLength!;
    const SUPPORT = p.supportTightness!;
    const PRESS_R = p.counterPressRadius!;
    const SHOOT_FRAC = p.shootRange!;
    const LANE_CLEAR = p.laneClearance!;

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const dir = view.attackDir;
    const clampX = (x: number) => Math.max(24, Math.min(W - 24, x));
    const clampY = (y: number) => Math.max(24, Math.min(H - 24, y));

    const goalHalf = view.field.goalHeight / 2;
    const goalTop = H / 2 - goalHalf; // 240
    const goalBot = H / 2 + goalHalf; // 440
    const enemyGoal: Vec2 = { x: view.targetGoalX, y: H / 2 };
    const ownGoalCenter: Vec2 = { x: view.ownGoalX, y: H / 2 };

    // Roles by id: keeper = lowest, forward = highest, playmakers in between.
    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0]!;
    const forward = squad[squad.length - 1]!;
    const playmakers = squad.slice(1, squad.length - 1); // two interior mids

    const carrier = view.teammates.find((t) => t.hasBall) ?? null;
    const ownerId = view.ball.ownerId;
    const oppOwns = ownerId != null && view.opponents.some((o) => o.id === ownerId);

    // --- geometry helpers ----------------------------------------------
    const laneBlockedBy = (from: Vec2, to: Vec2, clear: number): boolean => {
      const abx = to.x - from.x;
      const aby = to.y - from.y;
      const len2 = abx * abx + aby * aby;
      const segLen = Math.sqrt(len2);
      return view.opponents.some((o) => {
        let t = len2 > 0 ? ((o.pos.x - from.x) * abx + (o.pos.y - from.y) * aby) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (t * segLen < 26) return false; // ignore opponents right on the passer
        const cx = from.x + abx * t;
        const cy = from.y + aby * t;
        return Math.hypot(o.pos.x - cx, o.pos.y - cy) < clear;
      });
    };
    const laneBlocked = (from: Vec2, to: Vec2) => laneBlockedBy(from, to, LANE_CLEAR);
    const nearestOppDist = (pt: Vec2) =>
      view.opponents.length ? Math.min(...view.opponents.map((o) => dist(o.pos, pt))) : Infinity;

    // Aim point on goal: the open corner away from the nearest opponent on the
    // goal line (their keeper), checked for a clean shot lane.
    const shotAim = (from: Vec2): Vec2 | null => {
      // their "keeper" = opponent nearest our target goal line
      let keeperY = H / 2;
      let bestD = Infinity;
      for (const o of view.opponents) {
        const d = Math.abs(o.pos.x - view.targetGoalX);
        if (d < bestD) {
          bestD = d;
          keeperY = o.pos.y;
        }
      }
      const inset = 16;
      const high: Vec2 = { x: view.targetGoalX, y: goalTop + inset };
      const low: Vec2 = { x: view.targetGoalX, y: goalBot - inset };
      const mid: Vec2 = { x: view.targetGoalX, y: H / 2 };
      // prefer the corner farther from their keeper, then the other, then center.
      // Shots use a SLIGHTLY looser clearance than passes — the opponents have no
      // real keeper, so a hard struck ball at the corner beats a scrambling body.
      const order =
        Math.abs(keeperY - high.y) >= Math.abs(keeperY - low.y) ? [high, low, mid] : [low, high, mid];
      const shotClear = Math.max(18, LANE_CLEAR - 8);
      for (const a of order) if (!laneBlockedBy(from, a, shotClear)) return a;
      return null;
    };

    // The ball point to swarm (predict the carrier's motion).
    const ballPoint = (): Vec2 => {
      if (oppOwns) {
        const o = view.opponents.find((q) => q.id === ownerId)!;
        return { x: o.pos.x + o.vel.x * 0.15, y: o.pos.y + o.vel.y * 0.15 };
      }
      return { x: view.ball.pos.x + view.ball.vel.x * 0.1, y: view.ball.pos.y + view.ball.vel.y * 0.1 };
    };

    // ================================================================
    // KEEPER — hold the line, track the projected shot-y, bias to centre.
    // ================================================================
    const keeperLineX = view.ownGoalX + dir * 24;
    // Sit on the LINE the most likely shot takes: the pool's shooters aim at goal
    // centre, so the keeper stands where the ball->goal-centre line crosses its
    // own line (this is exactly where a central-aimed shot passes). Blend a touch
    // of the ball's own projected y so it also covers placed/scattered shots.
    const bx = view.ball.pos.x + view.ball.vel.x * 0.06;
    const by = view.ball.pos.y + view.ball.vel.y * 0.06;
    const denomX = bx - view.ownGoalX;
    let lineY: number;
    if (Math.abs(denomX) > 1) {
      const k = (keeperLineX - view.ownGoalX) / denomX; // along ball->goalCentre
      lineY = H / 2 + (by - H / 2) * k;
    } else {
      lineY = by;
    }
    const trackY = lineY * 0.7 + by * 0.3;
    const keeperLine: Vec2 = { x: keeperLineX, y: Math.max(goalTop + 8, Math.min(goalBot - 8, trackY)) };
    const ballNearOwnGoal = dist(view.ball.pos, ownGoalCenter) < 130;
    const keeperClosest = view.teammates.every(
      (t) => t.id === keeper.id || dist(t.pos, view.ball.pos) >= dist(keeper.pos, view.ball.pos),
    );

    if (keeper.hasBall) {
      // Anchor outlet: shortest safe pass to an open teammate. Never long-ball.
      let best: PlayerView | null = null;
      let bestD = Infinity;
      for (const t of view.teammates) {
        if (t.id === keeper.id) continue;
        if (laneBlocked(keeper.pos, t.pos)) continue;
        if ((t.pos.x - keeper.pos.x) * dir > 380) continue; // keep it short
        const d = dist(keeper.pos, t.pos);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) {
        for (const t of view.teammates) {
          if (t.id === keeper.id) continue;
          const d = dist(keeper.pos, t.pos);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
      }
      intents[keeper.id] = best
        ? { kind: "pass", to: best.pos }
        : { kind: "move", to: { x: keeperLineX, y: H / 2 } };
    } else if (ballNearOwnGoal && keeperClosest && ownerId == null) {
      intents[keeper.id] = { kind: "move", to: view.ball.pos };
    } else {
      intents[keeper.id] = { kind: "move", to: keeperLine };
    }

    // ================================================================
    // WE HAVE THE BALL — shoot / penetrate / recycle.
    // ================================================================
    if (carrier) {
      const cpos = carrier.pos;
      const press = nearestOppDist(cpos);
      const oneTouch = press < PRESS_R * 0.6;
      const distToGoal = Math.abs(cpos.x - view.targetGoalX);
      const inShootZone = distToGoal < SHOOT_FRAC * W;

      if (carrier.id !== keeper.id) {
        const aim = inShootZone ? shotAim(cpos) : null;
        if (aim) {
          // FINISH: clean lane to a corner inside shoot range.
          intents[carrier.id] = { kind: "shoot", to: aim };
        } else {
          // PASS selection. A pass goes loose and can be intercepted by the
          // swarm; a dribble stays controlled. So we only PASS when it's a clean,
          // valuable ball: a scoring feed (sets up an instant finish), a clean
          // ball to a teammate clearly ahead, or the blitz-style release to the
          // high camped forward. Otherwise we dribble the ball into space.
          const pen = penetratingTarget(view, carrier, laneBlocked, dir);
          const feedShooter = scoringFeed(view, carrier, laneBlocked, dir, SHOOT_FRAC, W, goalTop, goalBot);

          // PASS_LENGTH sets how direct we are: the higher it is, the SHORTER the
          // distance the forward needs to be ahead before we ping it the direct
          // ball over the top (more direct / longer balls, fewer touches).
          const directGate = Math.max(120, 300 - PASS_LENGTH * 300); // 300u (patient) .. 120u (direct)
          const directFwd =
            forward.id !== carrier.id &&
            (forward.pos.x - cpos.x) * dir > directGate &&
            !laneBlockedBy(cpos, forward.pos, Math.max(20, LANE_CLEAR - 10))
              ? forward
              : null;

          const forwardPass = feedShooter ?? pen ?? directFwd;
          if (forwardPass) {
            intents[carrier.id] = { kind: "pass", to: forwardPass.pos };
          } else {
            // Dribble into space: sample headings that make forward progress and
            // pick the one whose path stays farthest from opponents — keep the
            // ball and carry it up-field, dragging the swarm away from our net.
            const drive = driveIntoSpace(view, cpos, dir);
            intents[carrier.id] = { kind: "move", to: { x: clampX(drive.x), y: clampY(drive.y) } };
          }
        }
      }

      // --- off-ball triangle ----------------------------------------
      const aheadX = clampX(cpos.x + dir * SUPPORT * 0.6);
      playmakers.forEach((me, i) => {
        if (me.id === carrier.id) return;
        const high = i === 0;
        const ny = clampY(high ? cpos.y - SUPPORT * 0.75 : cpos.y + SUPPORT * 0.75);
        const node = openNodeNear(view, { x: aheadX, y: ny }, laneBlocked, cpos);
        intents[me.id] = { kind: "move", to: node };
      });

      // Forward: camp high near the enemy goal as a permanent outlet, in the
      // emptiest vertical band, so a direct ball over the swarm finds it free.
      if (forward.id !== carrier.id) {
        const fx = clampX(view.targetGoalX - dir * 160);
        intents[forward.id] = { kind: "move", to: forwardPocket(view, fx, goalTop, goalBot) };
      }

      for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
      return intents;
    }

    // ================================================================
    // LOOSE / OPPONENT BALL — gegenpress + drop-screen.
    // ================================================================
    const target = ballPoint();
    const outfield = view.teammates.filter((t) => t.id !== keeper.id);
    const ranked = [...outfield].sort((a, b) => dist(a.pos, target) - dist(b.pos, target));

    const pressers = new Set<number>();
    if (ranked[0]) pressers.add(ranked[0].id);
    if (ranked[1] && dist(ranked[1].pos, target) < PRESS_R) pressers.add(ranked[1].id);

    // Screen node on the lane between the ball and our goal.
    const sdx = view.ball.pos.x - ownGoalCenter.x;
    const sdy = view.ball.pos.y - ownGoalCenter.y;
    const sl = Math.hypot(sdx, sdy) || 1;
    const SCREEN = 200;
    const screenNode: Vec2 = {
      x: clampX(ownGoalCenter.x + (sdx / sl) * SCREEN),
      y: clampY(ownGoalCenter.y + (sdy / sl) * SCREEN),
    };
    const ballInOurHalf = (view.ball.pos.x - W / 2) * dir < 0;

    let screenAssigned = false;
    for (const me of outfield) {
      if (pressers.has(me.id)) {
        intents[me.id] = { kind: "move", to: { x: clampX(target.x), y: clampY(target.y) } };
      } else if (!screenAssigned) {
        intents[me.id] = { kind: "move", to: screenNode };
        screenAssigned = true;
      } else {
        const outletX = ballInOurHalf
          ? clampX(W / 2 + dir * 60)
          : clampX(view.ball.pos.x + dir * 40);
        intents[me.id] = { kind: "move", to: { x: outletX, y: me.id === forward.id ? me.pos.y : H / 2 } };
      }
    }

    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

// --- pure helpers -----------------------------------------------------------

/** Most-advanced teammate genuinely ahead with a clean lane, or null. */
function penetratingTarget(
  view: WorldView,
  carrier: PlayerView,
  laneBlocked: (a: Vec2, b: Vec2) => boolean,
  dir: 1 | -1,
): PlayerView | null {
  let best: PlayerView | null = null;
  let bestAhead = 50;
  for (const t of view.teammates) {
    if (t.id === carrier.id) continue;
    const ahead = (t.pos.x - carrier.pos.x) * dir;
    if (ahead <= bestAhead) continue;
    if (laneBlocked(carrier.pos, t.pos)) continue;
    bestAhead = ahead;
    best = t;
  }
  return best;
}

/**
 * Pick a dribble target ~120u away that makes forward progress (toward the
 * target goal) while keeping the carry as far from opponents as possible. We
 * sample a fan of headings centred on "straight at goal" and score each by the
 * clearance of a look-ahead point, lightly rewarding forward progress.
 */
function driveIntoSpace(view: WorldView, cpos: Vec2, dir: 1 | -1): Vec2 {
  const R = 120;
  const baseAng = dir > 0 ? 0 : Math.PI; // toward target goal in x
  const offs = [0, 0.5, -0.5, 0.95, -0.95, 1.4, -1.4];
  let best: Vec2 = { x: cpos.x + dir * R, y: cpos.y };
  let bestScore = -Infinity;
  for (const off of offs) {
    const a = baseAng + off;
    const look = { x: cpos.x + Math.cos(a) * R, y: cpos.y + Math.sin(a) * R };
    // clearance: distance from the look-ahead point to the nearest opponent.
    let clear = Infinity;
    for (const o of view.opponents) clear = Math.min(clear, dist(o.pos, look));
    const progress = (Math.cos(a) * dir) * 60; // reward heading toward goal
    const wallPenalty =
      look.y < 40 || look.y > view.field.height - 40 || look.x < 30 || look.x > view.field.width - 30 ? 60 : 0;
    const score = clear + progress - wallPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = look;
    }
  }
  return best;
}

/**
 * A scoring feed: a teammate ahead with a clean lane who is ALSO inside shoot
 * range with a clean shot of their own — the pass that sets up an immediate
 * finish. Prefer the most-advanced such teammate.
 */
function scoringFeed(
  view: WorldView,
  carrier: PlayerView,
  laneBlocked: (a: Vec2, b: Vec2) => boolean,
  dir: 1 | -1,
  shootFrac: number,
  W: number,
  goalTop: number,
  goalBot: number,
): PlayerView | null {
  const H = view.field.height;
  let best: PlayerView | null = null;
  let bestAhead = -Infinity;
  for (const t of view.teammates) {
    if (t.id === carrier.id) continue;
    const ahead = (t.pos.x - carrier.pos.x) * dir;
    if (ahead <= 30) continue; // must be forward
    if (laneBlocked(carrier.pos, t.pos)) continue; // pass must be clean
    if (Math.abs(t.pos.x - view.targetGoalX) >= shootFrac * W) continue; // in range
    // does the receiver have a clean shot at the centre/corner?
    const aim: Vec2 = { x: view.targetGoalX, y: H / 2 };
    if (laneBlocked(t.pos, aim) && laneBlocked(t.pos, { x: view.targetGoalX, y: goalTop + 16 }) && laneBlocked(t.pos, { x: view.targetGoalX, y: goalBot - 16 })) continue;
    if (ahead > bestAhead) {
      bestAhead = ahead;
      best = t;
    }
  }
  return best;
}

/** Fan a support node until the lane from the carrier is open. */
function openNodeNear(
  view: WorldView,
  desired: Vec2,
  laneBlocked: (a: Vec2, b: Vec2) => boolean,
  from: Vec2,
): Vec2 {
  if (!laneBlocked(from, desired)) return desired;
  const base = Math.atan2(desired.y - from.y, desired.x - from.x);
  const r = Math.hypot(desired.x - from.x, desired.y - from.y) || 120;
  const W = view.field.width;
  const H = view.field.height;
  const clampX = (x: number) => Math.max(24, Math.min(W - 24, x));
  const clampY = (y: number) => Math.max(24, Math.min(H - 24, y));
  for (const off of [0.35, -0.35, 0.7, -0.7, 1.1, -1.1]) {
    const a = base + off;
    const pt = { x: clampX(from.x + Math.cos(a) * r), y: clampY(from.y + Math.sin(a) * r) };
    if (!laneBlocked(from, pt)) return pt;
  }
  return desired;
}

/** Forward's pocket: emptiest of high/middle/low bands near the target goal. */
function forwardPocket(view: WorldView, fx: number, goalTop: number, goalBot: number): Vec2 {
  const H = view.field.height;
  const candidates = [goalTop + 20, H / 2, goalBot - 20];
  let bestY = candidates[1]!;
  let bestSpace = -1;
  for (const y of candidates) {
    const pt = { x: fx, y };
    const space = view.opponents.length ? Math.min(...view.opponents.map((o) => dist(o.pos, pt))) : Infinity;
    if (space > bestSpace) {
      bestSpace = space;
      bestY = y;
    }
  }
  return { x: fx, y: bestY };
}

export default quicksilver;
