import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { dist, kickoffBackPass } from "@kr/brain-api";

/**
 * DEBUG TACTIC ("blitz") — assistant-written, for engine debugging.
 *   - Keeper sits on the line between the ball and our goal (in the shot path),
 *     then launches any ball it wins to the striker.
 *   - A striker stays high at the (undefended) enemy goal as an outlet.
 *   - Two pressers hunt the ball.
 *   - Carrier: shoot if the lane to goal is clear, else pass to a forward
 *     teammate, else dribble at the goal.
 *
 * Numbers are tunable from the coach control panel (params).
 */
export const blitz: Brain = {
  name: "blitz",
  params: {
    shootDistFrac: { default: 0.45, min: 0.1, max: 0.7, step: 0.01, label: "Shoot distance (×width)", help: "Distance from goal (×pitch width) at which it shoots. Higher = shoots from farther out." },
    laneClearance: { default: 36, min: 10, max: 90, step: 1, label: "Lane clearance", help: "Clearance a pass lane needs from opponents. Higher = lanes count as blocked more easily, so it passes more cautiously." },
    keeperStandoff: { default: 300, min: 0, max: 400, step: 5, label: "Keeper standoff", help: "How far up the shot line the keeper holds. Higher = keeper steps farther from our goal." },
    strikerGap: { default: 200, min: 50, max: 400, step: 5, label: "Striker gap from goal", help: "How far in front of the enemy goal the striker waits. Higher = striker holds farther from goal." },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const SHOOT_DIST_FRAC = p.shootDistFrac!;
    const LANE_CLEARANCE = p.laneClearance!;
    const KEEPER_STANDOFF = p.keeperStandoff!;
    const STRIKER_GAP = p.strikerGap!;

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const enemyGoal: Vec2 = { x: view.targetGoalX, y: H / 2 };
    const ownGoalCenter: Vec2 = { x: view.ownGoalX, y: H / 2 };

    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0]!;
    const striker = squad[squad.length - 1]!;
    const pressers = squad.slice(1, squad.length - 1);

    const laneBlocked = (from: Vec2, to: Vec2): boolean => {
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

    // Most-forward teammate (toward enemy goal) with an open lane, or null.
    const forwardOutlet = (me: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null;
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

    // Generic on-ball behavior: the enemy net is empty and a shot carries
    // nearly full-field, so SHOOT at goal whenever the lane is clear (from any
    // range). Otherwise feed a forward teammate (fast), else dribble at goal.
    const carry = (me: PlayerView): TeamIntent[number] => {
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

    // Keeper: stand on the line from our goal toward the ball. On winning it,
    // shoot straight at the empty net if the upfield lane is clear (chasers are
    // bunched at our end after their shot); otherwise launch to the striker.
    if (keeper.hasBall) {
      intents[keeper.id] = !laneBlocked(keeper.pos, enemyGoal)
        ? { kind: "shoot", to: enemyGoal }
        : { kind: "shoot", to: striker.pos };
    } else {
      const d = { x: view.ball.pos.x - ownGoalCenter.x, y: view.ball.pos.y - ownGoalCenter.y };
      const len = Math.hypot(d.x, d.y) || 1;
      intents[keeper.id] = {
        kind: "move",
        to: { x: ownGoalCenter.x + (d.x / len) * KEEPER_STANDOFF, y: ownGoalCenter.y + (d.y / len) * KEEPER_STANDOFF },
      };
    }

    // Striker: hold high at the enemy goal as an outlet (unless on the ball).
    intents[striker.id] = striker.hasBall
      ? carry(striker)
      : { kind: "move", to: { x: view.targetGoalX - view.attackDir * STRIKER_GAP, y: H / 2 } };

    // Pressers: carry if they have it, else hunt the ball.
    pressers.forEach((me) => {
      intents[me.id] = me.hasBall ? carry(me) : { kind: "move", to: view.ball.pos };
    });

    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

export default blitz;
