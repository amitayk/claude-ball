# cladu-regel — Production Deployment Plan

Goal: anyone can clone a tiny repo, write a team brain with Claude (under the
"human thinks, AI codes" constraint), submit it, and have it climb a ladder
against the library bots **and other people's bots** — with a fun, readable PvP
web UI. Must run for 10s of users and survive going viral (1000s).

## The product loop

1. **Onboard** — user runs one command to get a brain repo (clone or `npx`),
   opens Claude in it (CLAUDE.md enforces the rules), builds a brain.
2. **Test locally** — the coach workbench they already have (field, control
   panel, opponents with skills, versions).
3. **Submit** — `npm run submit` bundles their brain and uploads it to the arena.
4. **Compete** — the arena plays their brain vs library bots + other users'
   bots on a ladder; a rating (Glicko-2) places them on a leaderboard.
5. **Watch** — the web app shows the leaderboard, their match history, and
   replays in the gorgeous viewer. Shareable links.

## The hard problem (and the decision)

Brains are **untrusted code**. Today they run in-process locally — fine for solo,
fatal for PvP. We must run other people's code without letting it touch our
servers, other users, or each other.

**Decision: brains run server-side inside V8 isolates** (one isolate per brain,
no `fetch`/`fs`/`process`/`require`, CPU + memory + wall-clock limited, hard
‑terminated on overrun). The engine drives the isolates: each tick it passes a
plain `WorldView` in and gets `Intent`s out. This finally closes the holes we
flagged (infinite loops, process escape, rule mutation) because:

- the isolate has **no ambient capabilities** — there's nothing to escape to;
- an isolate can be **force-killed**, so an infinite loop is a forfeit, not a hang;
- `RULES` and the `WorldView` live outside the isolate entirely.

Matches stay **deterministic** (seeded), so any result can be re-verified by
re-running, and replays are reproducible.

Brains are submitted as **source**; the server bundles each (esbuild, inlining
`@kr/brain-api`) into one self-contained module, then runs it in the isolate.

## Architecture

```
                ┌─────────────┐   submit (auth)   ┌──────────────────┐
   coach CLI ──▶│  Web API     │──────────────────▶│  brains (DB+blob) │
 (npm run submit)│ (REST)      │                   └──────────────────┘
                └─────┬───────┘                              │
                      │ enqueue ladder matches               │ source
                      ▼                                      ▼
                ┌─────────────┐   pull jobs    ┌──────────────────────────┐
                │  match queue │◀──────────────│  arena workers (N)         │
                └─────────────┘                │  engine + 2 V8 isolates    │
                      ▲                         │  → MatchResult + replay    │
   leaderboard/replays│  store results          └──────────┬───────────────┘
                ┌─────┴───────┐                            │
   web app ────▶│  DB + object │◀───────────────────────────┘
 (Vercel/CF)    │  storage     │     ratings (Glicko-2), replays (gzip)
                └─────────────┘
```

## Stack (recommended — cheap now, scales)

| Concern | Choice | Why |
|---|---|---|
| Web UI + viewer | **Vite SPA on Cloudflare Pages / Vercel** | static, global CDN, free, infinite scale |
| Auth | **GitHub OAuth** (+ magic link later) | devs already have GitHub; trivial identity |
| DB | **Postgres (Supabase / Neon)** | relational ladder/ratings; generous free tier |
| Replay storage | **Object storage (Supabase Storage / R2)** | replays are big; cheap blobs, CDN-served |
| Queue | **Postgres-backed job table** (v1) → real queue at scale | no extra infra to start |
| Arena workers | **Node + `isolated-vm`** on **Fly.io / Railway** | proper untrusted-JS isolation; autoscale |

**Scale-up path if it goes viral:** move arena workers to **Cloudflare Workers**
(V8 isolates are their native model — untrusted code at massive scale, pay-per-use)
and storage to **D1 + R2**. The arena is written behind a small interface so the
runtime can swap without touching game logic.

Why not all-Cloudflare from day 1? Slightly more rewrite and harder local dev.
We start on Node (reuses our engine directly) and keep the door open.

## Data model (first cut)

- `users(id, github_id, handle, created_at)`
- `brains(id, user_id, name, source, bundle, version, created_at, active)`
- `bots(id, name, kind['library'|'user'], brain_id?, rating, rd, sigma)` — unified
  ladder entries so library bots and user bots compete together.
- `matches(id, home_bot, away_bot, seed, score_home, score_away, replay_key, fault, created_at)`
- `ratings_history(bot_id, rating, at)`

## Rating

**Glicko-2** per bot (library bots seeded from the round-robin skills as priors).
On submit, a brain plays a placement set (all library bots + a sample of nearby
user bots, both sides, several seeds); thereafter periodic ladder matches keep
ratings fresh. Deterministic matches → fully auditable.

## Rollout phases

- **P0 — Arena keystone (local, no cloud): IN PROGRESS.** `@kr/arena` runs two
  brains *from source* in isolates, deterministically, with limits. Proves the
  security model. ← building now.
- **P1 — Single-box MVP.** One small server: API + Postgres + a few arena
  workers + object storage; submit CLI; minimal web leaderboard + replays.
  Invite ~10 users. (Needs your accounts — see below.)
- **P2 — Managed + scale.** Split web/API/workers, autoscale workers off the
  queue, CDN replays, rate limits/quotas, abuse controls. Cloudflare path if
  load demands it.
- **P3 — Polish PvP UX.** Leaderboard, profiles, head-to-head, shareable
  replays, "challenge" links, seasons.

## Cost

- **P0:** $0 (local).
- **P1:** ~$0–5/mo on free tiers (Supabase free, Vercel free, one tiny Fly
  machine). Fly requires a card on file even for the free allowance.
- **P2 viral:** scales with use; isolates are cheap. Budget alarms + per-user
  match quotas keep it bounded; a Cloudflare migration drops per-match cost hard.

## What I need from you (and when)

I can build P0 and most of P1's code with **no accounts**. To actually deploy I'll
need you to (I'll prompt you at the exact moment):

1. **GitHub OAuth app** (free) — for login. (P1)
2. **Supabase project** (free) — DB + storage. (P1)
3. **Fly.io account + credit card** (free allowance, card required) — arena
   workers + API. (P1)
4. **Vercel/Cloudflare Pages account** (free) — web app. (P1)
5. Optional: a **domain**. (P1/P2)

Until then I keep everything runnable locally and behind config, so the cloud
wiring is a fill-in-the-secrets step, not a rewrite.

## Open decisions (my defaults unless you say otherwise)

- Identity: **GitHub OAuth** (devs have it). 
- Submission: **CLI from the brain repo** (keeps the Claude-in-repo workflow).
- One **active brain per user** on the ladder (can iterate; resubmits replace).
- Library bots are **permanent ladder fixtures** (the skill floor/ceiling).
