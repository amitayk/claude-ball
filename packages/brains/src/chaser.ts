import type { Brain, TeamIntent, WorldView } from "@kr/brain-api";
import { dist } from "@kr/brain-api";

/**
 * STRATEGY (human-designed):
 *   "Everyone chases the ball. Whoever has it shoots at the enemy goal."
 *   The dumbest possible team — a baseline to beat.
 */
export const chaser: Brain = {
  name: "chaser",
  decide(view: WorldView): TeamIntent {
    const intents: TeamIntent = {};
    const goal = { x: view.targetGoalX, y: view.field.height / 2 };
    for (const me of view.teammates) {
      if (me.hasBall) {
        intents[me.id] = { kind: "shoot", to: goal };
      } else {
        intents[me.id] = { kind: "move", to: view.ball.pos };
      }
    }
    return intents;
  },
};
