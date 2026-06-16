# Your cladu-regel team

You design the tactics. Your AI assistant writes the code — and **only** the
code (read [`CLAUDE.md`](CLAUDE.md); that constraint is the game).

## Write your brain

Edit [`src/brain.ts`](src/brain.ts). Describe the behavior you want to your AI
assistant in plain words ("the closest defender marks their striker", "pass to
the most open teammate ahead of me") and have it implement it against the
`Brain` API.

## Play

```bash
npm run match                       # your brain vs the built-in chaser
npm run match -- src/brain.ts formation --seed 12 --out replay.json
npm run viewer                      # watch the replay in your browser
```

Same seed ⇒ same match, every time. Beat `chaser`, then `formation`, then your
friends.

See the root `README.md` for the full `WorldView` / `Intent` API reference.
