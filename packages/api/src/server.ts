import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { placeBrainSource } from "@claude-ball/ladder";
import { runSandboxedMatch } from "@claude-ball/arena";
import { JsonStore } from "./store.js";
import type { BotRecord, BracketMatch, TournamentResult } from "./store.js";
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

// Parse a `?homeParams=`/`?awayParams=` query value (URL-encoded JSON) into a
// flat map of numeric knob overrides. Anything malformed or non-numeric is
// dropped; the engine clamps surviving values to each param's range.
function parseParams(raw: string | null): Record<string, number> | undefined {
  if (!raw || raw.length > 2000) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

// ── playoff bracket (single elimination) ─────────────────────────────────────
const ref = (b: BotRecord) => ({ id: b.id, name: b.name, handle: b.handle });

/** Play one knockout tie: first decisive game across a few seeds wins; an
 *  all-draw or a broken brain is resolved by seed (Elo). */
async function playMatch(a: BotRecord, b: BotRecord) {
  for (const seed of [1, 2, 3]) {
    const r = await heavy.run(() => runSandboxedMatch(a.source, b.source, { seed }));
    if (!r.ok || !r.result) {
      if (r.fault?.side === "home") return { score: { a: 0, b: 1 }, winner: b, seed, note: "home brain failed" };
      if (r.fault?.side === "away") return { score: { a: 1, b: 0 }, winner: a, seed, note: "away brain failed" };
      continue; // timeout/crash with no side — try the next seed
    }
    const s = r.result.score;
    if (s.home !== s.away) return { score: { a: s.home, b: s.away }, winner: s.home > s.away ? a : b, seed };
  }
  return { score: { a: 0, b: 0 }, winner: a.elo >= b.elo ? a : b, seed: 1, note: "all draws - higher seed advances" };
}

/** Seed by Elo, pair high-vs-low, pad with byes, play down to a champion. */
async function runBracket(entrants: BotRecord[]): Promise<TournamentResult> {
  const seeds = [...entrants].sort((x, y) => y.elo - x.elo);
  let size = 1;
  while (size < seeds.length) size *= 2;
  const slots: (BotRecord | null)[] = [...seeds];
  while (slots.length < size) slots.push(null);
  let current: [BotRecord | null, BotRecord | null][] = [];
  for (let i = 0; i < size / 2; i++) current.push([slots[i]!, slots[size - 1 - i]!]);

  const rounds: BracketMatch[][] = [];
  let roundNo = 0;
  let advancers: BotRecord[] = [];
  while (true) {
    const matches: BracketMatch[] = [];
    advancers = [];
    for (const [a, b] of current) {
      if (a && !b) { matches.push({ round: roundNo, a: ref(a), seed: 1, bye: true, winner: ref(a) }); advancers.push(a); continue; }
      if (!a && b) { matches.push({ round: roundNo, b: ref(b), seed: 1, bye: true, winner: ref(b) }); advancers.push(b); continue; }
      if (!a || !b) continue;
      const m = await playMatch(a, b);
      matches.push({ round: roundNo, a: ref(a), b: ref(b), seed: m.seed, score: m.score, winner: ref(m.winner), note: m.note });
      advancers.push(m.winner);
    }
    rounds.push(matches);
    if (advancers.length <= 1) break;
    current = [];
    for (let i = 0; i < advancers.length; i += 2) current.push([advancers[i]!, advancers[i + 1] ?? null]);
    roundNo++;
  }
  return { ranAt: Date.now(), champion: ref(advancers[0]!), rounds };
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
    // Optional live-tuned knob overrides (JSON object of number values). The
    // engine clamps each to its param spec, so out-of-range values are safe.
    const homeParams = parseParams(q.get("homeParams"));
    const awayParams = parseParams(q.get("awayParams"));
    if (!home || !away) return json(res, 404, { error: "unknown bot(s)" });
    if (heavy.full) return json(res, 503, { error: "arena busy - try again in a moment" });
    heavy.run(() => runSandboxedMatch(home.source, away.source, { seed, homeParams, awayParams })).then((r) => {
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
        const { handle, name, source, key, tournament } = JSON.parse(body || "{}") as {
          handle?: string;
          name?: string;
          source?: string;
          key?: string;
          tournament?: string;
        };
        if (!handle || !name || !source) {
          return json(res, 400, { error: "handle, name, and source are required" });
        }
        if (!/^[a-z0-9_-]{2,24}$/i.test(handle)) {
          return json(res, 400, { error: "handle must be 2-24 chars: letters, digits, - or _" });
        }
        if (tournament && !store.getTournament(tournament)) {
          return json(res, 400, { error: `unknown tournament code "${tournament}"` });
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
        const bot = store.upsertUserBot({ handle, name, elo: placement.rating!, source, secret, record: placement.record, tournament });
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

  // ── tournaments (org-private brackets) ─────────────────────────────────────
  if (req.method === "GET" && url === "/api/tournaments") {
    return json(res, 200, { tournaments: store.listTournaments() });
  }
  if (req.method === "GET" && url === "/api/tournament") {
    const slug = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("slug") ?? "";
    const t = store.getTournament(slug);
    if (!t) return json(res, 404, { error: "unknown tournament" });
    const bots = store.tournamentBots(slug).map((b) => ({ id: b.id, name: b.name, handle: b.handle, elo: b.elo, record: b.record }));
    return json(res, 200, { tournament: t, bots });
  }
  if (req.method === "POST" && url === "/api/tournaments") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!allow(`tcreate:${clientIp(req)}`, 10, 3_600_000)) return json(res, 429, { error: "too many tournaments - try again later" });
      try {
        const { org, name } = JSON.parse(body || "{}") as { org?: string; name?: string };
        if (!org || !name) return json(res, 400, { error: "org and name are required" });
        return json(res, 200, { tournament: store.createTournament(String(org), String(name)) });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }
  if (req.method === "POST" && url === "/api/tournament/run") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { slug } = JSON.parse(body || "{}") as { slug?: string };
        const t = store.getTournament(String(slug ?? ""));
        if (!t) return json(res, 404, { error: "unknown tournament" });
        if (!allow(`trun:${clientIp(req)}`, 20, 600_000)) return json(res, 429, { error: "slow down - too many runs" });
        let entrants = store.tournamentBots(t.slug);
        if (entrants.length < 2) return json(res, 400, { error: "need at least 2 bots before a playoff can run" });
        if (entrants.length > 32) entrants = [...entrants].sort((a, b) => b.elo - a.elo).slice(0, 32);
        if (heavy.full) return json(res, 503, { error: "arena busy - try again in a moment" });
        const result = await runBracket(entrants);
        store.saveTournamentResult(t.slug, result);
        return json(res, 200, { tournament: store.getTournament(t.slug) });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
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
