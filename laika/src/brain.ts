import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@kr/brain-api";
import { kickoffBackPass } from "@kr/brain-api";

/**
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  laika — YOUR TEAM BRAIN                                              │
 * │                                                                      │
 * │  Roles, assigned by team order (lowest id = player 1, …):            │
 * │    1. Ball-winner — sprints to the ball for first possession.        │
 * │    2. Goalkeeper  — holds the line in front of our own goal.         │
 * │    3. Striker     — off the ball, finds an open spot in front of     │
 * │                     goal; shoots immediately if it gets the ball.    │
 * │    4. Finisher    — drives at goal and shoots in the final third;    │
 * │                     passes to P3 under pressure.                     │
 * │                                                                      │
 * │  Phases: "attack" = we control the ball; otherwise defend/chase.     │
 * │  In attack any non-P4 carrier passes to P4 to set up the finish.     │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** How far in front of the goal the off-ball attackers position (field units). */
const GOAL_FRONT = 60;
/** Fraction of the field nearest the goal that counts as the final third. */
const FINAL_THIRD = 0.33;

export const brain: Brain = {
  name: "laika",
  params: {
    pressDistance: {
      default: 70,
      min: 0,
      max: 200,
      step: 5,
      label: "Press distance",
      help: "How close an enemy must be to the player-4 ball carrier to count as pressure. Higher = pressured from farther away, so player 4 passes to player 3 (instead of shooting) sooner.",
    },
    laneClearance: {
      default: 25,
      min: 0,
      max: 100,
      step: 5,
      label: "Lane clearance",
      help: "How far an opponent must sit from the passing line for player 3's spot to count as open. Higher = a wider strip must be clear, so lanes count as blocked more easily and player 3 is pickier about where it stands.",
    },
  },
  decide(view: WorldView, params: ParamValues): TeamIntent {
    // Take the kickoff legally (forward kicks/dribbles are blocked there).
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const pressDistance = params.pressDistance as number;
    const laneClearance = params.laneClearance as number;

    // Stable, side-agnostic role order: sort our players by id.
    const mine = [...view.teammates].sort((a, b) => a.id - b.id);
    const [p1, p2, p3, p4] = mine;

    // Attack phase: a teammate controls the ball.
    const carrier = mine.find((t) => t.hasBall) ?? null;
    const attacking = carrier !== null;

    const goalCenter: Vec2 = { x: view.targetGoalX, y: view.field.height / 2 };
    const intents: TeamIntent = {};

    // Player 1 — ball-winner: run at the ball when we don't have it.
    if (p1) intents[p1.id] = { kind: "move", to: view.ball.pos };

    // Player 2 — goalkeeper: hold the line in front of our own goal.
    if (p2) intents[p2.id] = keep(view, p2);

    // Player 3 — striker.
    if (p3) {
      if (attacking) {
        // Find an open spot in front of the goal (clear lane from the carrier).
        intents[p3.id] = { kind: "move", to: openSpot(view, carrier!.pos, laneClearance) };
      } else {
        // Off-attack: press up toward the goal mouth, level with the ball.
        intents[p3.id] = { kind: "move", to: { x: view.targetGoalX - view.attackDir * 40, y: view.ball.pos.y } };
      }
    }

    // Player 4 — finisher.
    if (p4) {
      if (attacking) {
        // Off the ball: run toward the goal, ready to receive and finish.
        intents[p4.id] = { kind: "move", to: { x: view.targetGoalX - view.attackDir * GOAL_FRONT, y: goalCenter.y } };
      } else {
        // Off-attack: second to the ball.
        intents[p4.id] = { kind: "move", to: view.ball.pos };
      }
    }

    // Carrier overrides — whoever actually holds the ball.
    if (carrier) {
      if (p3 && carrier.id === p3.id) {
        // Player 3 received the ball: shoot immediately.
        intents[carrier.id] = { kind: "shoot", to: goalCenter };
      } else if (p4 && carrier.id === p4.id) {
        // Player 4 on the ball.
        const pressured = view.opponents.some((o) => dist(o.pos, p4.pos) < pressDistance);
        if (pressured && p3) {
          intents[carrier.id] = { kind: "pass", to: p3.pos };
        } else if (inFinalThird(view, p4.pos)) {
          intents[carrier.id] = { kind: "shoot", to: goalCenter };
        } else {
          intents[carrier.id] = { kind: "move", to: goalCenter };
        }
      } else if (p4) {
        // Anyone else (e.g. player 1 just won it): pass to player 4.
        intents[carrier.id] = { kind: "pass", to: p4.pos };
      }
    }

    return intents;
  },
};

/** Goalkeeper line: x just inside our own goal, y tracking the ball within the mouth. */
function keep(view: WorldView, _keeper: PlayerView): TeamIntent[number] {
  const { height, goalHeight } = view.field;
  const top = (height - goalHeight) / 2;
  const bottom = (height + goalHeight) / 2;
  const y = Math.max(top, Math.min(bottom, view.ball.pos.y));
  const x = view.ownGoalX + view.attackDir * 30; // a touch in front of the goal line
  return { kind: "move", to: { x, y } };
}

/** True when `pos` is within the final third of the field nearest the target goal. */
function inFinalThird(view: WorldView, pos: Vec2): boolean {
  const line = view.targetGoalX - view.attackDir * FINAL_THIRD * view.field.width;
  return (pos.x - line) * view.attackDir >= 0;
}

/**
 * A spot in front of the target goal that the carrier has a clear line to.
 * Samples positions across the goal mouth and returns the one nearest goal
 * centre whose pass lane no opponent is within `laneClearance` of. Falls back to
 * goal centre if none is clear.
 */
function openSpot(view: WorldView, from: Vec2, laneClearance: number): Vec2 {
  const { height, goalHeight } = view.field;
  const top = (height - goalHeight) / 2;
  const bottom = (height + goalHeight) / 2;
  const x = view.targetGoalX - view.attackDir * GOAL_FRONT;
  const center = height / 2;

  const samples = 7;
  let best: Vec2 | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < samples; i++) {
    const y = top + ((bottom - top) * i) / (samples - 1);
    const cand: Vec2 = { x, y };
    const clear = view.opponents.every((o) => distToSegment(o.pos, from, cand) >= laneClearance);
    if (!clear) continue;
    const gap = Math.abs(y - center);
    if (gap < bestGap) {
      bestGap = gap;
      best = cand;
    }
  }
  return best ?? { x, y: center };
}

/** Distance from point `p` to the segment a→b. */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default brain;
