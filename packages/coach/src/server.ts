import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Brain, ParamValues } from "@claude-ball/brain-api";
import { resolveParams } from "@claude-ball/brain-api";
import { runMatch, type MatchResult } from "@claude-ball/engine";
import { importBrainFile, listOpponents, loadOpponent, SELF_OPPONENT } from "./brains.js";
import * as git from "./git.js";

// ── config / paths ──────────────────────────────────────────────────────────
const cwd = process.cwd();
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const brainPath = resolve(cwd, process.env.KR_BRAIN ?? "src/brain.ts");
const paramsPath = resolve(cwd, "src/brain.params.json");
const versionsDir = resolve(cwd, ".kr-versions");
const port = Number(process.env.PORT ?? 5177);

// ── live state ───────────────────────────────────────────────────────────────
let coachBrain: Brain | null = null;
let opponentName = "chaser";
let opponentBrain: Brain | null = null;
let seed = 1;
let overrides: ParamValues = loadSavedOverrides();
let lastReplay: MatchResult | null = null;
let lastError: string | null = null;

const clients = new Set<ServerResponse>();

/**
 * The side the local coach controls. In this solo workbench the coach is always
 * the home slot; sent to the client so it can mark "(you)" without tying any
 * left/right or goal semantics to it. For PvP/spectator this becomes dynamic.
 */
const YOU_SIDE = "home";

/** Per-brain cumulative compute budget for a match (ms). Generous — only a
 *  pathologically slow brain trips it. Tunable via env. */
const BRAIN_BUDGET_MS = Number(process.env.KR_BRAIN_BUDGET_MS ?? 3000);

function loadSavedOverrides(): ParamValues {
  try {
    if (existsSync(paramsPath)) return JSON.parse(readFileSync(paramsPath, "utf8")) as ParamValues;
  } catch {
    /* ignore malformed file */
  }
  return {};
}

// ── SSE plumbing ──────────────────────────────────────────────────────────────
function send(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown): void {
  for (const c of clients) send(c, event, data);
}

function paramsPayload() {
  const spec = coachBrain?.params ?? {};
  return { spec, values: resolveParams(spec, overrides) };
}
function statusPayload() {
  const mirror = opponentName === SELF_OPPONENT;
  return {
    you: coachBrain?.name ?? "your brain",
    // For a mirror match, label the opponent clearly rather than repeating the name.
    opponent: mirror ? `${coachBrain?.name ?? "your brain"} (mirror)` : opponentBrain?.name ?? opponentName,
    opponentRef: opponentName,
    opponents: listOpponents(),
    seed,
    score: lastReplay?.score ?? null,
    error: lastError,
  };
}
function pushAll(res: ServerResponse): void {
  send(res, "status", statusPayload());
  send(res, "params", paramsPayload());
  send(res, "versions", git.listVersions(cwd, ["src"]));
  if (lastReplay) send(res, "replay", { replay: lastReplay, tag: "current", you: YOU_SIDE });
  if (lastError) send(res, "error", { message: lastError });
}

// ── match running ─────────────────────────────────────────────────────────────
async function reloadCoachBrain(): Promise<void> {
  coachBrain = await importBrainFile(brainPath);
}
async function reloadOpponent(): Promise<void> {
  // "yourself" → a fresh, independent instance of the coach's own brain, so a
  // stateful brain's two sides don't share module-level state.
  opponentBrain =
    opponentName === SELF_OPPONENT ? await importBrainFile(brainPath) : await loadOpponent(opponentName, cwd);
}

function runAndBroadcast(tag = "current"): void {
  if (!coachBrain || !opponentBrain) return;
  lastReplay = runMatch(coachBrain, opponentBrain, { seed, homeParams: overrides, brainBudgetMs: BRAIN_BUDGET_MS });
  const fault = lastReplay.meta.fault;
  lastError = fault ? `${fault.side === YOU_SIDE ? "your brain" : "opponent"} ${fault.reason}` : null;
  broadcast("replay", { replay: lastReplay, tag, you: YOU_SIDE });
  broadcast("status", statusPayload());
  broadcast("params", paramsPayload());
  if (lastError) broadcast("error", { message: lastError });
}

