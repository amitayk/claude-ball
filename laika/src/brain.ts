import type { Brain, ParamValues, PlayerView, TeamIntent, WorldView } from "@kr/brain-api";
import { kickoffBackPass } from "@kr/brain-api";

/**
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  laika — YOUR TEAM BRAIN                                              │
 * │                                                                      │
 * │  Four roles, assigned by team order (lowest id = player 1, …):       │
 * │    1. Ball-winner   — sprints to the ball for first possession.      │
 * │    2. Goalkeeper    — holds the line in front of our own goal.       │
 * │    3. Striker       — pushes to the goal and shoots when on the ball. │
 * │    4. Helper        — second to the ball (backup ball-winner).       │
 * └────────────────────────────────────────────────────────────────────┘
 */
export const brain: Brain = {
  name: "laika",
  params: {},
  decide(view: WorldView, _params: ParamValues): TeamIntent {
    // Take the kickoff legally (forward kicks/dribbles are blocked there).
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    // Stable, side-agnostic role order: sort our players by id.
    const mine = [...view.teammates].sort((a, b) => a.id - b.id);
    const [winner, keeper, striker, helper] = mine;

    const intents: TeamIntent = {};

    // Player 1 — ball-winner: always run straight at the ball.
    if (winner) intents[winner.id] = { kind: "move", to: view.ball.pos };

    // Player 2 — goalkeeper: sit just off our own goal line and slide along
    // the goal mouth to stay between the ball and the goal.
    if (keeper) intents[keeper.id] = keep(view, keeper);

    // Player 3 — striker: shoot at the goal when on the ball, otherwise press
    // up toward the goal mouth.
    if (striker) {
      const goalCenter = { x: view.targetGoalX, y: view.field.height / 2 };
      if (striker.hasBall) {
        intents[striker.id] = { kind: "shoot", to: goalCenter };
      } else {
        // Hold a spot just short of the goal, level with the ball.
        const spot = { x: view.targetGoalX - view.attackDir * 40, y: view.ball.pos.y };
        intents[striker.id] = { kind: "move", to: spot };
      }
    }

    // Player 4 — helper: second to the ball, also chasing it as backup.
    if (helper) intents[helper.id] = { kind: "move", to: view.ball.pos };

    return intents;
  },
};

/** Goalkeeper line: x just inside our own goal, y tracking the ball within the mouth. */
function keep(view: WorldView, keeper: PlayerView): TeamIntent[number] {
  const { height, goalHeight } = view.field;
  const top = (height - goalHeight) / 2;
  const bottom = (height + goalHeight) / 2;
  const y = Math.max(top, Math.min(bottom, view.ball.pos.y));
  const x = view.ownGoalX + view.attackDir * 30; // a touch in front of the goal line
  return { kind: "move", to: { x, y } };
}

export default brain;
