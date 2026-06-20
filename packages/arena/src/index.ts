import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import type { MatchResult, RunOptions } from "@kr/engine";

const here = dirname(fileURLToPath(import.meta.url));

/** Bundle the worker once (esbuild inlines @kr/engine → plain CJS we can eval). */
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
 * the module's exports to `__brain`. Resolves `@kr/brain-api` from the monorepo.
 * Throwing here means the brain doesn't compile.
 */
export async function bundleBrain(source: string): Promise<string> {
  const r = await esbuild.build({
    stdin: { contents: source, loader: "ts", resolveDir: here },
    bundle: true,
    format: "iife",
    globalName: "__brain",
    platform: "neutral",
    write: false,
  });
  return r.outputFiles[0]!.text;
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
