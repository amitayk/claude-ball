import { writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brain } from "@claude-ball/brain-api";
import { runMatch } from "@claude-ball/engine";
import { brains } from "@claude-ball/brains";

interface Args {
  home: string;
  away: string;
  seed: number;
  ticks?: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(a);
    }
  }
  const home = positional[0] ?? "formation";
  const away = positional[1] ?? "chaser";
  return {
    home,
    away,
    seed: flags.seed ? Number(flags.seed) : 1,
    ticks: flags.ticks ? Number(flags.ticks) : undefined,
    out: flags.out,
  };
}

/** Resolve a brain by registry name, or by file path (default or named export). */
async function loadBrain(ref: string): Promise<Brain> {
  if (brains[ref]) return brains[ref]!;

  const looksLikePath = ref.includes("/") || ref.endsWith(".ts") || ref.endsWith(".js");
  if (looksLikePath) {
    const abs = isAbsolute(ref) ? ref : resolve(process.cwd(), ref);
    const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    const candidate = (mod.default ?? mod.brain ?? Object.values(mod)[0]) as Brain | undefined;
    if (!candidate || typeof candidate.decide !== "function") {
      throw new Error(`No Brain (with a decide() method) exported from ${ref}`);
    }
    return candidate;
  }

  throw new Error(
    `Unknown brain "${ref}". Built-ins: ${Object.keys(brains).join(", ")}. Or pass a path to a .ts file.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [home, away] = await Promise.all([loadBrain(args.home), loadBrain(args.away)]);

  const result = runMatch(home, away, { seed: args.seed, ticks: args.ticks });

  const homeName = home.name ?? args.home;
  const awayName = away.name ?? args.away;
  console.log(`\n  ${homeName}  ${result.score.home} - ${result.score.away}  ${awayName}`);
  console.log(`  (seed ${args.seed}, ${result.frames.length} frames)\n`);

  if (args.out) {
    const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
    writeFileSync(outPath, JSON.stringify(result));
    console.log(`  replay written to ${args.out}\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
