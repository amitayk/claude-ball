# Your claude-ball team

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

## How to coach: design your team in phases

Your brain makes one decision per player every tick. The trick is to think in
**game phases** — work out which phase you're in, then give each player a job.
You describe the behaviour in plain words; your assistant writes the code.

- **Kickoff** — you must play the ball back. Decide who takes it and where the
  safe outlet is. (`kickoffBackPass(view)` gives you a legal one for free.)
- **In possession** (your team has the ball) — two jobs at once: the player on
  the ball (dribble toward goal? pass to someone in space? shoot?) and everyone
  else (spread out, offer passing lanes, make runs, keep a shape).
- **Out of possession** (they have the ball) — press the carrier or drop and
  contain? Decide who marks their most dangerous player and who guards your goal.
- **Loose ball** — who chases and who holds position. Don't let all four chase.
- **Shooting** — define when a shot is *on*: close enough, decent angle, lane
  clear. Otherwise keep the ball.

A few habits that pay off:

- **Give every player a role** — keeper, defenders, midfield, striker. Spacing
  off the ball matters as much as what the ball-carrier does.
- **Turn your guesses into knobs.** Expose the numbers you're unsure about
  (press distance, shooting range, how high your striker pushes) as `params` and
  dial them live in the workbench instead of editing code each time.
- **Watch, then change one thing.** See where you concede and where you lose the
  ball, adjust a single idea, commit. The Versions panel lets you roll back when
  an idea makes it worse. Beat `formation`, then `blitz`.

## Also available

```bash
npm run match -- formation --seed 9   # headless match, prints the score
npm run match -- formation --out viewer/replay.json && npm run viewer
```

See the repo root `README.md` for the full `WorldView` / `Intent` / params API.
