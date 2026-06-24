import type { Brain, ParamValues, PlayerView, TeamIntent, Vec2, WorldView } from "@claude-ball/brain-api";
import { dist, kickoffBackPass } from "@claude-ball/brain-api";

/**
 * TACTIC ("maestro") — the house boss. A Total-Football conductor that smothers
 * you off the ball and finishes clinically on it.
 *
 *   SHAPE (lowest id -> highest id): a sweeper-keeper, two ball-winning backs,
 *   and one permanent high striker who pins the enemy and sits on their (usually
 *   empty) net as the counter outlet. Keeping a man high is what flips field
 *   position against a swarm or a long-ball blitz — scrambles happen by THEIR
 *   net, not ours.
 *
 *   DEFENCE — two mechanisms run together:
 *     (A) SWEEPER-KEEPER: sits on the ball->ownGoal line at a standoff that
 *         scales with ball distance (up to lineHeight), so it steps up to win
 *         loose balls yet tucks back to guard the cone when threatened, and on
 *         winning it LAUNCHES the build to the high striker rather than dawdling.
 *     (B) MAN-MARKING: the back nearest the ball PRESSES the carrier; the other
 *         back shadows the enemy's most-dangerous man (its highest camping
 *         striker) GOAL-SIDE at a markTightness offset — so the long-ball outlet
 *         is pre-occupied. This is exactly what kills the blitz's keeper-launch
 *         and bodies-up the chaser's runs.
 *
 *   ATTACK: in the attacking half with an open net, shoot on sight (scatter is
 *   irrelevant into an empty net); against a guarded net, get CLOSE and central
 *   and place it into the corner FARTHEST from their keeper, where scatter is
 *   negligible. From deep it feeds the most-advanced outlet fast; it never
 *   launches hopeful long shots from its own half into traffic.
 */
