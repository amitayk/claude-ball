import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { dist } from "@kr/brain-api";

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
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance" },
    laneIgnoreNear: { default: 35, min: 0, max: 100, step: 1, label: "Ignore opp. nearer than" },
    cornerRunSec: { default: 2.0, min: 0, max: 5, step: 0.1, label: "Corner run time (s)" },
    cornerInset: { default: 40, min: 10, max: 150, step: 5, label: "Corner inset" },
    receivePath: { default: 130, min: 40, max: 300, step: 10, label: "Receive path width" },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const LANE_CLEARANCE = p.laneClearance!;
    const LANE_IGNORE_NEAR = p.laneIgnoreNear!;
    const CORNER_RUN_SEC = p.cornerRunSec!;
    const CORNER_INSET = p.cornerInset!;
    const RECEIVE_PATH = p.receivePath!;

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
    }
    lastTick = view.tick;
    if (ownerIsTeammate && owner !== trackedOwner) possessionStartTick = view.tick;
    trackedOwner = owner;
    const held = (view.tick - possessionStartTick) * view.dt;

    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const rushers = squad.slice(0, 2); // players 1 & 2
    const outlets = squad.slice(2); // players 3 & 4
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

    // Most-open teammate (preferring a clean lane), or null.
    const mostOpenTeammate = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
      let bestScore = -1;
      let any: PlayerView | null = null;
      let anyScore = -1;
      for (const t of view.teammates) {
        if (t.id === me.id) continue;
        const s = openness(t.pos);
        if (s > anyScore) {
          anyScore = s;
          any = t;
        }
        if (!laneBlocked(me.pos, t.pos) && s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
      return best ?? any;
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

    // Is a loose ball heading toward this player (on its path)?
    const ballHeadingToward = (me: PlayerView): boolean => {
      if (view.ball.ownerId !== null) return false;
      const bv = view.ball.vel;
      const speed = Math.hypot(bv.x, bv.y);
      if (speed < 40) return false;
      const rx = me.pos.x - view.ball.pos.x;
      const ry = me.pos.y - view.ball.pos.y;
      if (rx * bv.x + ry * bv.y <= 0) return false;
      const perp = Math.abs(rx * bv.y - ry * bv.x) / speed;
      return perp < RECEIVE_PATH;
    };

    // --- on the ball ----------------------------------------------------
    if (carrier) {
      if (held >= CORNER_RUN_SEC) {
        const tgt = mostOpenTeammate(carrier);
        intents[carrier.id] = tgt
          ? { kind: "pass", to: tgt.pos }
          : { kind: "move", to: closestCorner(carrier.pos) };
      } else {
        intents[carrier.id] = { kind: "move", to: closestCorner(carrier.pos) };
      }
      // Teammates get an open line from the carrier at the most distance they can.
      view.teammates.forEach((me) => {
        if (me.id === carrier.id) return;
        intents[me.id] = { kind: "move", to: openFarFrom(me, carrier.pos) };
      });
    } else {
      // No possession: players 1 & 2 rush the ball. Players 3 & 4 hold near our
      // goal, but break onto a pass heading their way.
      rushers.forEach((r) => {
        intents[r.id] = { kind: "move", to: view.ball.pos };
      });
      outlets.forEach((o, i) => {
        intents[o.id] = ballHeadingToward(o)
          ? { kind: "move", to: view.ball.pos }
          : {
              kind: "move",
              to: { x: view.ownGoalX + view.attackDir * 40, y: H * (i === 0 ? 0.35 : 0.65) },
            };
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

export default brain;
