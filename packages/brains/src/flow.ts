import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { dist, kickoffBackPass } from "@kr/brain-api";

/**
 * TACTIC ("flow") — a nicer, possession-based side that still wins.
 *   - Keeper holds the goal and recovers the ball, then plays it short.
 *   - A deep playmaker offers a central outlet just behind the ball.
 *   - Two forwards make runs into the left/right channels ahead of the ball.
 *   - On the ball: shoot if close & clear, else pass forward to an open runner,
 *     else keep it with a safe pass under pressure, else carry forward.
 *   - The nearest man presses when we don't have it.
 *
 * The numbers below are tunable live from the coach control panel (params).
 * The knobs are fixed in code; turn the values to taste.
 */
export const flow: Brain = {
  name: "flow",
  params: {
    shootDistFrac: { default: 0.35, min: 0.1, max: 0.6, step: 0.01, label: "Shoot distance (×width)", help: "Distance from goal (×pitch width) at which it shoots. Higher = shoots from farther out." },
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance", help: "Clearance a pass lane needs from opponents. Higher = lanes count as blocked more easily, so it passes more cautiously." },
    laneIgnoreNear: { default: 35, min: 0, max: 100, step: 1, label: "Ignore opp. nearer than", help: "Opponents this close to the passer are ignored when judging lanes. Higher = attempts passes through more nearby pressure." },
    keeperStandoff: { default: 60, min: 0, max: 300, step: 5, label: "Keeper standoff", help: "How far in front of our goal the keeper sits. Higher = keeper plays farther off its line." },
    enemyCloseDist: { default: 70, min: 0, max: 200, step: 5, label: "Pressure radius", help: "Distance at which an opponent counts as pressuring. Higher = feels pressured from farther away, so it plays safe sooner." },
    playmakerDrop: { default: 90, min: 0, max: 300, step: 5, label: "Playmaker drop", help: "How far behind the ball the playmaker drops. Higher = offers a deeper, safer outlet." },
    forwardPush: { default: 150, min: 0, max: 500, step: 10, label: "Forward push", help: "How far ahead of the ball the forwards run. Higher = pushes the forwards higher up the pitch." },
    channelLeftY: { default: 0.28, min: 0.05, max: 0.5, step: 0.02, label: "Left channel", help: "Vertical lane for the left forward (fraction of height). Higher = positions the left forward lower." },
    channelRightY: { default: 0.72, min: 0.5, max: 0.95, step: 0.02, label: "Right channel", help: "Vertical lane for the right forward (fraction of height). Higher = positions the right forward lower." },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const SHOOT_DIST_FRAC = p.shootDistFrac!;
    const LANE_CLEARANCE = p.laneClearance!;
    const LANE_IGNORE_NEAR = p.laneIgnoreNear!;
    const KEEPER_STANDOFF = p.keeperStandoff!;
    const ENEMY_CLOSE_DIST = p.enemyCloseDist!;
    const PLAYMAKER_DROP = p.playmakerDrop!;
    const FORWARD_PUSH = p.forwardPush!;
    const CHANNEL_Y = [p.channelLeftY!, p.channelRightY!];

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const enemyGoal: Vec2 = { x: view.targetGoalX, y: H / 2 };
    const ownGoalCenter: Vec2 = { x: view.ownGoalX, y: H / 2 };
    const clampX = (x: number) => Math.max(60, Math.min(W - 60, x));

    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0]!;
    const playmaker = squad[1]!;
    const forwards = squad.slice(2);
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
    const pressured = (p: Vec2) =>
      view.opponents.some((o) => dist(o.pos, p) < ENEMY_CLOSE_DIST);

    // Is a loose ball in flight, in the attacking half, heading toward this
    // player (roughly on its path)? If so they should come to meet our pass
    // instead of running away. Limited to the attacking half so forwards don't
    // chase the opponent's clearances/shots through our own half.
    const RECEIVE_PATH_WIDTH = 110;
    const RECEIVE_MIN_SPEED = 60;
    const ballHeadingToward = (me: PlayerView): boolean => {
      if (view.ball.ownerId !== null) return false; // only loose balls in flight
      if ((view.ball.pos.x - W / 2) * view.attackDir <= 0) return false; // attacking half only
      const bv = view.ball.vel;
      const speed = Math.hypot(bv.x, bv.y);
      if (speed < RECEIVE_MIN_SPEED) return false;
      const rx = me.pos.x - view.ball.pos.x;
      const ry = me.pos.y - view.ball.pos.y;
      if (rx * bv.x + ry * bv.y <= 0) return false; // ball moving away from me
      // Ignore a ball heading into the enemy goal mouth — that's a shot, not a
      // pass to me; chasing it would block our own attempt.
      if (bv.x * view.attackDir > 1) {
        const tGoal = (view.targetGoalX - view.ball.pos.x) / bv.x;
        const yAtGoal = view.ball.pos.y + bv.y * tGoal;
        if (Math.abs(yAtGoal - H / 2) < view.field.goalHeight / 2) return false;
      }
      const perp = Math.abs(rx * bv.y - ry * bv.x) / speed; // distance to its path
      return perp < RECEIVE_PATH_WIDTH;
    };

    // Closest teammate that's meaningfully ahead with an open lane — a short
    // progressive pass that actually connects (not a long bomb to the farthest).
    const forwardOutlet = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
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
    // Closest teammate with an open lane (a safe ball-retaining pass).
    const safeOutlet = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
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

    // On-ball: shoot, else pass forward, else keep it, else carry.
    const carry = (me: PlayerView): TeamIntent[number] => {
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

    // Who presses when we don't have the ball: the closest outfielder.
    const outfield = [playmaker, ...forwards];
    let presser = outfield[0]!;
    let pressD = Infinity;
    for (const p of outfield) {
      const d = dist(p.pos, view.ball.pos);
      if (d < pressD) {
        pressD = d;
        presser = p;
      }
    }

    // --- keeper ---------------------------------------------------------
    if (keeper.hasBall) {
      // Play short to the nearest open man (the dropping playmaker), who is
      // coming toward the ball — not a long bomb to a forward running away.
      const out = safeOutlet(keeper);
      intents[keeper.id] = out ? { kind: "pass", to: out.pos } : carry(keeper);
    } else {
      const d = { x: view.ball.pos.x - ownGoalCenter.x, y: view.ball.pos.y - ownGoalCenter.y };
      const len = Math.hypot(d.x, d.y) || 1;
      intents[keeper.id] = {
        kind: "move",
        to: {
          x: ownGoalCenter.x + (d.x / len) * KEEPER_STANDOFF,
          y: ownGoalCenter.y + (d.y / len) * KEEPER_STANDOFF,
        },
      };
    }

    // --- playmaker ------------------------------------------------------
    if (playmaker.hasBall) {
      intents[playmaker.id] = carry(playmaker);
    } else if (!weHaveBall && presser.id === playmaker.id) {
      intents[playmaker.id] = { kind: "move", to: view.ball.pos };
    } else {
      intents[playmaker.id] = {
        kind: "move",
        to: { x: clampX(view.ball.pos.x - view.attackDir * PLAYMAKER_DROP), y: H / 2 },
      };
    }

    // --- forwards -------------------------------------------------------
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
            y: H * (CHANNEL_Y[i] ?? 0.5),
          },
        };
      }
    });

    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

export default flow;
