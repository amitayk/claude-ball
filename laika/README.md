# laika

Your `laika` team brain. You're the **coach** — you design the tactics; your AI
assistant writes the code, and only the code (read [`CLAUDE.md`](CLAUDE.md)).

Open your AI session **in this folder** so `CLAUDE.md` is in effect.

## One command

```bash
npm run coach        # workbench at http://localhost:5177
```

Watch the match, pick an opponent (with skill ratings), tune params with live
sliders, browse versions. Editing [`src/brain.ts`](src/brain.ts) hot-reloads the
match automatically.

```bash
npm run match -- formation --seed 9   # headless match, prints the score
```

See the repo root `README.md` for the full `WorldView` / `Intent` / params API.
