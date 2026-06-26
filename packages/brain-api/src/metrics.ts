/**
 * Live-metrics channel for the coach workbench (optional, dev-time only).
 *
 * A brain may call `reportMetrics({...})` inside `decide()` to surface its own
 * internal state — a state-machine phase, the player it picked as taker, a
 * pressing trigger, any counter you want to watch. Whatever you report renders
 * live in the coach's **"Your metrics"** panel, frame-by-frame, in step with
 * replay playback (and scrubbing).
 *
 * It has ZERO effect on the match: the engine records the latest report each
 * tick for display and nothing else. Outside the coach (CLI, arena, ladder) the
 * reports are simply ignored. Report as often as you like — only the most recent
 * call per tick is kept.
 *
 *   import { reportMetrics } from "@claude-ball/brain-api";
 *   // inside decide(view, params):
 *   reportMetrics({ phase: state, taker: takerId, pressing: underPressure });
 */
export type MetricValue = string | number | boolean;
export type Metrics = Record<string, MetricValue>;

let latest: Metrics | null = null;

/** Report this tick's metrics for the coach's "Your metrics" panel. */
export function reportMetrics(metrics: Metrics): void {
  latest = metrics;
}

/**
 * Engine-internal: take and clear the metrics reported since the last call.
 * Brains should not call this — use {@link reportMetrics}.
 */
export function collectMetrics(): Metrics | null {
  const m = latest;
  latest = null;
  return m;
}
