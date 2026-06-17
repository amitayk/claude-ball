import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { dist, kickoffBackPass } from "@kr/brain-api";

/**
 * TACTIC ("possession") — keep the ball, never shoot.
 *   - Phase 1 (no ball): players 1 & 2 rush the ball; 3 & 4 drop to our goal
 *     (but break onto a pass heading their way).
 *   - On the ball: the carrier does NOT pass right away. He runs to the closest
 *     corner of the field; 2s after gaining the ball he passes to the most open
 *     teammate.
 *   - While a teammate holds the ball, everyone else tries to get an open line
 *     from him at the greatest distance they can.
 *   - Never shoots.
 */
export const brain: Brain = {
  name: "possession",
  params: {
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance", help: "Clearance a pass lane needs from opponents. Higher = lanes count as blocked more easily, so it passes more cautiously." },
    laneIgnoreNear: { default: 35, min: 0, max: 100, step: 1, label: "Ignore opp. nearer than", help: "Opponents this close to the passer are ignored when judging lanes. Higher = attempts passes through more nearby pressure." },
    cornerRunSec: { default: 2.0, min: 0, max: 5, step: 0.1, label: "Corner run time (s)", help: "Seconds the carrier dribbles toward a corner before passing. Higher = holds the ball longer before releasing." },
    cornerInset: { default: 40, min: 10, max: 150, step: 5, label: "Corner inset", help: "How far inside each corner the dribble target sits. Higher = keeps the run farther from the corner." },
    cornerCloseDist: { default: 120, min: 20, max: 400, step: 10, label: "Near-corner = pass now", help: "Distance to its corner at which it passes immediately. Higher = passes sooner instead of running to the corner." },
    wideOpenDist: { default: 150, min: 60, max: 400, step: 10, label: "Wide-open radius", help: "Space a teammate needs to count as wide open. Higher = demands more space before making the early pass." },
    wideOpenMinDist: { default: 150, min: 0, max: 500, step: 10, label: "Wide-open min pass length", help: "Shortest allowed wide-open pass. Higher = only plays longer wide-open passes." },
    finishXFrac: { default: 0.2, min: 0.05, max: 0.5, step: 0.01, label: "Finish zone (×width)", help: "Width fraction by the enemy goal that counts as the finishing zone. Higher = starts shooting from farther out." },
    centralBandFrac: { default: 0.6, min: 0.2, max: 1, step: 0.05, label: "Central band (Y)", help: "Vertical band the carrier centres into before shooting. Higher = will shoot from wider angles (centres less)." },
    defStandoff: { default: 120, min: 20, max: 400, step: 10, label: "Blocker standoff from goal", help: "How far in front of our goal the deepest defender holds. Higher = defends farther up the pitch." },
    shotCornerFrac: { default: 0.8, min: 0, max: 1, step: 0.05, label: "Shot corner (×goal half)", help: "How far toward the post shots aim. Higher = aims closer to the post (more corner, riskier)." },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const LANE_CLEARANCE = p.laneClearance!;
    const LANE_IGNORE_NEAR = p.laneIgnoreNear!;
    const CORNER_RUN_SEC = p.cornerRunSec!;
    const CORNER_INSET = p.cornerInset!;
    const CORNER_CLOSE = p.cornerCloseDist!;
    const WIDE_OPEN_DIST = p.wideOpenDist!;
    const WIDE_OPEN_MIN = p.wideOpenMinDist!;
    const FINISH_X_FRAC = p.finishXFrac!;
    const CENTRAL_BAND_FRAC = p.centralBandFrac!;
    const DEF_STANDOFF = p.defStandoff!;
    const SHOT_CORNER_FRAC = p.shotCornerFrac!; // aim this far from centre toward the post

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const clampX = (x: number) => Math.max(20, Math.min(W - 20, x));
    const clampY = (y: number) => Math.max(20, Math.min(H - 20, y));

    // Per-holder possession clock (derived from the tick stream).
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

    const ownGoalCenter: Vec2 = { x: view.ownGoalX, y: H / 2 };
    const carrier = view.teammates.find((t) => t.hasBall) ?? null;

    // --- helpers --------------------------------------------------------
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

    // Closest of the 4 corners to a point.
    const corners: Vec2[] = [
      { x: CORNER_INSET, y: CORNER_INSET },
      { x: CORNER_INSET, y: H - CORNER_INSET },
      { x: W - CORNER_INSET, y: CORNER_INSET },
      { x: W - CORNER_INSET, y: H - CORNER_INSET },
    ];
    const closestCorner = (pt: Vec2): Vec2 =>
      corners.reduce((a, b) => (dist(a, pt) <= dist(b, pt) ? a : b));

    // Most-open teammate with a clean direct lane, or null.
    const clearOpenTarget = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
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
    // Most-open teammate overall (last-resort forced pass), or null.
    const anyOpenTarget = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
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

    // Wall (bounce) pass: when no direct lane is open, aim at the mirror image
    // of a teammate across the top or bottom wall, so the ball banks off the
    // wall to reach him. Returns the aim point (the mirror) and target id, or null.
    const wallPassAim = (me: PlayerView): { aim: Vec2; targetId: number } | null => {
      const C = me.pos;
      let best: { aim: Vec2; targetId: number } | null = null;
      let bestScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        for (const wallY of [0, H]) {
          const mirror: Vec2 = { x: t.pos.x, y: 2 * wallY - t.pos.y };
          const denom = mirror.y - C.y;
          if (Math.abs(denom) < 1e-6) continue;
          const k = (wallY - C.y) / denom; // where C->mirror crosses the wall
          if (k <= 0 || k >= 1) continue; // wall not between carrier and mirror
          const bounce: Vec2 = { x: C.x + (mirror.x - C.x) * k, y: wallY };
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

    // A "wide open" teammate: no opponent anywhere near him AND a clear lane.
    // Prefer a wide-open man in the enemy half; else the most open one anywhere.
    const wideOpenTarget = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
      let bestScore = -1;
      let fwd: PlayerView | null = null;
      let fwdScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        if (dist(me.pos, t.pos) < WIDE_OPEN_MIN) continue; // too close — don't bother
        if (laneBlocked(me.pos, t.pos)) continue;
        const s = openness(t.pos);
        if (s < WIDE_OPEN_DIST) continue; // not wide open
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
        if ((t.pos.x - W / 2) * view.attackDir > 0 && s > fwdScore) {
          fwdScore = s;
          fwd = t; // wide open AND in the enemy half
        }
      }
      return fwd ?? best;
    };

    // Where to aim a pass (and who it's for): clear lane, then wall pass, then forced.
    const passDecision = (me: PlayerView): { aim: Vec2; targetId: number } | null => {
      const clear = clearOpenTarget(me);
      if (clear) return { aim: clear.pos, targetId: clear.id };
      const wall = wallPassAim(me);
      if (wall) return wall;
      const any = anyOpenTarget(me);
      return any ? { aim: any.pos, targetId: any.id } : null;
    };

    // A spot far from the carrier with an open line to him (so we offer a pass
    // at maximum distance). Search outward from our current angle for a clear line.
    const openFarFrom = (me: PlayerView, from: Vec2): Vec2 => {
      const base = Math.atan2(me.pos.y - from.y, me.pos.x - from.x);
      const offs = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.2, -2.2, Math.PI];
      let fallback: Vec2 | null = null;
      for (const off of offs) {
        const a = base + off;
        const pt = { x: clampX(from.x + Math.cos(a) * 3000), y: clampY(from.y + Math.sin(a) * 3000) };
        if (!fallback) fallback = pt;
        if (!laneBlocked(from, pt)) return pt;
      }
      return fallback!;
    };

    // --- on the ball ----------------------------------------------------
    if (carrier) {
      const inFinishZone = Math.abs(carrier.pos.x - view.targetGoalX) < FINISH_X_FRAC * W;
      if (inFinishZone) {
        // KILLER: in the final 20% by the enemy goal. If on a top/bottom edge,
        // first centre into the middle band; once centred, blast it to the far
        // corner at max (shot) speed.
        const half = (CENTRAL_BAND_FRAC / 2) * H;
        const inBand = carrier.pos.y >= H / 2 - half && carrier.pos.y <= H / 2 + half;
        if (inBand) {
          const goalHalf = view.field.goalHeight / 2;
          const farY =
            carrier.pos.y <= H / 2
              ? H / 2 + goalHalf * SHOT_CORNER_FRAC // shooter high → aim low, 80% out
              : H / 2 - goalHalf * SHOT_CORNER_FRAC; // shooter low → aim high, 80% out
          intents[carrier.id] = { kind: "shoot", to: { x: view.targetGoalX, y: farY } };
        } else {
          intents[carrier.id] = { kind: "move", to: { x: carrier.pos.x, y: H / 2 } };
        }
      } else {
        const corner = closestCorner(carrier.pos);
        // If a teammate is wide open right now, pass immediately. Otherwise pass
        // once the 2s corner run is up, or right away if already near a corner.
        const wide = wideOpenTarget(carrier);
        const readyToPass = held >= CORNER_RUN_SEC || dist(carrier.pos, corner) < CORNER_CLOSE;
        const decision = wide
          ? { aim: wide.pos, targetId: wide.id }
          : readyToPass
            ? passDecision(carrier)
            : null;
        if (decision) {
          intents[carrier.id] = { kind: "pass", to: decision.aim };
          lastPassTargetId = decision.targetId; // remember who the pass is for
        } else {
          intents[carrier.id] = { kind: "move", to: corner };
        }
      }
      // Teammates get an open line from the carrier at the most distance they can.
      view.teammates.forEach((me) => {
        if (me.id === carrier.id) return;
        intents[me.id] = { kind: "move", to: openFarFrom(me, carrier.pos) };
      });
    } else if (view.ball.ownerId === null && lastOwnerWasTeammate) {
      // OUR pass in flight: only the intended receiver goes for it; everyone
      // else stays spread/open instead of all rushing the ball.
      const receiver =
        view.teammates.find((t) => t.id === lastPassTargetId) ??
        view.teammates.reduce((a, b) =>
          dist(a.pos, view.ball.pos) <= dist(b.pos, view.ball.pos) ? a : b,
        );
      view.teammates.forEach((me) => {
        intents[me.id] =
          me.id === receiver.id
            ? { kind: "move", to: view.ball.pos }
            : { kind: "move", to: openFarFrom(me, view.ball.pos) };
      });
    } else {
      // Enemy possession (or a loose enemy ball): the man closest to our goal
      // stands between the ball and the goal — and goes to intercept a shot —
      // while everyone else chases the ball holder.
      const blocker = view.teammates.reduce((a, b) =>
        dist(a.pos, ownGoalCenter) <= dist(b.pos, ownGoalCenter) ? a : b,
      );
      const holder = view.opponents.find((o) => o.id === view.ball.ownerId);
      const chaseTarget = holder ? holder.pos : view.ball.pos;
      const bv = view.ball.vel;
      const shotAtUs =
        view.ball.ownerId === null &&
        Math.hypot(bv.x, bv.y) > 40 &&
        (view.ownGoalX - view.ball.pos.x) * bv.x > 0; // moving toward our goal
      view.teammates.forEach((me) => {
        if (me.id === blocker.id) {
          if (shotAtUs) {
            intents[me.id] = { kind: "move", to: view.ball.pos }; // intercept the shot
          } else {
            const dx = view.ball.pos.x - ownGoalCenter.x;
            const dy = view.ball.pos.y - ownGoalCenter.y;
            const len = Math.hypot(dx, dy) || 1;
            intents[me.id] = {
              kind: "move",
              to: {
                x: ownGoalCenter.x + (dx / len) * DEF_STANDOFF,
                y: ownGoalCenter.y + (dy / len) * DEF_STANDOFF,
              },
            };
          }
        } else {
          intents[me.id] = { kind: "move", to: chaseTarget };
        }
      });
    }

    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

// Per-holder possession bookkeeping (module-level, derived from the tick stream).
let trackedOwner: number | null = null;
let possessionStartTick = 0;
let lastTick = -1;
let lastOwnerWasTeammate = false;
let lastPassTargetId: number | null = null;

export default brain;
