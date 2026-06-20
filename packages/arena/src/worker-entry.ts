import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import { runMatch } from "@kr/engine";

/**
 * Runs inside a worker thread (bundled to plain JS by esbuild, so no tsx needed).
 * Each brain is compiled in a BARE vm context — it gets the standard JS
 * intrinsics (Math, JSON, …) but no `fetch`, `process`, `require`, `fs`, etc.
 * The engine runs in the worker's own context and drives the brains.
 *
 * The hard wall-clock kill is enforced by the PARENT terminating this worker;
 * that's what makes an infinite loop a forfeit instead of a hang.
 *
 * NOTE: a bare vm context removes ambient capabilities but is not a hardened
 * boundary against a determined escape (shared heap). The worker is a throwaway
 * with no secrets; production swaps this for V8 isolates (isolated-vm) or
 * Cloudflare Workers — see DEPLOYMENT.md.
 */
interface WD {
  homeBundle: string;
  awayBundle: string;
  opts: Record<string, unknown>;
}

const { homeBundle, awayBundle, opts } = workerData as WD;

function loadBrain(bundle: string) {
  const ctx = vm.createContext(Object.create(null));
  vm.runInContext(bundle, ctx, { timeout: 2000 });
  const mod = (ctx as { __brain?: Record<string, unknown> }).__brain ?? {};
  const brain =
    (mod.default as { decide?: unknown }) ??
    (mod.brain as { decide?: unknown }) ??
    (Object.values(mod).find((v) => v && typeof (v as { decide?: unknown }).decide === "function") as
      | { decide?: unknown }
      | undefined) ??
    mod;
  if (!brain || typeof (brain as { decide?: unknown }).decide !== "function") {
    throw new Error("module does not export a Brain (with a decide() method)");
  }
  return brain as Parameters<typeof runMatch>[0];
}

try {
  const home = loadBrain(homeBundle);
  const away = loadBrain(awayBundle);
  const result = runMatch(home, away, opts as Parameters<typeof runMatch>[2]);
  parentPort!.postMessage({ ok: true, result });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
