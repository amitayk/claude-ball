import type { Brain, TeamIntent, WorldView } from "@kr/brain-api";

/**
 * STRATEGY (human-designed):
 *   "Everyone chases the ball. Whoever has it shoots at the enemy goal."
 *   At kickoff (where a forward kick is illegal) the taker plays the ball back
 *   to get the game going. The dumbest possible team — a baseline to beat.
 */
export const chaser: Brain = {
  name: "chaser",
  decide(view: WorldView): TeamIntent {
    const intents: TeamIntent = {};
    const goal = { x: view.targetGoalX, y: view.field.height / 2 };
    const takingKickoff = view.phase === "kickoff" && view.kickoffSide === view.side;

    for (const me of view.teammates) {
      if (me.hasBall) {
        if (takingKickoff) {
          // Must play it back. Pass to the deepest teammate (nearest our own
          // goal) if they're behind us, else just knock it back into our half.
          let receiver: typeof me | null = null;
          for (const t of view.teammates) {
            if (t.id === me.id) continue;
            if (!receiver || Math.abs(t.pos.x - view.ownGoalX) < Math.abs(receiver.pos.x - view.ownGoalX)) {
              receiver = t;
            }
          }
          const behindUs = receiver !== null && (receiver.pos.x - me.pos.x) * view.attackDir < 0;
          const target = behindUs
            ? receiver!.pos
            : { x: me.pos.x - view.attackDir * 120, y: me.pos.y };
          intents[me.id] = { kind: "pass", to: target };
        } else {
          intents[me.id] = { kind: "shoot", to: goal };
        }
      } else {
        intents[me.id] = { kind: "move", to: view.ball.pos };
      }
    }
    return intents;
  },
};
