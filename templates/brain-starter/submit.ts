/**
 * Submit your brain to the arena. Reads src/brain.ts and uploads it; the arena
 * places it on the ladder against the house bots (and other coaches' bots).
 *
 *   npm run submit -- yourname      (works on macOS / Windows / Linux)
 *
 * The first submit for a handle claims it and saves an ownership key to
 * `.kr-key` (keep it!). Later submits reuse that key so nobody else can take
 * your handle. Config via env: KR_API (arena URL), KR_HANDLE (your handle).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const api = process.env.KR_API ?? "https://claude-ball.fly.dev";
// args: `npm run submit -- <handle> [--tournament <code>]` (cross-platform)
const args = process.argv.slice(2);
const ti = args.indexOf("--tournament");
const tournament = ti >= 0 ? args[ti + 1] : process.env.KR_TOURNAMENT;
// handle = first positional arg that isn't a flag or a flag's value
const handle = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--tournament") || process.env.KR_HANDLE || "me";
const source = readFileSync("src/brain.ts", "utf8");
const name = source.match(/name:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? basename(resolve("."));
const key = existsSync(".kr-key") ? readFileSync(".kr-key", "utf8").trim() : undefined;

const res = await fetch(`${api}/api/submit`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ handle, name, source, key, tournament }),
});
const data = (await res.json()) as {
  error?: string;
  key?: string;
  bot?: { name: string; handle: string; elo: number };
  placement?: { record: { wins: number; draws: number; losses: number } };
};

if (!res.ok || data.error) {
  console.error(`\n  submit failed: ${data.error}`);
  if (res.status === 403) console.error(`  (this handle is owned by someone else, or your .kr-key is missing/wrong)`);
  console.error("");
  process.exit(1);
}
if (data.key) {
  writeFileSync(".kr-key", data.key + "\n");
  console.log(`\n  🔑 claimed handle @${handle} - ownership key saved to .kr-key (keep it; don't commit it)`);
}
const r = data.placement!.record;
console.log(`\n  ✅ submitted "${data.bot!.name}" as @${data.bot!.handle}`);
console.log(`     placed at Elo ${data.bot!.elo}  (${r.wins}W-${r.draws}D-${r.losses}L vs the library)`);
if (tournament) console.log(`     entered tournament "${tournament}" → ${api}/tournament.html?slug=${encodeURIComponent(tournament)}`);
else console.log(`     watch it at ${api}/?home=${encodeURIComponent(data.bot!.name)}&away=blitz`);
console.log("");
