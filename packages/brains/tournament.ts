/**
 * Round-robin tournament over the bot catalog. Each ordered pair plays both
 * ways across several seeds; skill is points earned / points possible, scaled
 * to 0–100. Run with `npx tsx packages/brains/tournament.ts` and paste the
 * resulting skill numbers into the catalog in src/index.ts.
 */
import { runMatch } from "@claude-ball/engine";
import { catalog } from "./src/index.js";

const SEEDS = Number(process.env.SEEDS ?? 6);

const points: Record<string, number> = {};
const played: Record<string, number> = {};
for (const e of catalog) {
  points[e.name] = 0;
  played[e.name] = 0;
}

function award(name: string, gf: number, ga: number) {
  played[name]!++;
  points[name]! += gf > ga ? 3 : gf === ga ? 1 : 0;
}

for (const home of catalog) {
  for (const away of catalog) {
    if (home.name === away.name) continue;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = runMatch(home.brain, away.brain, { seed });
      award(home.name, r.score.home, r.score.away);
      award(away.name, r.score.away, r.score.home);
    }
  }
}

const rows = catalog
  .map((e) => ({ name: e.name, skill: Math.round((points[e.name]! / (played[e.name]! * 3)) * 100) }))
  .sort((a, b) => b.skill - a.skill);

console.log(`\nRound-robin over ${SEEDS} seeds (win=3, draw=1):\n`);
for (const r of rows) console.log(`  ${r.name.padEnd(12)} skill ${r.skill}`);
console.log("");
