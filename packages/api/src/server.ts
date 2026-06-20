import { createServer, type ServerResponse } from "node:http";
import { placeBrainSource } from "@kr/ladder";
import { runSandboxedMatch } from "@kr/arena";
import { JsonStore } from "./store.js";

const store = new JsonStore(process.env.KR_DATA ?? ".data/arena.json");
const port = Number(process.env.PORT ?? 8787);
const PLACEMENT_SEEDS = Number(process.env.KR_PLACEMENT_SEEDS ?? 3);

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && url === "/api/leaderboard") {
    return json(res, 200, { bots: store.leaderboard() });
  }

  // Watch any matchup: run it on demand (deterministic, sandboxed) and return
  // the replay. ?home=<name|id>&away=<name|id>&seed=<n>
  if (req.method === "GET" && url === "/api/watch") {
    const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const home = store.find(q.get("home") ?? "");
    const away = store.find(q.get("away") ?? "");
    const seed = Number(q.get("seed") ?? "1") || 1;
    if (!home || !away) return json(res, 404, { error: "unknown bot(s)" });
    runSandboxedMatch(home.source, away.source, { seed }).then((r) => {
      if (!r.ok || !r.result) return json(res, 400, { error: r.fault?.message ?? "match failed" });
      return json(res, 200, {
        home: { name: home.name, handle: home.handle, kind: home.kind },
        away: { name: away.name, handle: away.handle, kind: away.kind },
        seed,
        replay: r.result,
      });
    });
    return;
  }

  if (req.method === "POST" && url === "/api/submit") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { handle, name, source } = JSON.parse(body || "{}") as {
          handle?: string;
          name?: string;
          source?: string;
        };
        if (!handle || !name || !source) {
          return json(res, 400, { error: "handle, name, and source are required" });
        }
        // NOTE: placement runs inline here for local dev. In production this
        // becomes a queued job so submits return immediately (see DEPLOYMENT.md).
        const placement = await placeBrainSource(source, { seeds: PLACEMENT_SEEDS });
        if (!placement.ok) return json(res, 400, { error: placement.error });
        const bot = store.upsertUserBot({ handle, name, elo: placement.rating!, source, record: placement.record });
        return json(res, 200, { bot: { ...bot, source: undefined }, placement });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`\n  🏟  cladu-regel arena API on http://localhost:${port}`);
  console.log(`     GET  /api/leaderboard`);
  console.log(`     POST /api/submit  { handle, name, source }\n`);
});
