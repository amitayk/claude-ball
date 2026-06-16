# cladu-regel ⚽

A vibe-coding soccer game. You design a team's **brain** — its tactics — and your
AI assistant writes the code. The twist: **the human owns all the thinking; the
AI is only allowed to code** (see [`templates/brain-starter/CLAUDE.md`](templates/brain-starter/CLAUDE.md)).

Two team brains play a deterministic 2D match. Whoever designed the smarter
strategy wins.

> **Status: Phase 1** — deterministic engine, local match runner, and replay
> viewer are working. Server/ladder (Phase 4) is not built yet.

## Quick start

```bash
npm install
npm run demo          # runs formation vs chaser and opens the viewer
```

Or step by step:

```bash
npm run match -- formation chaser --seed 7 --out packages/viewer/replay.json
npm run viewer        # http://localhost:5177
```

### Running brains

```bash
# built-in brains (by name): chaser, formation
npm run match -- formation chaser

# your own brain (by path) vs a built-in
npm run match -- ./packages/brains/src/chaser.ts formation --seed 3

# flags
--seed <n>     deterministic seed (default 1)
--ticks <n>    override match length in ticks
--out <path>   write a replay JSON for the viewer
```

Same `(seed, home, away)` ⇒ exact same match, every time.

## Architecture

A TypeScript monorepo (npm workspaces). The engine is headless and deterministic;
rendering and I/O live outside it.

| Package | Role |
|---|---|
| [`@kr/brain-api`](packages/brain-api) | **The public contract.** `Brain`, `WorldView`, `Intent`, vector helpers. Zero dependencies. |
| [`@kr/engine`](packages/engine) | Deterministic simulation: physics, possession, goals, match loop, replay recording. |
| [`@kr/brains`](packages/brains) | Built-in sample brains (`chaser`, `formation`). |
| [`@kr/runner`](packages/runner) | CLI: load two brains, run a match, write a replay. |
| [`@kr/viewer`](packages/viewer) | Zero-build browser replay player (canvas). |
| [`templates/brain-starter`](templates/brain-starter) | What a player clones to write their own brain. |

The boundary that matters: **a brain only ever receives a read-only `WorldView`
and returns `Intent`s.** It cannot touch engine state. That keeps matches
deterministic and cheat-resistant regardless of how a brain is written.

## The Brain API

```ts
interface Brain {
  name?: string;
  decide(view: WorldView): TeamIntent;   // called once per tick
}
```

Each tick you get a `WorldView` and return one `Intent` per player you control:

```ts
type Intent =
  | { kind: "idle" }
  | { kind: "move";    to: Vec2 }    // steer toward a point at full speed
  | { kind: "moveDir"; dir: Vec2 }   // steer in a direction
  | { kind: "pass";    to: Vec2 }    // kick at pass speed (needs the ball)
  | { kind: "shoot";   to: Vec2 };   // kick at shot speed (needs the ball)
```

Key `WorldView` fields: `ball`, `teammates`, `opponents` (all read-only with
`pos`/`vel`), `side`, `attackDir` (+1/-1), `targetGoalX`, `ownGoalX`, `field`,
`score`, `tick`, `dt`.

Rules: 4 players per side, ~90s matches at 30 ticks/sec. A player controls the
ball within `controlDistance`; kicks have a short cooldown. See
[`packages/engine/src/constants.ts`](packages/engine/src/constants.ts).

### Determinism rules for brains

- Never use `Math.random()` — matches must be reproducible.
- Don't mutate the `WorldView` (it's frozen by convention; treat it as read-only).
- `decide()` should be a pure function of the view.

## Roadmap

- **Phase 1 ✅** Engine, match runner, replay viewer.
- **Phase 2** Balance tuning (keeper/defense so scores are realistic), tests.
- **Phase 3** The cloneable player template as a standalone repo + `CLAUDE.md`.
- **Phase 4** Server + ladder for online PvP and leaderboards.
