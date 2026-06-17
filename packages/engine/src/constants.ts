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

  /**
   * Each kickoff, every player's start position is nudged by up to this many
   * units on each axis (seeded, so a given seed always produces the same
   * game). Gives matches some variety; set to 0 for identical layouts.
   */
  kickoffJitter: 20,

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
  /**
   * A ball moving faster than this is "hot" (just passed/shot): it can only be
   * taken by genuine contact (hotCaptureDistance), so passes fly past players
   * near the lane instead of sticking to them. Set above player.maxSpeed (200)
   * so a dribbled ball (carried at the owner's speed) stays controllable.
   */
  hotBallSpeed: 250,
  /** Capture distance for a hot ball: player radius + ball radius = real contact. */
  hotCaptureDistance: 20,
  /**
   * Possession hysteresis: the current owner keeps the ball while it stays
   * within controlDistance * this factor, and a challenger can only steal it by
   * being at least `stealMargin` units closer than the owner. This stops a
   * contested loose ball from strobing between several nearby players.
   */
  possessionRetainFactor: 1.5,
  stealMargin: 6,
  /** Seconds a player must wait between kicks. */
  kickCooldown: 0.35,
} as const;

export type Rules = typeof RULES;
