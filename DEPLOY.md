# Going live — quickstart

> **STATUS: LIVE** at **https://cladu-regel.fly.dev** — one Fly machine (ams,
> shared-cpu-2x / 1GB) serving both the web UI and the arena API, with the ladder
> persisted on a volume. Deployed with `flyctl deploy --remote-only`.
> Single-machine for now (the JSON store is per-machine); the Postgres swap is
> what unlocks horizontal scaling.

---


The smallest real deploy: **one paid account (Fly.io)** for the arena API +
sandboxed runner, and a **free static host** for the web app. (Postgres/Supabase
and GitHub auth come later — see `DEPLOYMENT.md`. The first deploy uses a JSON
store on a Fly volume, which is plenty for tens of users.)

## 1. Arena API → Fly.io   (needs your account + a card on file)

```bash
# one-time
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth signup              # ← this is the credit-card step

# from the repo root
fly launch --no-deploy       # pick an app name + region; keep the existing fly.toml
fly volumes create kr_data --size 1 --region iad
fly deploy
```

Note the URL Fly prints, e.g. `https://cladu-regel-arena.fly.dev`.

## 2. Web app → Cloudflare Pages or Vercel   (free)

The web app is static (`apps/web`). Deploy that folder:

- **Cloudflare Pages**: new project → connect repo → build output dir `apps/web`,
  no build command.
- **Vercel**: `vercel deploy apps/web` (framework: "Other").

Then point it at the arena once (persists in the browser):

```
https://<your-web-host>/?api=https://cladu-regel-arena.fly.dev
```

(For a permanent default, set `window.KR_API` in `apps/web/index.html`.)

## 3. Give people the instructions

Players need a brain repo. Until we publish a standalone template repo, the
onboarding is:

```bash
git clone <this-repo> && cd cladu-regel && npm install
cd laika                       # or copy templates/brain-starter to your own dir
# open Claude here — CLAUDE.md keeps it to coding only
npm run coach                  # build & test in the workbench
KR_HANDLE=you KR_API=https://cladu-regel-arena.fly.dev npm run submit
```

They appear on the leaderboard and anyone can watch their matches.

## What I still need from you to do this

- [ ] **Fly.io account + credit card** (step 1) — the only paid thing to start.
- [ ] A **static host** account (Cloudflare Pages or Vercel) — free.
- [ ] (Optional) a **domain**.

Hand me the Fly app URL once it's up and I'll wire the web app's default API and
the submit instructions to it.

## Next hardening (I'll keep building, no accounts needed)
- Postgres store (swap `JsonStore` → `PgStore` behind the same interface).
- GitHub login + per-user quotas / rate limits (abuse control before wide release).
- Placement as a background queue so submits return instantly.
- Cached replays in object storage (so popular matchups aren't recomputed).
