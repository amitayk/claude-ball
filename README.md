# cladu-regel ⚽

A vibe-coding soccer game. As a **coach**, you design a team's **brain** — its
tactics — and your AI assistant writes the code. The twist: **the coach owns all
the thinking; the AI is only allowed to code** (see
[`templates/brain-starter/CLAUDE.md`](templates/brain-starter/CLAUDE.md)).

Two team brains play a deterministic 2D match. Whoever designed the smarter
strategy wins. The dots on the pitch are **players**.

> **Status: Phase 2** — deterministic engine, headless runner, and a live
> **coach workbench** (field + control panel + version history, hot-reloads on
> edit). Server/ladder (Phase 4) is not built yet.

## Quick start

```bash
npm install
npm run coach         # opens the coach workbench for the starter brain
```

The workbench (http://localhost:5177) is the main way to play: watch the match,
swap opponents, tune params with live sliders, and browse/roll back versions —
all updating instantly as you (or your assistant) edit `src/brain.ts`. Open your
AI session in `templates/brain-starter/` so its `CLAUDE.md` is in effect.

### Headless matches

```bash
# built-in brains (by name): chaser, formation
npm run match -- formation chaser
# your own brain (by path) vs a built-in, write a replay
npm run match -- ./packages/brains/src/chaser.ts formation --seed 3 --out packages/viewer/replay.json
npm run viewer        # http://localhost:5177

# flags: --seed <n>  --ticks <n>  --out <path>
```

Same `(seed, home, away, params)` ⇒ exact same match, every time.

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
| [`@kr/coach`](packages/coach) | Live coach workbench: dev server (SSE + hot reload), field, control panel, git versions UI. |
| [`templates/brain-starter`](templates/brain-starter) | What a coach clones to write their own brain. |

The boundary that matters: **a brain only ever receives a read-only `WorldView`
and returns `Intent`s.** It cannot touch engine state. That keeps matches
deterministic and cheat-resistant regardless of how a brain is written.

## The Brain API

```ts
interface Brain {
  name?: string;
  params?: ParamsSpec;                            // tunable knobs (sliders in the panel)
  decide(view: WorldView, params: ParamValues): TeamIntent;  // called once per tick
}
```

Declaring `params` exposes named values (`{ default, min, max, step, label }`) as
sliders in the coach control panel; the resolved values arrive as the second
argument to `decide`. Brains that declare none can ignore it. The *knobs* are
agreed with your assistant; the *values* are the coach's to turn.

Each tick you get a `WorldView` and return one `Intent` per player you control:

```ts
type Intent =
  | { kind: "idle" }
  | { kind: "move";    to: Vec2 }    // steer toward a point at full speed
  | { kind: "moveDir"; dir: Vec2 }   // steer in a direction
  | { kind: "pass";    to: Vec2; range?: number }  // weighted to stop at `to`; `range` overrides distance
  | { kind: "shoot";   to: Vec2 };                 // struck at full pace (needs the ball)
```

Key `WorldView` fields: `ball`, `teammates`, `opponents` (all read-only with
`pos`/`vel`), `side`, `attackDir` (+1/-1), `targetGoalX`, `ownGoalX`, `field`,
`score`, `tick`, `dt`.

Rules: 4 players per side, ~90s matches at 30 ticks/sec. A player controls the
ball within `controlDistance`; kicks have a short cooldown. See
[`packages/engine/src/constants.ts`](packages/engine/src/constants.ts).

### Rules for brains

- **Be side-agnostic.** The same brain must work on either slot, so never
  hardcode left/right, `"home"`/`"away"`, or a literal x. Orient only by
  `attackDir`, `targetGoalX`, `ownGoalX`, `teammates`/`opponents`. (PvP will
  place brains on both sides; "left/right" describe the pitch coordinates, never
  a team.)
- Never use `Math.random()` — matches must be reproducible.
- Don't mutate the `WorldView` (it's frozen by convention; treat it as read-only).
- `decide()` should be a pure function of `(view, params)`.

## Roadmap

- **Phase 1 ✅** Engine, match runner, replay viewer.
- **Phase 2** Balance tuning (keeper/defense so scores are realistic), tests.
- **Phase 3** The cloneable player template as a standalone repo + `CLAUDE.md`.
- **Phase 4** Server + ladder for online PvP and leaderboards.
