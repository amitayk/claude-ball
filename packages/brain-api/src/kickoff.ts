import type { PlayerView, TeamIntent, WorldView } from "./types.js";

/**
 * Legal kickoff move for the team taking it: at kickoff you may not kick or
 * dribble toward the enemy half, so the carrier plays the ball BACK to the
 * deepest teammate (or knocks it into its own half if none is behind), which
 * opens play. Returns intents for all your players, or `null` when it isn't
 * your kickoff (so a brain can just run its normal logic).
 *
 * Use at the top of `decide`:
 *   const ko = kickoffBackPass(view);
 *   if (ko) return ko;
 */
export function kickoffBackPass(view: WorldView): TeamIntent | null {
  if (view.phase !== "kickoff" || view.kickoffSide !== view.side) return null;
  const carrier = view.teammates.find((t) => t.hasBall);
  if (!carrier) return null;

  // Deepest teammate (closest to our own goal) is the natural back-pass target.
  let receiver: PlayerView | null = null;
  for (const t of view.teammates) {
    if (t.id === carrier.id) continue;
    if (!receiver || Math.abs(t.pos.x - view.ownGoalX) < Math.abs(receiver.pos.x - view.ownGoalX)) {
      receiver = t;
    }
  }
  const behindUs = receiver !== null && (receiver.pos.x - carrier.pos.x) * view.attackDir < 0;
  const target = behindUs ? receiver!.pos : { x: carrier.pos.x - view.attackDir * 120, y: carrier.pos.y };

  const intents: TeamIntent = {};
  for (const t of view.teammates) {
    intents[t.id] = t.id === carrier.id ? { kind: "pass", to: target } : { kind: "idle" };
  }
  return intents;
}
