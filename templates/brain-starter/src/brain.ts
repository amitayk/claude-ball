import type { Brain, ParamValues, TeamIntent, WorldView } from "@claude-ball/brain-api";
import { kickoffBackPass } from "@claude-ball/brain-api";

/**
 * src/brain.ts — your team's brain. The coach designs the tactics; you (Claude)
 * write them in here. This file starts empty: every player idles until the coach
 * tells you what they should do.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────
 * A Brain is an object with three members:
 *   • name    — the bot's display name.
 *   • params  — tunable knobs that become live sliders in the control panel.
 *   • decide  — called once per tick; returns one Intent per player.
 *
 * ─── Knobs (params) ─────────────────────────────────────────────────────────
 * Every value the coach should be able to turn live goes here. Each knob needs
 * default/min/max/step, a label, and a `help` string (required) that says what
 * it is AND what raising it does ("Higher = …"). The resolved values arrive as
 * the second argument to `decide`. Example of the shape:
 *
 *   params: {
 *     pressDistance: {
 *       default: 70, min: 0, max: 200, step: 5,
 *       label: "Press distance",
 *       help: "Distance at which an opponent counts as pressuring the ball. " +
 *             "Higher = feels pressured from farther away, so it plays safe sooner.",
 *     },
 *   },
 *
 * Then inside decide: `const PRESS = p.pressDistance!;`
 *
 * ─── Tick lifecycle (what `decide` does each tick) ──────────────────────────
 *   1. Handle the kickoff: `const ko = kickoffBackPass(view); if (ko) return ko;`
 *      (returns a legal back-pass on your kickoff, else null).
 *   2. Read the world from `view`: `ball` ({ pos, vel, ownerId }), `teammates`
 *      and `opponents` (each { id, side, pos, vel, hasBall }), `field`,
 *      `attackDir`, `targetGoalX`, `ownGoalX`, `phase`, `score`, `tick`, `dt`.
 *      Orient by attackDir / targetGoalX / ownGoalX — never hardcode left/right.
 *   3. Decide each player's Intent and put it in the result, keyed by player id:
 *        { kind: "idle" }
 *        { kind: "move",    to:  Vec2 }
 *        { kind: "moveDir", dir: Vec2 }
 *        { kind: "pass",    to:  Vec2, range?: number }   // ball comes to rest at `to`
 *        { kind: "shoot",   to:  Vec2 }
 *      Kicks only act when that player has the ball.
 *   4. Return a TeamIntent (Record<playerId, Intent>) with an entry for every
 *      player you control.
 *
 * ─── Correctness rules ──────────────────────────────────────────────────────
 *   • Side-agnostic: orient by attackDir/targetGoalX/ownGoalX, never hardcode a side.
 *   • Deterministic: no Math.random(), no clock reads — matches must replay identically.
 *   • Read-only: never mutate `view`; decide is a pure function of (view, params).
 *   • Return an Intent for every player you control, every tick.
 *
 * Module-level `let`s are allowed for bookkeeping derived from the tick stream
 * (e.g. tracking who held the ball last) — declare them below the brain.
 */
export const brain: Brain = {
  name: "my-team",
  params: {},
  decide(view: WorldView, _p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const intents: TeamIntent = {};
    for (const t of view.teammates) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

export default brain;
