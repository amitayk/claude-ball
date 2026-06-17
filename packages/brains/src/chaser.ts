import type { Brain, TeamIntent, WorldView } from "@kr/brain-api";
import { kickoffBackPass } from "@kr/brain-api";

/**
 * STRATEGY (human-designed):
 *   "Everyone chases the ball. Whoever has it shoots at the enemy goal."
 *   At kickoff it plays the ball back (forward kicks/dribbles are illegal there).
 *   The dumbest possible team — a baseline to beat.
 */
export const chaser: Brain = {
  name: "chaser",
  decide(view: WorldView): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const intents: TeamIntent = {};
    const goal = { x: view.targetGoalX, y: view.field.height / 2 };
    for (const me of view.teammates) {
      intents[me.id] = me.hasBall ? { kind: "shoot", to: goal } : { kind: "move", to: view.ball.pos };
    }
    return intents;
  },
};
