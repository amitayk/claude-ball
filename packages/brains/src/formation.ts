import type { Brain, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { dist, kickoffBackPass } from "@kr/brain-api";

/**
 * STRATEGY (human-designed):
 *   - Each player owns a home zone (a 4-player line: keeper, two backs, one forward).
 *   - The single closest teammate to the ball chases it; everyone else holds
 *     their zone but slides toward the ball's vertical lane.
 *   - With the ball: if a teammate is meaningfully ahead toward goal, pass to
 *     them; otherwise shoot if near the goal, else dribble toward goal.
 */
export const formation: Brain = {
  name: "formation",
  decide(view: WorldView): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const intents: TeamIntent = {};
    const { width, height } = view.field;
    const goal: Vec2 = { x: view.targetGoalX, y: height / 2 };

    // Home zones as fractions of the field, ordered by player index.
    // Mirrored for the away side via attackDir.
    const lanes = view.teammates.map((_, i) => (i + 1) / (view.teammates.length + 1));
    const baseXFractions = [0.1, 0.32, 0.32, 0.6]; // keeper, back, back, forward

    // Find the teammate closest to the ball.
    let closest: PlayerView | null = null;
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
      // Hold zone: x from formation, y slides toward the ball's lane.
      const fx = baseXFractions[i] ?? 0.4;
      const homeX = view.side === "home" ? fx * width : (1 - fx) * width;
      const laneY = lanes[i]! * height;
      const targetY = laneY * 0.5 + view.ball.pos.y * 0.5;
      intents[me.id] = { kind: "move", to: { x: homeX, y: targetY } };
    });

    return intents;
  },
};

function withBall(me: PlayerView, view: WorldView, goal: Vec2): TeamIntent[number] {
  const distToGoal = dist(me.pos, goal);
  if (distToGoal < view.field.width * 0.28) {
    return { kind: "shoot", to: goal };
  }
  // Look for a teammate clearly ahead toward the goal.
  let bestMate: PlayerView | null = null;
  let bestAhead = 30; // must be at least this far ahead to be worth a pass
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
