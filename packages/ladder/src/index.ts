import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSandboxedMatch, bundleBrain } from "@kr/arena";
import { catalog } from "@kr/brains";
import { skillToElo, updateRating } from "./elo.js";

export { expectedScore, updateRating, skillToElo } from "./elo.js";

const brainsSrcDir = fileURLToPath(new URL("../../brains/src/", import.meta.url));

export interface LadderBot {
  name: string;
  kind: "library" | "user";
  elo: number;
  blurb?: string;
  /** Brain source (read on demand for library bots). */
  source: string;
}

/** Library bots as ladder entries, Elo-anchored from their round-robin skill. */
export const libraryBots: LadderBot[] = catalog.map((e) => ({
  name: e.name,
  kind: "library",
  elo: skillToElo(e.skill),
  blurb: e.blurb,
  source: readFileSync(`${brainsSrcDir}${e.name}.ts`, "utf8"),
}));

export interface OpponentResult {
  opponent: string;
  opponentElo: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface Placement {
  ok: boolean;
  /** Final Elo placement against the (fixed) library anchors. */
  rating?: number;
  record?: { wins: number; draws: number; losses: number };
  perOpponent?: OpponentResult[];
  /** Set when the submitted brain itself can't compile or keeps faulting. */
  error?: string;
}

const outcome = (gf: number, ga: number) => (gf > ga ? "win" : gf === ga ? "draw" : "loss");
const KEY = { win: "wins", draw: "draws", loss: "losses" } as const;

/**
 * Place a freshly-submitted brain on the ladder: it plays every library bot
 * (both sides, `seeds` seeds), and its Elo is moved against the library's fixed
 * anchors. Returns the placement rating + record. The candidate runs sandboxed.
 */
export async function placeBrainSource(
  source: string,
  opts: { seeds?: number; startElo?: number; k?: number } = {},
): Promise<Placement> {
  const seeds = opts.seeds ?? 3;
  const k = opts.k ?? 32;

  // Fail fast if the submission doesn't even compile.
  try {
    await bundleBrain(source);
  } catch (err) {
    return { ok: false, error: `does not compile: ${err instanceof Error ? err.message : String(err)}` };
  }

  let rating = opts.startElo ?? 1200;
  const record = { wins: 0, draws: 0, losses: 0 };
  const perOpponent: OpponentResult[] = [];

  for (const bot of libraryBots) {
    const per: OpponentResult = { opponent: bot.name, opponentElo: bot.elo, wins: 0, draws: 0, losses: 0 };
    for (let seed = 1; seed <= seeds; seed++) {
      for (const candidateHome of [true, false]) {
        const res = candidateHome
          ? await runSandboxedMatch(source, bot.source, { seed })
          : await runSandboxedMatch(bot.source, source, { seed });

        let result: "win" | "draw" | "loss";
        if (!res.ok || !res.result) {
          result = "loss"; // candidate timed out / crashed → forfeit
        } else {
          const s = res.result.score;
          result = candidateHome ? outcome(s.home, s.away) : outcome(s.away, s.home);
        }
        const scoreA = result === "win" ? 1 : result === "draw" ? 0.5 : 0;
        rating = updateRating(rating, bot.elo, scoreA, k);
        record[KEY[result]]++;
        per[KEY[result]]++;
      }
    }
    perOpponent.push(per);
  }

  return { ok: true, rating: Math.round(rating), record, perOpponent };
}

/** Library leaderboard (highest Elo first) for display. */
export function libraryLeaderboard(): { name: string; elo: number; blurb?: string }[] {
  return [...libraryBots]
    .sort((a, b) => b.elo - a.elo)
    .map((b) => ({ name: b.name, elo: b.elo, blurb: b.blurb }));
}
