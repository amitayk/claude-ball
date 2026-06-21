// Scaffold a new bot folder from the starter template, named on the way.
//   npm run new <name>              (you'll cd into it yourself)
//   npm run new <name> -- --here    (caller drops you into the folder; the
//                                    website one-liner ends with `&& cd <name>`)
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
// --here means the caller (the website one-liner) cd's into the folder for you,
// so we skip the "cd <name>" step in the closing message.
const fromOneliner = args.includes("--here");
const name = args.find((a) => !a.startsWith("-"));
const SAFE = /^[a-z0-9_-]{2,24}$/i;

if (!name || !SAFE.test(name)) {
  console.error("\n  Usage: npm run new <name>   (2-24 chars: letters, digits, - or _)\n");
  process.exit(1);
}
if (existsSync(name)) {
  console.error(`\n  A folder "${name}" already exists here - pick another name.\n`);
  process.exit(1);
}

const SKIP = new Set(["node_modules", ".kr-versions", ".kr-key", "brain.params.json", "replay.json"]);
cpSync("templates/brain-starter", name, {
  recursive: true,
  filter: (src) => !SKIP.has(src.split("/").pop()),
});

// package.json: scope to the new name, fix the path depth, describe it.
const pkgPath = `${name}/package.json`;
writeFileSync(
  pkgPath,
  readFileSync(pkgPath, "utf8")
    .replace(/"@claude-ball\/brain-starter"/, `"@claude-ball/${name}"`)
    .replace(/\.\.\/\.\.\/packages/g, "../packages")
    .replace(/"description":\s*"[^"]*"/, `"description": "The ${name} team brain"`),
);

// brain.ts: set the bot's name
const brainPath = `${name}/src/brain.ts`;
writeFileSync(
  brainPath,
  readFileSync(brainPath, "utf8").replace(/name:\s*["'`][^"'`]*["'`]/, `name: "${name}"`),
);

// register as a workspace so its @claude-ball/* deps resolve
const root = JSON.parse(readFileSync("package.json", "utf8"));
if (!root.workspaces.includes(name)) {
  root.workspaces.push(name);
  writeFileSync("package.json", JSON.stringify(root, null, 2) + "\n");
}

console.log(`\n  Created ./${name} - installing dependencies...\n`);
execSync("npm install", { stdio: "inherit" });

console.log(`\n  ✅ "${name}" is ready.`);
if (fromOneliner) {
  // the one-liner's trailing `&& cd ${name}` lands them in the folder next
  console.log(`     You'll land in ./${name} - run your coding agent (claude / codex / ...) there`);
  console.log(`     and build your team's brain.`);
} else {
  console.log(`     cd ${name}`);
  console.log(`     run your coding agent (claude / codex / ...) and build your team's brain`);
}
console.log(`     npm run coach  - watch it play live as you build`);
console.log(`     npm run submit -- ${name}  - enter the arena\n`);
