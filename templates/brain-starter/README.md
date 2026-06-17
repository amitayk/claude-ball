# Your cladu-regel team

You're the **coach**: you design the tactics. Your AI assistant writes the code —
and **only** the code (read [`CLAUDE.md`](CLAUDE.md); that constraint is the
game). The dots on the pitch are your **players**.

Open your AI coding session **in this folder** so `CLAUDE.md` is in effect.

## One command

```bash
npm run coach
```

Opens your workbench at **http://localhost:5177**:

- **The field** — watch your brain (blue) play the opponent (orange), with
  playback controls and a coordinate axis.
- **Match** — pick the opponent and seed, re-run on demand.
- **Control panel** — sliders for the params your assistant exposed. Drag one and
  the match re-runs instantly. **Save + commit** to keep the values.
- **Versions** — every commit to your brain. **Run** an old version against the
  current opponent, or **roll back** to it.

It **hot-reloads**: edit `src/brain.ts` (or have your assistant edit it) and the
match re-runs automatically — no terminal commands to see changes.

## Write your brain

Edit [`src/brain.ts`](src/brain.ts). Describe the behavior you want in plain words
("the closest defender marks their striker", "pass to the most open teammate
ahead of me", "expose the pressing distance as a knob") and have your assistant
implement it. Beat `chaser`, then `formation`, then your friends.

## Also available

```bash
npm run match -- formation --seed 9   # headless match, prints the score
npm run match -- formation --out viewer/replay.json && npm run viewer
```

See the repo root `README.md` for the full `WorldView` / `Intent` / params API.
