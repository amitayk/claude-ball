/** Fixed simulation constants. All distances in field units, time in seconds. */
export const RULES = {
  field: {
    width: 1050,
    height: 680,
    goalHeight: 200,
  },

  /** Fixed timestep. 30 ticks per simulated second. */
  dt: 1 / 30,
  /** Match length in simulated seconds. */
  matchSeconds: 90,

  playersPerSide: 4,

  player: {
    radius: 12,
    /** Max speed in units/second. */
    maxSpeed: 200,
  },

  ball: {
    radius: 8,
    /** Per-tick velocity retention (rolling friction). */
    friction: 0.99,
    /** Speed below which the ball is considered stopped. */
    stopSpeed: 4,
    /** Speed imparted by a pass / a shot. */
    passSpeed: 340,
    shootSpeed: 560,
  },

  /** A player controls the ball when within this distance of it. */
  controlDistance: 28,
  /** Seconds a player must wait between kicks. */
  kickCooldown: 0.35,
} as const;

export type Rules = typeof RULES;
