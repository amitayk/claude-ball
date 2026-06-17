import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { dist } from "@kr/brain-api";

/**
 * TACTIC ("possession") — keep the ball, never shoot.
 *   - Phase 1 (no ball): players 1 & 2 rush the ball; 3 & 4 drop to our goal.
 *   - Phase 2 (we have it): the carrier passes to an open player whenever there
 *     is a clean lane to one; otherwise he dribbles away from the nearest
 *     opponents. Off the ball, everyone spreads to get open. Never shoots.
 */
export const brain: Brain = {
  name: "possession",
  params: {
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance" },
    laneIgnoreNear: { default: 35, min: 0, max: 100, step: 1, label: "Ignore opp. nearer than" },
    openMin: { default: 60, min: 20, max: 160, step: 5, label: "Open space needed" },
    evadeRange: { default: 220, min: 60, max: 400, step: 10, label: "Evade range" },
    supportRadius: { default: 190, min: 80, max: 350, step: 10, label: "Support distance" },
    receivePath: { default: 130, min: 40, max: 300, step: 10, label: "Receive path width" },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const LANE_CLEARANCE = p.laneClearance!;
    const LANE_IGNORE_NEAR = p.laneIgnoreNear!;
    const OPEN_MIN = p.openMin!;
    const EVADE_RANGE = p.evadeRange!;
    const SUPPORT_RADIUS = p.supportRadius!;
    const RECEIVE_PATH = p.receivePath!;

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const center: Vec2 = { x: W / 2, y: H / 2 };
    const clampX = (x: number) => Math.max(20, Math.min(W - 20, x));
    const clampY = (y: number) => Math.max(20, Math.min(H - 20, y));

    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const rushers = squad.slice(0, 2); // players 1 & 2
    const outlets = squad.slice(2); // players 3 & 4
    const carrier = view.teammates.find((t) => t.hasBall) ?? null;
    const weHaveBall = carrier !== null;

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
    const nearestOpp = (pt: Vec2): PlayerView | null => {
      let best: PlayerView | null = null;
      let bestD = Infinity;
      for (const o of view.opponents) {
        const d = dist(o.pos, pt);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      return best;
    };

    // Is a loose ball in flight heading toward this player (on its path)?
    const ballHeadingToward = (me: PlayerView): boolean => {
      if (view.ball.ownerId !== null) return false; // only loose balls
      const bv = view.ball.vel;
      const speed = Math.hypot(bv.x, bv.y);
      if (speed < 40) return false;
      const rx = me.pos.x - view.ball.pos.x;
      const ry = me.pos.y - view.ball.pos.y;
      if (rx * bv.x + ry * bv.y <= 0) return false; // ball moving away from me
      const perp = Math.abs(rx * bv.y - ry * bv.x) / speed;
      return perp < RECEIVE_PATH;
    };

    // Most-open teammate with a clean lane (a safe pass), or null.
    const openPassTarget = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
      let bestScore = OPEN_MIN; // must be at least this open to be worth a pass
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

    // Dribble away from the nearest opponents (with a pull to center to avoid
    // getting trapped against an edge).
    const dribbleAway = (me: PlayerView): TeamIntent[number] => {
      let ax = 0;
      let ay = 0;
      for (const o of view.opponents) {
        const dx = me.pos.x - o.pos.x;
        const dy = me.pos.y - o.pos.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < EVADE_RANGE) {
          ax += dx / (d * d);
          ay += dy / (d * d);
        }
      }
      let dx: number;
      let dy: number;
      if (ax === 0 && ay === 0) {
        dx = center.x - me.pos.x;
        dy = center.y - me.pos.y;
      } else {
        const L = Math.hypot(ax, ay);
        const cx = center.x - me.pos.x;
        const cy = center.y - me.pos.y;
        const CL = Math.hypot(cx, cy) || 1;
        dx = (ax / L) * 0.75 + (cx / CL) * 0.25;
        dy = (ay / L) * 0.75 + (cy / CL) * 0.25;
      }
      return { kind: "move", to: { x: me.pos.x + dx * 300, y: me.pos.y + dy * 300 } };
    };

    // Spread the given players around the ball to get open for a pass.
    const supportSpread = (players: PlayerView[]) => {
      const angles = [Math.PI / 2, (Math.PI * 7) / 6, (Math.PI * 11) / 6];
      [...players].sort((a, b) => a.id - b.id).forEach((me, i) => {
        const a = angles[i] ?? 0;
        let tx = clampX(view.ball.pos.x + Math.cos(a) * SUPPORT_RADIUS);
        let ty = clampY(view.ball.pos.y + Math.sin(a) * SUPPORT_RADIUS);
        const no = nearestOpp({ x: tx, y: ty });
        if (no && dist({ x: tx, y: ty }, no.pos) < OPEN_MIN) {
          const dx = tx - no.pos.x;
          const dy = ty - no.pos.y;
          const d = Math.hypot(dx, dy) || 1;
          tx = clampX(tx + (dx / d) * OPEN_MIN);
          ty = clampY(ty + (dy / d) * OPEN_MIN);
        }
        intents[me.id] = { kind: "move", to: { x: tx, y: ty } };
      });
    };

    if (carrier) {
      // We hold it: carrier passes to an open man or dribbles away; rest support.
      const tgt = openPassTarget(carrier);
      intents[carrier.id] = tgt ? { kind: "pass", to: tgt.pos } : dribbleAway(carrier);
      supportSpread(view.teammates.filter((t) => t.id !== carrier.id));
    } else {
      // No possession (phase 1): players 1 & 2 rush the ball. Players 3 & 4 hold
      // near our goal — but an outlet the ball is heading toward runs onto it to
      // receive a pass instead of sitting at home.
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

export default brain;
