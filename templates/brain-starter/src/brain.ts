import type { Brain, TeamIntent, WorldView } from "@kr/brain-api";
import { dist } from "@kr/brain-api";

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  YOUR TEAM BRAIN                                                       │
 * │                                                                       │
 * │  The strategy below is YOURS to design. Describe the tactics you      │
 * │  want to your AI assistant and have it write the code — but the       │
 * │  thinking is yours (see CLAUDE.md).                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * STRATEGY (edit this to describe YOUR plan in plain words):
 *   - Closest player to the ball goes and gets it.
 *   - With the ball, shoot if near the goal, otherwise dribble toward it.
 *   - Everyone else spreads out across the field.
 *
 * This starter is intentionally simple. Beat the built-in `chaser`, then
 * `formation`, then your friends.
 */
export const brain: Brain = {
  name: "my-team",
  decide(view: WorldView): TeamIntent {
    const intents: TeamIntent = {};
    const goal = { x: view.targetGoalX, y: view.field.height / 2 };

    // Who is closest to the ball?
    let closestId = view.teammates[0]!.id;
    let closestD = Infinity;
    for (const t of view.teammates) {
      const d = dist(t.pos, view.ball.pos);
      if (d < closestD) {
        closestD = d;
        closestId = t.id;
      }
    }

    view.teammates.forEach((me, i) => {
      if (me.hasBall) {
        intents[me.id] =
          dist(me.pos, goal) < view.field.width * 0.3
            ? { kind: "shoot", to: goal }
            : { kind: "move", to: goal };
      } else if (me.id === closestId) {
        intents[me.id] = { kind: "move", to: view.ball.pos };
      } else {
        // Spread out: hold a vertical lane near midfield.
        const laneY = ((i + 1) / (view.teammates.length + 1)) * view.field.height;
        intents[me.id] = { kind: "move", to: { x: view.field.width / 2, y: laneY } };
      }
    });

    return intents;
  },
};

export default brain;
