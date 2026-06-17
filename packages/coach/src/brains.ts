import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brain } from "@kr/brain-api";
import { brains as builtins } from "@kr/brains";

let importCounter = 0;

/** Find the exported Brain in a module (default, `brain`, or first match). */
export function pickBrain(mod: Record<string, unknown>): Brain {
  const candidate =
    (mod.default as Brain | undefined) ??
    (mod.brain as Brain | undefined) ??
    (Object.values(mod).find(
      (v) => v && typeof (v as { decide?: unknown }).decide === "function",
    ) as Brain | undefined);
  if (!candidate || typeof candidate.decide !== "function") {
    throw new Error("module does not export a Brain (with a decide() method)");
  }
  return candidate;
}

/**
 * Import a brain from a file with a cache-busting query so edits hot-reload.
 * (tsx re-transpiles a new module URL each time.)
 */
export async function importBrainFile(absPath: string): Promise<Brain> {
  const url = pathToFileURL(absPath).href + `?v=${++importCounter}`;
  const mod = (await import(url)) as Record<string, unknown>;
  return pickBrain(mod);
}

/** Resolve an opponent by built-in name or by file path. */
export async function loadOpponent(ref: string, cwd: string): Promise<Brain> {
  if (builtins[ref]) return builtins[ref]!;
  const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
  return importBrainFile(abs);
}

/** Built-in brain names plus any other brain files in src/ (excluding self). */
export function listOpponents(cwd: string, selfPath: string): string[] {
  const names = Object.keys(builtins);
  const srcDir = resolve(cwd, "src");
  const files: string[] = [];
  if (existsSync(srcDir)) {
    for (const f of readdirSync(srcDir)) {
      if (f.endsWith(".ts") && resolve(srcDir, f) !== selfPath) files.push(`./src/${f}`);
    }
  }
  return [...names, ...files];
}
