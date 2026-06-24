// Entry point for the browser simulation bundle.
//
// The match engine and the house ("library") bots are pure JS with no Node
// dependencies, so we can bundle them straight into the page and re-simulate a
// matchup live in the browser whenever a visitor turns a knob. Built with:
//   npm run build:web-sim   ->   apps/web/sim.bundle.js
//
// Only the house bots are shipped here (their source is already public in this
// open-source repo). Challenger (user-submitted) bots stay server-side; a
// matchup that involves one falls back to /api/watch.
import { runMatch } from "@claude-ball/engine";
import { catalog } from "@claude-ball/brains";

// name -> { brain, params spec } for every house bot.
const houseBots = Object.fromEntries(
  catalog.map((e) => [e.name, { brain: e.brain, params: e.brain.params ?? null }]),
);

export { runMatch, houseBots };
