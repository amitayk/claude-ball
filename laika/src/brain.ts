import type { Brain, ParamValues, TeamIntent, WorldView } from "@kr/brain-api";
import { dist, kickoffBackPass } from "@kr/brain-api";

/**
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  laika — YOUR TEAM BRAIN                                              │
 * │  The tactics are yours to design; your assistant only writes the     │
 * │  code (see CLAUDE.md).                                                │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * STRATEGY (edit this to describe YOUR plan in plain words). The starter
 * behaviour below is intentionally simple — replace it as you go:
 *   - The closest player to the ball goes and gets it.
 *   - With the ball: shoot if close to goal, otherwise dribble toward it.
 *   - Everyone else spreads across midfield.
 */
export const brain: Brain = {
  name: "laika",
  params: {
    shootDistFrac: {
      default: 0.3,
      min: 0.1,
      max: 0.6,
      step: 0.01,
      label: "Shoot distance (×width)",
      help: "Distance from goal (×pitch width) at which it shoots. Higher = shoots from farther out.",
    },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    // Take the kickoff legally (forward kicks/dribbles are blocked there).
    const ko = kickoffBackPass(view);
    if (ko) return ko;

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
          dist(me.pos, goal) < view.field.width * p.shootDistFrac!
            ? { kind: "shoot", to: goal }
            : { kind: "move", to: goal };
      } else if (me.id === closestId) {
        intents[me.id] = { kind: "move", to: view.ball.pos };
      } else {
        const laneY = ((i + 1) / (view.teammates.length + 1)) * view.field.height;
        intents[me.id] = { kind: "move", to: { x: view.field.width / 2, y: laneY } };
      }
    });

    return intents;
  },
};

export default brain;
