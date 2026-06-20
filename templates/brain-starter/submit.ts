/**
 * Submit your brain to the arena. Reads src/brain.ts and uploads it; the arena
 * places it on the ladder against the library bots (and other coaches' bots).
 *
 *   KR_HANDLE=yourname npm run submit
 *
 * Config via env: KR_API (arena URL), KR_HANDLE (your handle).
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const api = process.env.KR_API ?? "http://localhost:8787";
const handle = process.env.KR_HANDLE ?? "me";
const source = readFileSync("src/brain.ts", "utf8");
const name = source.match(/name:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? basename(resolve("."));

const res = await fetch(`${api}/api/submit`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ handle, name, source }),
});
const data = (await res.json()) as { error?: string; bot?: { name: string; handle: string; elo: number }; placement?: { record: { wins: number; draws: number; losses: number } } };

if (!res.ok || data.error) {
  console.error(`\n  submit failed: ${data.error}\n`);
  process.exit(1);
}
const r = data.placement!.record;
console.log(`\n  ✅ submitted "${data.bot!.name}" as @${data.bot!.handle}`);
console.log(`     placed at Elo ${data.bot!.elo}  (${r.wins}W-${r.draws}D-${r.losses}L vs the library)\n`);
