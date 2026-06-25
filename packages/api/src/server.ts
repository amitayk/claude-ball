import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { placeBrainSource } from "@claude-ball/ladder";
import { runSandboxedMatch, introspectBrain } from "@claude-ball/arena";
import { JsonStore } from "./store.js";
import type { BotRecord, Tournament, TournamentResult } from "./store.js";
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

// ── round-robin league ───────────────────────────────────────────────────────
const ref = (b: BotRecord) => ({ id: b.id, name: b.name, handle: b.handle });

/** Round-robin fixtures via the circle method: rounds (matchdays) where each
 *  team plays once. An odd count gets a rotating bye (dropped from the schedule). */
function schedule(entrants: BotRecord[]): [BotRecord, BotRecord][][] {
  const arr: (BotRecord | null)[] = [...entrants];
  if (arr.length % 2) arr.push(null);
  const n = arr.length;
  let rot = arr.slice(1);
  const rounds: [BotRecord, BotRecord][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const line = [arr[0], ...rot];
    const day: [BotRecord, BotRecord][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = line[i], b = line[n - 1 - i];
      if (a && b) day.push([a, b]);
    }
    rounds.push(day);
    rot = [rot[rot.length - 1]!, ...rot.slice(0, -1)];
  }
  return rounds;
}

/** One league game (deterministic seed 1). A broken brain forfeits; a level
 *  score is a genuine draw (worth a point each). */
async function playGame(a: BotRecord, b: BotRecord): Promise<{ score: { a: number; b: number }; winner: BotRecord | null }> {
  const r = await heavy.run(() => runSandboxedMatch(a.source, b.source, { seed: 1 }));
  if (!r.ok || !r.result) {
    if (r.fault?.side === "home") return { score: { a: 0, b: 1 }, winner: b };
    if (r.fault?.side === "away") return { score: { a: 1, b: 0 }, winner: a };
    return { score: { a: 0, b: 0 }, winner: null };
  }
  const s = r.result.score;
  return { score: { a: s.home, b: s.away }, winner: s.home > s.away ? a : s.away > s.home ? b : null };
}

/** Everyone plays everyone once; tally a table (3-1-0); rank by pts, then GD, GF. */
async function runLeague(entrants: BotRecord[]): Promise<TournamentResult> {
  const table = new Map(
    entrants.map((e) => [e.id, { ...ref(e), played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]),
  );
  const games: TournamentResult["games"] = [];
  const rounds = schedule(entrants);
  for (let roundNo = 0; roundNo < rounds.length; roundNo++) {
    for (const [a, b] of rounds[roundNo]!) {
      const g = await playGame(a, b);
      games.push({ round: roundNo, a: ref(a), b: ref(b), seed: 1, score: g.score, winner: g.winner ? ref(g.winner) : null });
      const sa = table.get(a.id)!, sb = table.get(b.id)!;
      sa.played++; sb.played++;
      sa.gf += g.score.a; sa.ga += g.score.b; sb.gf += g.score.b; sb.ga += g.score.a;
      if (!g.winner) { sa.d++; sb.d++; sa.pts++; sb.pts++; }
      else if (g.winner.id === a.id) { sa.w++; sb.l++; sa.pts += 3; }
      else { sb.w++; sa.l++; sb.pts += 3; }
    }
  }
  for (const s of table.values()) s.gd = s.gf - s.ga;
  const standings = [...table.values()].sort(
    (x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name),
  );
  const top = standings[0]!;
  return { ranAt: Date.now(), format: "league", champion: { id: top.id, name: top.name, handle: top.handle }, games, standings };
}

// ── Slack viral loop (Incoming Webhooks) ─────────────────────────────────────
const originOf = (req: IncomingMessage) =>
  `${(req.headers["x-forwarded-proto"] as string) || "http"}://${req.headers.host}`;
async function postSlack(url: string, text: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return r.ok;
  } catch {
    return false;
  }
}
const inviteText = (t: Tournament, origin: string) =>
  `:soccer: *${t.org}* is running a claude-ball league: *${t.name}*\n` +
  `Build a bot and join: \`npm run submit -- your-bot-name --tournament ${t.slug}\`\n` +
  `Standings & live matches: ${origin}/tournament.html?slug=${t.slug}`;
