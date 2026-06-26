import type { Brain, TeamIntent, WorldView } from "@claude-ball/brain-api";
import { kickoffBackPass } from "@claude-ball/brain-api";

/**
 * STRATEGY (human-designed):
 *   "Do nothing." Every player stands still — the bot never chases, presses, or
 *   shoots. The one exception is the kickoff: forward kicks/dribbles are illegal
 *   there, so when it's our kickoff we play the legal back pass and then go idle
 *   again. A free practice dummy for the local coach.
 */
export const afk: Brain = {
  name: "afk-bot",
  decide(view: WorldView): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const intents: TeamIntent = {};
    for (const me of view.teammates) {
      intents[me.id] = { kind: "idle" };
    }
    return intents;
  },
};
