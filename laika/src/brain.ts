import type { Brain, ParamValues, TeamIntent, WorldView } from "@kr/brain-api";
import { kickoffBackPass } from "@kr/brain-api";

/**
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  laika — YOUR TEAM BRAIN                                              │
 * │  Empty slate. You design the tactics; your assistant only writes the │
 * │  code (see CLAUDE.md). Describe what each player should do and have   │
 * │  your assistant implement it here.                                   │
 * └────────────────────────────────────────────────────────────────────┘
 */
export const brain: Brain = {
  name: "laika",
  params: {},
  decide(view: WorldView, _params: ParamValues): TeamIntent {
    // Take the kickoff legally (forward kicks/dribbles are blocked there).
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    // Nothing else yet — every player stands still until you add behaviour.
    const intents: TeamIntent = {};
    for (const me of view.teammates) intents[me.id] = { kind: "idle" };
    return intents;
  },
};

export default brain;