const resultText = (t: Tournament, origin: string) => {
  const r = t.result!;
  const table = r.standings.map((s, i) => `${i + 1}. *${s.name}* — ${s.pts} pts (${s.w}-${s.d}-${s.l})`).join("\n");
  return `:trophy: *${t.name}* — full time!\n*${r.champion.name}* wins the league :tada:\n\n${table}\n\nWatch every game: ${origin}/tournament.html?slug=${t.slug}`;
};

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
        // Read the bot's declared knobs so they can be tuned live on the site.
        // Non-fatal: a bot that declares none (or fails introspection) just has no knobs.
        const introspect = await heavy.run(() => introspectBrain(source));
        const params = introspect.ok ? introspect.info?.params ?? undefined : undefined;
        const bot = store.upsertUserBot({ handle, name, elo: placement.rating!, source, secret, record: placement.record, tournament, params });
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
    const { slackWebhook, ...pub } = t; // never expose the webhook
    const bots = store.tournamentBots(slug).map((b) => ({ id: b.id, name: b.name, handle: b.handle, elo: b.elo, record: b.record }));
    return json(res, 200, { tournament: { ...pub, slackConnected: !!slackWebhook }, bots });
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
        if (entrants.length < 2) return json(res, 400, { error: "need at least 2 bots before the league can run" });
        // Round-robin is O(n²) sandboxed games — cap the field so a run stays bounded.
        if (entrants.length > 12) entrants = [...entrants].sort((a, b) => b.elo - a.elo).slice(0, 12);
        if (heavy.full) return json(res, 503, { error: "arena busy - try again in a moment" });
        const result = await runLeague(entrants);
        store.saveTournamentResult(t.slug, result);
        const done = store.getTournament(t.slug)!;
        if (done.slackWebhook) void postSlack(done.slackWebhook, resultText(done, originOf(req))); // viral loop: results land in the team channel
        const { slackWebhook, ...pub } = done;
        return json(res, 200, { tournament: { ...pub, slackConnected: !!slackWebhook } });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  // Connect a Slack channel (Incoming Webhook). Posts a confirmation on success.
  if (req.method === "POST" && url === "/api/tournament/slack") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { slug, webhook } = JSON.parse(body || "{}") as { slug?: string; webhook?: string };
        const t = store.getTournament(String(slug ?? ""));
        if (!t) return json(res, 404, { error: "unknown tournament" });
        if (!allow(`slack:${clientIp(req)}`, 30, 600_000)) return json(res, 429, { error: "slow down" });
        const hook = String(webhook ?? "").trim();
        if (!/^https:\/\/hooks\.slack\.com\/services\//.test(hook)) {
          return json(res, 400, { error: "that's not a Slack Incoming Webhook URL (https://hooks.slack.com/services/…)" });
        }
        if (!(await postSlack(hook, `:white_check_mark: claude-ball connected — *${t.name}* invites and results will post here.`))) {
          return json(res, 400, { error: "couldn't post to that webhook - double-check the URL" });
        }
        store.setSlackWebhook(t.slug, hook);
        return json(res, 200, { ok: true, slackConnected: true });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  // Post the "join our league" invite to the connected Slack channel.
  if (req.method === "POST" && url === "/api/tournament/invite") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { slug } = JSON.parse(body || "{}") as { slug?: string };
        const t = store.getTournament(String(slug ?? ""));
        if (!t) return json(res, 404, { error: "unknown tournament" });
        if (!t.slackWebhook) return json(res, 400, { error: "connect a Slack channel first" });
        if (!allow(`slack:${clientIp(req)}`, 30, 600_000)) return json(res, 429, { error: "slow down" });
        const ok = await postSlack(t.slackWebhook, inviteText(t, originOf(req)));
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: "couldn't post to Slack" });
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
