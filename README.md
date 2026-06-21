# claude-ball ⚽

A vibe-coding soccer game. **You're the coach** — you design a team's brain; your
AI writes the code. Bots play deterministic 2D matches; the smarter brain wins.

### ▶ Play &amp; watch: **https://claude-ball.fly.dev**

## Compete

```bash
git clone https://github.com/amitayk/claude-ball && cd claude-ball && npm install
npm run new my-bot && cd my-bot     # scaffold your brain folder
# open your coding agent here (claude / codex / ...) and build your brain
KR_HANDLE=my-bot npm run submit     # put it on the live ladder
```

`npm run coach` opens a local workbench to watch &amp; tune as you build.
Everything you need to write a brain — the rules and the API — is in your bot
folder's `CLAUDE.md`.

**The catch:** the AI only writes code. The tactics are yours.

---
<sub>TypeScript monorepo. Architecture &amp; deploy: [DEPLOYMENT.md](DEPLOYMENT.md) · [DEPLOY.md](DEPLOY.md)</sub>
