// Off-main-thread match simulation for live knob tuning.
//
// Runs the bundled engine + house bots so dragging a slider re-simulates the
// whole 90s match in a few tens of milliseconds without janking the page.
// Only house-vs-house matchups are simulated here; anything with a challenger
// bot goes through the server (/api/watch) instead.
import { runMatch, houseBots } from "./sim.bundle.js";

self.onmessage = (e) => {
  const { id, home, away, seed, homeParams, awayParams } = e.data;
  const h = houseBots[home], a = houseBots[away];
  if (!h || !a) {
    self.postMessage({ id, ok: false, error: "not a house matchup" });
    return;
  }
  try {
    const replay = runMatch(h.brain, a.brain, { seed, homeParams, awayParams });
    self.postMessage({ id, ok: true, replay });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ? String(err.message) : String(err) });
  }
};
