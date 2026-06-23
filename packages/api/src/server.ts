import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { placeBrainSource } from "@claude-ball/ladder";
import { runSandboxedMatch } from "@claude-ball/arena";
import { JsonStore } from "./store.js";
import { allow, WorkQueue } from "./limits.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const ADMIN_TOKEN = process.env.KR_ADMIN_TOKEN ?? "";

// CPU-heavy match work runs through one bounded queue so a flood can't pile up.
const heavy = new WorkQueue(
  Number(process.env.KR_HEAVY_CONCURRENCY ?? 2),
  Number(process.env.KR_HEAVY_MAX_PENDING ?? 24),
);
const clientIp = (req: IncomingMessage): string =>
  (req.headers["fly-client-ip"] as string) ||
  ((req.headers["x-forwarded-for"] as string) || "").split(",")[0]!.trim() ||
  req.socket.remoteAddress ||
  "unknown";

// The API also serves the web UI, so one deploy gives the whole product at one
// origin (no second host, no CORS in production).
const webDir = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

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
  const url = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && url === "/api/leaderboard") {
    return json(res, 200, { bots: store.leaderboard() });
  }

  // Watch any matchup: run it on demand (deterministic, sandboxed) and return
  // the replay. ?home=<name|id>&away=<name|id>&seed=<n>
  if (req.method === "GET" && url === "/api/watch") {
    if (!allow(`watch:${clientIp(req)}`, 40, 60_000)) {
      return json(res, 429, { error: "slow down - too many matches; try again in a moment" });
    }
    const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const home = store.find(q.get("home") ?? "");
    const away = store.find(q.get("away") ?? "");
    const seed = Number(q.get("seed") ?? "1") || 1;
    if (!home || !away) return json(res, 404, { error: "unknown bot(s)" });
    if (heavy.full) return json(res, 503, { error: "arena busy - try again in a moment" });
    heavy.run(() => runSandboxedMatch(home.source, away.source, { seed })).then((r) => {
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
        if (!allow(`submit:${clientIp(req)}`, 6, 600_000)) {
          return json(res, 429, { error: "too many submissions - try again in a few minutes" });
        }
        const { handle, name, source, key } = JSON.parse(body || "{}") as {
          handle?: string;
          name?: string;
          source?: string;
          key?: string;
        };
        if (!handle || !name || !source) {
          return json(res, 400, { error: "handle, name, and source are required" });
        }
        if (!/^[a-z0-9_-]{2,24}$/i.test(handle)) {
          return json(res, 400, { error: "handle must be 2-24 chars: letters, digits, - or _" });
        }
        // Don't let a submission take a house bot's name/handle (it would be
        // shadowed in watch-by-name and confuse the board).
        const clash = store.find(name) ?? store.find(handle);
        if (clash && clash.kind === "library") {
          return json(res, 400, { error: `"${clash.name}" is a house bot name - pick another` });
        }
        // Ownership: first submit for a handle claims it and gets a key; later
        // submits to that handle must present the same key.
        const existing = store.find(`user-${handle}`);
        let issuedKey: string | undefined;
        let secret: string;
        if (existing && existing.secret) {
          if (!key || sha256(key) !== existing.secret) {
            return json(res, 403, { error: `handle "${handle}" is taken - wrong or missing key` });
          }
          secret = existing.secret;
        } else {
          issuedKey = randomBytes(18).toString("base64url");
          secret = sha256(issuedKey);
        }
        // Placement is CPU-heavy (many sandboxed matches); run it through the
        // bounded queue so concurrent submits don't overwhelm the machine.
        if (heavy.full) return json(res, 503, { error: "arena busy - try again in a moment" });
        const placement = await heavy.run(() => placeBrainSource(source, { seeds: PLACEMENT_SEEDS }));
        if (!placement.ok) return json(res, 400, { error: placement.error });
        const bot = store.upsertUserBot({ handle, name, elo: placement.rating!, source, secret, record: placement.record });
        return json(res, 200, { bot: { ...bot, source: undefined, secret: undefined }, placement, key: issuedKey });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  // Admin: delete a bot. Auth via the KR_ADMIN_TOKEN (header or ?token=).
  if (req.method === "POST" && url === "/api/admin/delete") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, token } = JSON.parse(body || "{}") as { id?: string; token?: string };
      const given = token ?? (req.headers["x-admin-token"] as string | undefined) ?? "";
      if (!ADMIN_TOKEN || given !== ADMIN_TOKEN) return json(res, 403, { error: "forbidden" });
      if (!id) return json(res, 400, { error: "id required" });
      const ok = store.deleteBot(id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
    });
    return;
  }

  // Static web app for everything else (GET only).
  if (req.method === "GET" && !url.startsWith("/api/")) {
    const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const file = normalize(join(webDir, rel));
    if (!file.startsWith(webDir)) return json(res, 403, { error: "forbidden" }); // no path traversal
    readFile(file)
      .then((buf) => {
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(buf);
      })
      .catch(() => json(res, 404, { error: "not found" }));
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`\n  🏟  claude-ball arena API on http://localhost:${port}`);
  console.log(`     GET  /api/leaderboard`);
  console.log(`     POST /api/submit  { handle, name, source }\n`);
});
