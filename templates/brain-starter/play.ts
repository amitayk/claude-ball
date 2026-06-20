import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brain } from "@claude-ball/brain-api";
import { runMatch } from "@claude-ball/engine";
import { brains } from "@claude-ball/brains";

/**
 * Run YOUR brain (src/brain.ts) against an opponent.
 *
 *   npm run match                      # you (home) vs chaser
 *   npm run match -- formation         # vs the built-in formation brain
 *   npm run match -- formation --seed 9 --out viewer/replay.json
 *   npm run match -- ./some/other-brain.ts   # vs another brain file
 *
 * Then `npm run viewer` to watch viewer/replay.json.
 */
interface Args {
  opponent: string;
  me: string;
  seed: number;
  ticks?: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else positional.push(a);
  }
  return {
    opponent: positional[0] ?? "chaser",
    me: flags.me ?? "./src/brain.ts",
    seed: flags.seed ? Number(flags.seed) : 1,
    ticks: flags.ticks ? Number(flags.ticks) : undefined,
    out: flags.out,
  };
}

/** Resolve a brain by built-in name, or by file path (default or named export). */
async function loadBrain(ref: string): Promise<Brain> {
  if (brains[ref]) return brains[ref]!;
  const abs = isAbsolute(ref) ? ref : resolve(process.cwd(), ref);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const candidate = (mod.default ?? mod.brain ?? Object.values(mod)[0]) as Brain | undefined;
  if (!candidate || typeof candidate.decide !== "function") {
    throw new Error(`No Brain (with a decide() method) found for "${ref}".`);
  }
  return candidate;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [me, opp] = await Promise.all([loadBrain(args.me), loadBrain(args.opponent)]);

  const result = runMatch(me, opp, { seed: args.seed, ticks: args.ticks });

  const myName = me.name ?? "my-team";
  const oppName = opp.name ?? args.opponent;
  console.log(`\n  ${myName}  ${result.score.home} - ${result.score.away}  ${oppName}`);
  console.log(`  (seed ${args.seed}, ${result.frames.length} frames)\n`);

  if (args.out) {
    const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result));
    console.log(`  replay written to ${args.out} — run: npm run viewer\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