export const maestro: Brain = {
  name: "maestro",
  params: {
    lineHeight: {
      default: 300, min: 120, max: 400, step: 10,
      label: "Sweeper-keeper height",
      help: "How far up the ball->goal line the sweeper-keeper steps to win loose balls and keep the line high. Higher = sweeps more aggressively up the pitch (wins the ball earlier, but less cover right on the goal line).",
    },
    markTightness: {
      default: 40, min: 12, max: 90, step: 2,
      label: "Man-marking closeness",
      help: "Goal-side gap the spare back leaves to the dangerous man it shadows. Higher = marks tighter/closer (denies the long-ball outlet harder, but easier to spin past).",
    },
    strikerHeight: {
      default: 170, min: 120, max: 380, step: 10,
      label: "Striker height",
      help: "How far in front of the enemy goal the high striker waits as the counter outlet. Higher = striker holds farther from goal; lower = camps right on their net.",
    },
    shootRange: {
      default: 0.30, min: 0.12, max: 0.45, step: 0.01,
      label: "Shoot range (×width)",
      help: "Distance from the enemy goal (×pitch width) inside which it places a finish at a guarded net. Higher = starts shooting from farther out (riskier, more scatter).",
    },
    dribbleFlair: {
      default: 0.5, min: 0, max: 1, step: 0.05,
      label: "Dribble flair",
      help: "How readily the carrier dribbles through a gap vs passing/shooting around it. Higher = takes on a closing defender more (beats over-committers, but more exposed to a clean tackle).",
    },
  },
  decide(view: WorldView, p: ParamValues): TeamIntent {
    const ko = kickoffBackPass(view);
    if (ko) return ko;

    const LINE_HEIGHT = p.lineHeight!;
    const MARK_TIGHT = p.markTightness!;
    const STRIKER_HEIGHT = p.strikerHeight!;
    const SHOOT_RANGE = p.shootRange!;
    const FLAIR = p.dribbleFlair!;

    const intents: TeamIntent = {};
    const W = view.field.width;
    const H = view.field.height;
    const GOAL_H = view.field.goalHeight;
    const aDir = view.attackDir;
    const clampX = (x: number) => Math.max(16, Math.min(W - 16, x));
    const clampY = (y: number) => Math.max(16, Math.min(H - 16, y));

    const enemyGoal: Vec2 = { x: view.targetGoalX, y: H / 2 };
    const ownGoal: Vec2 = { x: view.ownGoalX, y: H / 2 };

    // --- helpers ----------------------------------------------------------
    // Point-segment lane test: an opponent within LANE_CLEARANCE of the line
    // blocks it; opponents within 30u of the passer are ignored (he steps past).
    const LANE_CLEARANCE = 34;
    const laneBlocked = (from: Vec2, to: Vec2): boolean => {
      const abx = to.x - from.x;
      const aby = to.y - from.y;
      const len2 = abx * abx + aby * aby;
      const segLen = Math.sqrt(len2);
      return view.opponents.some((o) => {
        let t = len2 > 0 ? ((o.pos.x - from.x) * abx + (o.pos.y - from.y) * aby) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (t * segLen < 30) return false;
        const cx = from.x + abx * t;
        const cy = from.y + aby * t;
        return Math.hypot(o.pos.x - cx, o.pos.y - cy) < LANE_CLEARANCE;
      });
    };
    const openness = (pt: Vec2) =>
      view.opponents.length ? Math.min(...view.opponents.map((o) => dist(o.pos, pt))) : Infinity;

    const squad = [...view.teammates].sort((a, b) => a.id - b.id);
    const keeper = squad[0]!;
    const striker = squad[squad.length - 1]!; // highest id = high striker / finisher
    const backs = squad.slice(1, squad.length - 1); // the two ball-winning backs

    // Is the enemy mouth unguarded? (chaser/blitz chase the ball and leave it empty)
    const mouthGuarded = view.opponents.some((o) => dist(o.pos, enemyGoal) < 120);

    // Enemy's most dangerous man = the opponent deepest toward our goal (its high
    // camping striker / long-ball outlet). We shadow this man goal-side.
    const enemyDanger = view.opponents.length
      ? view.opponents.reduce((a, b) => (dist(a.pos, ownGoal) <= dist(b.pos, ownGoal) ? a : b))
      : null;
    // Their keeper-ish man (closest to THEIR goal) — used to pick the open corner.
    const enemyKeeper = view.opponents.length
      ? view.opponents.reduce((a, b) => (dist(a.pos, enemyGoal) <= dist(b.pos, enemyGoal) ? a : b))
      : null;

    // ----------------------------------------------------------------------
    // ON-BALL carry logic (shared by every teammate that wins the ball).
    // ----------------------------------------------------------------------
    const dribbleGap = (c: PlayerView): Vec2 => {
      const baseAng = Math.atan2(enemyGoal.y - c.pos.y, view.targetGoalX - c.pos.x);
      let best: Vec2 = { x: clampX(c.pos.x + aDir * 60), y: clampY(c.pos.y) };
      let bestOpen = -1;
      for (const off of [0, 0.4, -0.4, 0.8, -0.8]) {
        const a = baseAng + off;
        const pt = { x: clampX(c.pos.x + Math.cos(a) * 60), y: clampY(c.pos.y + Math.sin(a) * 60) };
        if ((pt.x - c.pos.x) * aDir < -5) continue;
        const o = openness(pt);
        if (o > bestOpen) { bestOpen = o; best = pt; }
      }
      return best;
    };

    // Closest meaningfully-ahead teammate with an open lane (progressive outlet).
    const forwardOutlet = (c: PlayerView): PlayerView | null => {
      let best: PlayerView | null = null, bestD = Infinity;
      for (const t of view.teammates) {
        if (t.id === c.id) continue;
        const ahead = (t.pos.x - c.pos.x) * aDir;
        if (ahead <= 40 || laneBlocked(c.pos, t.pos)) continue;
        const d = dist(c.pos, t.pos);
        if (d < bestD) { bestD = d; best = t; }
      }
      return best;
    };

    const carry = (c: PlayerView): TeamIntent[number] => {
      const distGoal = dist(c.pos, enemyGoal);
      const inAttackHalf = (c.pos.x - W / 2) * aDir > 0;
      const central = Math.abs(c.pos.y - H / 2) < GOAL_H;
      const near = view.opponents.reduce<{ o: PlayerView | null; d: number }>(
        (acc, o) => { const d = dist(o.pos, c.pos); return d < acc.d ? { o, d } : acc; },
        { o: null, d: Infinity },
      );

      // (1) OPEN-NET STRIKE: their mouth is unguarded and we're in the attacking
      // half with a clean lane — shoot. Scatter is irrelevant into an empty net,
      // and waiting only invites the swarm. The dagger vs chaser & blitz.
      if (!mouthGuarded && inAttackHalf && distGoal < W * 0.7 && !laneBlocked(c.pos, enemyGoal)) {
        return { kind: "shoot", to: enemyGoal };
      }

      // (2) CLOSE FINISH (guarded net): close & central — place it into the corner
      // farthest from their keeper, where scatter is negligible.
      if (distGoal < SHOOT_RANGE * W && central) {
        const keeperY = enemyKeeper ? enemyKeeper.pos.y : H / 2;
        const highY = H / 2 - (GOAL_H / 2) * 0.8;
        const lowY = H / 2 + (GOAL_H / 2) * 0.8;
        const aimHigh = Math.abs(highY - keeperY) >= Math.abs(lowY - keeperY);
        const a: Vec2 = { x: view.targetGoalX, y: aimHigh ? highY : lowY };
        if (!laneBlocked(c.pos, a)) return { kind: "shoot", to: a };
        const b: Vec2 = { x: view.targetGoalX, y: aimHigh ? lowY : highY };
        if (!laneBlocked(c.pos, b)) return { kind: "shoot", to: b };
        if (distGoal < SHOOT_RANGE * W * 0.7) return { kind: "shoot", to: enemyGoal };
      }

      // (3) DRIBBLE-THE-GAP: a defender has over-committed into us — carry into
      // the largest opening past them (flair gates how readily this fires).
      if (near.o && near.d < 44 && FLAIR > 0.1) {
        const toC = { x: c.pos.x - near.o.pos.x, y: c.pos.y - near.o.pos.y };
        const ov = near.o.vel;
        const closing = ov.x * toC.x + ov.y * toC.y > 0;
        const ballSide = (near.o.pos.x - c.pos.x) * aDir > 0;
        if (closing || ballSide) {
          const gap = dribbleGap(c);
          if (openness(gap) > 26 && (gap.x - c.pos.x) * aDir > -2) return { kind: "move", to: gap };
        }
      }

      // (4) PROGRESS: feed the closest meaningfully-ahead outlet. A long ball
      // (>300u) is struck (driven) so it carries; a shorter one is weighted to
      // arrive at his feet.
      const fwd = forwardOutlet(c);
      if (fwd) {
        const far = dist(c.pos, fwd.pos) > 300;
        return far ? { kind: "shoot", to: fwd.pos } : { kind: "pass", to: fwd.pos };
      }

      // (5) no outlet: drive at the enemy goal (manufacture a chance) — but if
      // pressured deep in our own half, knock a safe ball to the nearest open man.
      if (near.o && near.d < 70 && (c.pos.x - W / 2) * aDir < 0) {
        let safe: PlayerView | null = null, bestD = Infinity;
        for (const t of view.teammates) {
          if (t.id === c.id || laneBlocked(c.pos, t.pos)) continue;
          const d = dist(c.pos, t.pos);
          if (d < bestD) { bestD = d; safe = t; }
        }
        if (safe) return { kind: "pass", to: safe.pos };
      }
      return { kind: "move", to: enemyGoal };
    };

    // ----------------------------------------------------------------------
    // (A) SWEEPER-KEEPER.
    // ----------------------------------------------------------------------
    if (keeper.hasBall) {
      // Won it: launch the build to the high striker (or shoot the open net if
      // it's clear) — never dawdle in our own box where a turnover is fatal.
      if (!mouthGuarded && !laneBlocked(keeper.pos, enemyGoal)) {
        intents[keeper.id] = { kind: "shoot", to: enemyGoal };
      } else {
        intents[keeper.id] = { kind: "shoot", to: striker.pos };
      }
    } else {
      const ballToGoal = dist(view.ball.pos, ownGoal);
      const dx = view.ball.pos.x - ownGoal.x;
      const dy = view.ball.pos.y - ownGoal.y;
      const len = Math.hypot(dx, dy) || 1;
      // Standoff on the ball->goal line scales with ball distance up to lineHeight
      // (steps up to sweep when the ball is far, tucks toward the mouth when close).
      const off = Math.min(LINE_HEIGHT, ballToGoal * 0.5);
      intents[keeper.id] = {
        kind: "move",
        to: { x: ownGoal.x + (dx / len) * off, y: ownGoal.y + (dy / len) * off },
      };
    }

    // ----------------------------------------------------------------------
    // STRIKER: hold high near the enemy net as the counter outlet (or carry).
    // ----------------------------------------------------------------------
    if (striker.hasBall) {
      intents[striker.id] = carry(striker);
    } else {
      const sx = clampX(view.targetGoalX - aDir * STRIKER_HEIGHT);
      const sy = mouthGuarded ? H / 2 + (view.ball.pos.y - H / 2) * 0.25 : H / 2;
      intents[striker.id] = { kind: "move", to: { x: sx, y: clampY(sy) } };
    }

    // ----------------------------------------------------------------------
    // (B) BACKS: nearest to the ball presses the carrier; the other man-marks
    // the enemy's most dangerous man GOAL-SIDE (denying the long-ball outlet).
    // If a back has the ball, it carries.
    // ----------------------------------------------------------------------
    let presser: PlayerView = backs[0]!, pressD = Infinity;
    for (const b of backs) {
      const d = dist(b.pos, view.ball.pos);
      if (d < pressD) { pressD = d; presser = b; }
    }

    // Lead the press: a carrier dribbles the ball ~22u ahead of itself and keeps
    // moving, so chasing the ball's CURRENT spot forever trails a runner. Aim
    // where the carrier WILL be, nudged a touch goal-side so the tackle also shuts
    // the lane to our net — this is what actually wins the ball off a possession
    // side that dribbles into space, instead of merely shepherding it.
    const carrierOpp = view.opponents.find((o) => o.id === view.ball.ownerId) ?? null;
    const pressPoint = (): Vec2 => {
      const bp = view.ball.pos;
      if (!carrierOpp) {
        // loose ball: meet it where it's rolling.
        return { x: bp.x + view.ball.vel.x * 0.12, y: bp.y + view.ball.vel.y * 0.12 };
      }
      const lead = {
        x: carrierOpp.pos.x + carrierOpp.vel.x * 0.18,
        y: carrierOpp.pos.y + carrierOpp.vel.y * 0.18,
      };
      const gx = ownGoal.x - lead.x;
      const gy = ownGoal.y - lead.y;
      const gl = Math.hypot(gx, gy) || 1;
      return { x: lead.x + (gx / gl) * 10, y: lead.y + (gy / gl) * 10 };
    };

    for (const b of backs) {
      if (b.hasBall) {
        intents[b.id] = carry(b);
      } else if (b.id === presser.id) {
        const pp = pressPoint();
        intents[b.id] = { kind: "move", to: { x: clampX(pp.x), y: clampY(pp.y) } };
      } else if (enemyDanger) {
        // goal-side mark: stand markTightness goal-side of the dangerous man.
        const gx = ownGoal.x - enemyDanger.pos.x;
        const gy = ownGoal.y - enemyDanger.pos.y;
        const gl = Math.hypot(gx, gy) || 1;
        intents[b.id] = {
          kind: "move",
          to: {
            x: clampX(enemyDanger.pos.x + (gx / gl) * MARK_TIGHT),
            y: clampY(enemyDanger.pos.y + (gy / gl) * MARK_TIGHT),
          },
        };
      } else {
        intents[b.id] = { kind: "move", to: view.ball.pos };
      }
    }

    for (const t of view.teammates) if (!(t.id in intents)) intents[t.id] = { kind: "idle" };
    return intents;
  },
};

export default maestro;
