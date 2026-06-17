import type { Vec2 } from "./vec.js";
import type { ParamsSpec, ParamValues } from "./params.js";

/** Which side of the pitch a team plays. "home" defends the left goal (x=0). */
export type Side = "home" | "away";

/** Read-only view of a single player, as seen by a brain each tick. */
export interface PlayerView {
  readonly id: number;
  readonly side: Side;
  readonly pos: Vec2;
  readonly vel: Vec2;
  /** True if this player currently controls the ball. */
  readonly hasBall: boolean;
}

export interface BallView {
  readonly pos: Vec2;
  readonly vel: Vec2;
  /** id of the player controlling the ball, or null if loose. */
  readonly ownerId: number | null;
}

export interface FieldInfo {
  readonly width: number;
  readonly height: number;
  /** Vertical span of the goal mouth, centered on height/2. */
  readonly goalHeight: number;
}

/**
 * Everything a brain can observe on a given tick. Fully read-only:
 * the engine owns all state; a brain may only return Intents.
 *
 * Pitch orientation (all positions are in field units):
 *   - Origin (0,0) is the TOP-LEFT corner.
 *   - x increases to the RIGHT (0 → field.width); y increases DOWNWARD
 *     (0 → field.height). So "up" on screen = smaller y, "down" = larger y.
 *   - You attack toward `targetGoalX` and defend `ownGoalX`. `attackDir` is +1
 *     if you attack toward larger x (rightward) and -1 otherwise.
 *   - Don't hardcode left/right: a brain plays either side, so steer by
 *     `attackDir` / `targetGoalX` / `ownGoalX`, never by a literal x value.
 */
export interface WorldView {
  readonly tick: number;
  readonly dt: number;
  readonly field: FieldInfo;
  /** The side this brain is controlling. */
  readonly side: Side;
  /** +1 if this team attacks toward increasing x, -1 otherwise. */
  readonly attackDir: 1 | -1;
  /** x-coordinate of the goal this team is shooting at. */
  readonly targetGoalX: number;
  /** x-coordinate of the goal this team defends. */
  readonly ownGoalX: number;
  readonly ball: BallView;
  readonly teammates: readonly PlayerView[];
  readonly opponents: readonly PlayerView[];
  readonly score: { readonly home: number; readonly away: number };
}

/** A per-player command. The engine validates and clamps everything. */
export type Intent =
  | { kind: "idle" }
  /** Steer toward a point at full speed (engine clamps speed). */
  | { kind: "move"; to: Vec2 }
  /** Move in a direction (vector need not be normalized). */
  | { kind: "moveDir"; dir: Vec2 }
  /** Kick the ball toward a point at pass speed. Ignored if not in control. */
  | { kind: "pass"; to: Vec2 }
  /** Kick the ball toward a point at shot speed. Ignored if not in control. */
  | { kind: "shoot"; to: Vec2 };

/** Map of playerId -> Intent for the players this brain controls. */
export type TeamIntent = Record<number, Intent>;

/**
 * The contract every team brain implements.
 *
 * The HUMAN designs the strategy; the code here is only the mechanical
 * translation of that strategy into Intents. See CLAUDE.md.
 */
export interface Brain {
  /** Optional human-readable name shown in match output and replays. */
  readonly name?: string;
  /**
   * Optional tunable parameters. Each becomes a slider in the coach control
   * panel; the resolved values are passed to `decide` as its second argument.
   */
  readonly params?: ParamsSpec;
  /**
   * Called once per tick. Return an Intent for each controlled player.
   * `params` holds the resolved param values (defaults merged with any coach
   * overrides). Brains that declare no params can ignore it.
   */
  decide(view: WorldView, params: ParamValues): TeamIntent;
}
