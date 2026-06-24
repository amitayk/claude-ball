import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import type { MatchResult, RunOptions } from "@claude-ball/engine";
import type { ParamsSpec } from "@claude-ball/brain-api";

export type { ParamsSpec } from "@claude-ball/brain-api";

const here = dirname(fileURLToPath(import.meta.url));

/** Bundle the worker once (esbuild inlines @claude-ball/engine → plain CJS we can eval). */
let workerCode: Promise<string> | null = null;
function getWorkerCode(): Promise<string> {
  if (!workerCode) {
    workerCode = esbuild
      .build({
        entryPoints: [`${here}/worker-entry.ts`],
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
      })
      .then((r) => r.outputFiles[0]!.text);
  }
  return workerCode;
}

/**
 * Bundle a brain's source (TS) into a single self-contained IIFE that assigns
 * the module's exports to `__brain`. Resolves `@claude-ball/brain-api` from the monorepo.
 * Throwing here means the brain doesn't compile.
 */
const bundleCache = new Map<string, Promise<string>>();

export async function bundleBrain(source: string): Promise<string> {
  const cached = bundleCache.get(source);
  if (cached) return cached;
  const p = esbuild
    .build({
      stdin: { contents: source, loader: "ts", resolveDir: here },
      bundle: true,
      format: "iife",
      globalName: "__brain",
      platform: "neutral",
      write: false,
    })
    .then((r) => r.outputFiles[0]!.text);
  bundleCache.set(source, p);
  // Don't cache failures.
  p.catch(() => bundleCache.delete(source));
  return p;
}

export interface SandboxOptions extends RunOptions {
  /** Hard wall-clock cap for the whole match (ms); on overrun the match is killed. */
  timeoutMs?: number;
}

export interface SandboxResult {
  ok: boolean;
  result?: MatchResult;
  /** Why a match failed: bad code, killed for time, or a runtime crash. */
  fault?: { kind: "compile" | "timeout" | "crash"; side?: "home" | "away"; message: string };
}

/**
 * Run a deterministic match between two UNTRUSTED brains given only their
 * source. Each runs sandboxed; the whole match is hard-killed past `timeoutMs`.
 */
export async function runSandboxedMatch(
  homeSource: string,
  awaySource: string,
  opts: SandboxOptions = {},
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;

  let homeBundle: string;
  let awayBundle: string;
  try {
    homeBundle = await bundleBrain(homeSource);
  } catch (err) {
    return { ok: false, fault: { kind: "compile", side: "home", message: String(err) } };
  }
  try {
    awayBundle = await bundleBrain(awaySource);
  } catch (err) {
    return { ok: false, fault: { kind: "compile", side: "away", message: String(err) } };
  }

  const code = await getWorkerCode();
  const { seed, ticks, homeParams, awayParams, brainBudgetMs } = opts;

  return new Promise<SandboxResult>((resolve) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { homeBundle, awayBundle, opts: { seed, ticks, homeParams, awayParams, brainBudgetMs } },
    });
    let done = false;
    const finish = (r: SandboxResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, fault: { kind: "timeout", message: `match exceeded ${timeoutMs}ms` } }),
      timeoutMs,
    );
    worker.on("message", (msg: { ok: boolean; result?: MatchResult; error?: string }) => {
      if (msg.ok) finish({ ok: true, result: msg.result });
      else finish({ ok: false, fault: { kind: "crash", message: msg.error ?? "unknown error" } });
    });
    worker.on("error", (err) => finish({ ok: false, fault: { kind: "crash", message: String(err) } }));
  });
}

/** Keep only well-formed knob specs; clamp counts/lengths so a bot can't store junk. */
function sanitizeParams(raw: unknown): ParamsSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const out: ParamsSpec = {};
  let n = 0;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 24) break; // cap the number of knobs we surface
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    if (
      typeof s.default !== "number" || !Number.isFinite(s.default) ||
      typeof s.min !== "number" || !Number.isFinite(s.min) ||
      typeof s.max !== "number" || !Number.isFinite(s.max) ||
      typeof s.step !== "number" || !Number.isFinite(s.step) ||
      s.min >= s.max
    ) continue;
    out[key.slice(0, 40)] = {
      default: s.default, min: s.min, max: s.max, step: s.step,
      label: typeof s.label === "string" ? s.label.slice(0, 60) : undefined,
      help: typeof s.help === "string" ? s.help.slice(0, 200) : "",
    };
    n++;
  }
  return Object.keys(out).length ? out : null;
}

export interface BrainInfo {
  name: string | null;
  /** Sanitized knob spec, or null if the bot exposes none. */
  params: ParamsSpec | null;
}

/**
 * Load an UNTRUSTED brain in the sandbox and read its declared name + knob spec,
 * without running a match. Used at submit time so challenger knobs can be tuned
 * on the leaderboard without ever exposing the bot's source.
 */
export async function introspectBrain(
  source: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; info?: BrainInfo; fault?: { kind: "compile" | "timeout" | "crash"; message: string } }> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  let bundle: string;
  try {
    bundle = await bundleBrain(source);
  } catch (err) {
    return { ok: false, fault: { kind: "compile", message: String(err) } };
  }
  const code = await getWorkerCode();
  return new Promise((resolve) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { homeBundle: bundle, awayBundle: bundle, opts: { introspect: true } },
    });
    let done = false;
    const finish = (r: { ok: boolean; info?: BrainInfo; fault?: { kind: "compile" | "timeout" | "crash"; message: string } }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, fault: { kind: "timeout", message: `introspect exceeded ${timeoutMs}ms` } }),
      timeoutMs,
    );
    worker.on("message", (msg: { ok: boolean; brain?: { name: unknown; params: unknown }; error?: string }) => {
      if (msg.ok) {
        finish({
          ok: true,
          info: { name: typeof msg.brain?.name === "string" ? msg.brain.name : null, params: sanitizeParams(msg.brain?.params) },
        });
      } else {
        finish({ ok: false, fault: { kind: "crash", message: msg.error ?? "unknown error" } });
      }
    });
    worker.on("error", (err) => finish({ ok: false, fault: { kind: "crash", message: String(err) } }));
  });
}
