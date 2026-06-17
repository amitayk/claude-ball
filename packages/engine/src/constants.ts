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
    /** Speed below which the ball is considered stopped. */
    stopSpeed: 4,
    /**
     * Rolling friction as a constant deceleration (units/second²): the ball
     * loses this much speed every second until it stops. Constant decel (rather
     * than a per-tick multiply) means a kick's travel distance scales with the
     * square of its speed — harder kicks go proportionally farther and the ball
     * rolls to a natural stop. Approx stop distance ≈ speed² / (2 · decel):
     * a 340 pass ≈ 290u, a 560 shot ≈ 780u on the 1050-wide pitch.
     */
    deceleration: 200,
    /**
     * Kick speeds. A pass is weighted to arrive at its target (speed derived
     * from the travel distance via the deceleration above), clamped to this
     * range. A shot is always struck at maxKickSpeed for pace. With decel 200,
     * maxKickSpeed 560 lets a kick travel up to ~780 units.
     */
    minKickSpeed: 80,
    maxKickSpeed: 560,
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