/** Reload code from disk and re-run; report compile/runtime errors to the UI. */
async function reloadAndRun(tag = "reload"): Promise<void> {
  try {
    await reloadCoachBrain();
    await reloadOpponent();
    runAndBroadcast(tag);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    broadcast("error", { message: lastError });
    broadcast("status", statusPayload());
  }
}

// ── commands (POST /cmd) ───────────────────────────────────────────────────────
async function handleCommand(cmd: { type: string; [k: string]: unknown }): Promise<void> {
  switch (cmd.type) {
    case "rerun":
      runAndBroadcast();
      break;
    case "setOpponent":
      opponentName = String(cmd.name);
      await reloadOpponent();
      runAndBroadcast();
      break;
    case "setSeed":
      seed = Number(cmd.seed) || 1;
      runAndBroadcast();
      break;
    case "setParams":
      overrides = { ...overrides, ...(cmd.values as ParamValues) };
      runAndBroadcast();
      break;
    case "resetParams":
      // Revert live edits to the last *saved* params (brain.params.json), not
      // the brain's hardcoded defaults.
      overrides = loadSavedOverrides();
      runAndBroadcast();
      break;
    case "saveParams": {
      writeFileSync(paramsPath, JSON.stringify(overrides, null, 2) + "\n");
      try {
        git.commitPaths(cwd, ["src/brain.params.json"], `coach: tune ${coachBrain?.name ?? "brain"} params`);
      } catch {
        /* not a git repo / nothing to commit */
      }
      broadcast("versions", git.listVersions(cwd, ["src"]));
      broadcast("status", statusPayload());
      break;
    }
    case "previewVersion":
      await previewVersion(String(cmd.sha));
      break;
    case "rollback":
      git.checkoutPaths(cwd, String(cmd.sha), ["src/brain.ts", "src/brain.params.json"]);
      overrides = loadSavedOverrides();
      await reloadAndRun(`rolled back to ${String(cmd.sha).slice(0, 7)}`);
      broadcast("versions", git.listVersions(cwd, ["src"]));
      break;
    default:
      break;
  }
}

/** Run a historical version of the brain (without touching the working tree). */
async function previewVersion(sha: string): Promise<void> {
  const prefix = git.repoPrefix(cwd);
  const code = git.fileAtSha(cwd, sha, prefix + "src/brain.ts");
  if (code == null) {
    broadcast("error", { message: `could not read brain at ${sha.slice(0, 7)}` });
    return;
  }
  mkdirSync(versionsDir, { recursive: true });
  const tmp = join(versionsDir, `brain-${sha.slice(0, 12)}.ts`);
  writeFileSync(tmp, code);
  const oldParamsRaw = git.fileAtSha(cwd, sha, prefix + "src/brain.params.json");
  const oldOverrides = oldParamsRaw ? (JSON.parse(oldParamsRaw) as ParamValues) : {};
  try {
    const oldBrain = await importBrainFile(tmp);
    if (!opponentBrain) await reloadOpponent();
    const replay = runMatch(oldBrain, opponentBrain!, { seed, homeParams: oldOverrides });
    broadcast("replay", { replay, tag: `version ${sha.slice(0, 7)}`, you: YOU_SIDE });
  } catch (err) {
    broadcast("error", { message: `version ${sha.slice(0, 7)} failed: ${String(err)}` });
  }
}

// ── file watching (hot reload) ─────────────────────────────────────────────────
function watchSrc(): void {
  const srcDir = resolve(cwd, "src");
  if (!existsSync(srcDir)) return;
  let timer: NodeJS.Timeout | null = null;
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (filename && filename.endsWith(".params.json")) return; // saved by us
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reloadAndRun("hot reload"), 150);
  });
}

// ── http server ────────────────────────────────────────────────────────────────
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;

  if (url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    pushAll(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url === "/cmd" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        await handleCommand(JSON.parse(body || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(`{"ok":true}`);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // static assets
  const file = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  try {
    const buf = await readFile(join(publicDir, file));
    res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await reloadAndRun("startup");
  watchSrc();
  server.listen(port, () => {
    const name = coachBrain?.name ?? "your brain";
    console.log(`\n  ⚽ claude-ball coach — ${name} vs ${opponentName}`);
    console.log(`     open http://localhost:${port}`);
    console.log(`     edit src/brain.ts and the match re-runs automatically\n`);
  });
}

void main();
