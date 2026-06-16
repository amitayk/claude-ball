# Your cladu-regel team

You design the tactics. Your AI assistant writes the code — and **only** the
code (read [`CLAUDE.md`](CLAUDE.md); that constraint is the game).

This folder is a self-contained project. Open your AI coding session **here**
(`cd` into this folder) so the `CLAUDE.md` rules are in effect.

## Write your brain

Edit [`src/brain.ts`](src/brain.ts). Describe the behavior you want to your AI
assistant in plain words ("the closest defender marks their striker", "pass to
the most open teammate ahead of me") and have it implement it.

## Play

```bash
npm run match                      # your brain (home) vs the built-in chaser
npm run match -- formation         # vs the built-in formation brain
npm run match -- formation --seed 9 --out viewer/replay.json
npm run viewer                     # watch viewer/replay.json at localhost:5177

npm run play                       # shortcut: run a match + open the viewer
```

Flags: `--seed <n>`, `--ticks <n>`, `--out <path>`, `--me <path>` (default
`./src/brain.ts`). Same seed ⇒ same match, every time.

Beat `chaser`, then `formation`, then your friends.

See the repo root `README.md` for the full `WorldView` / `Intent` API reference.
