import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brain } from "@kr/brain-api";
import { brains as builtins, catalog } from "@kr/brains";

let importCounter = 0;

/** Sentinel opponent: a mirror match against the coach's own current brain. */
export const SELF_OPPONENT = "yourself";

export interface OpponentInfo {
  name: string;
  /** 0–100 library skill, or null for the mirror option. */
  skill: number | null;
  blurb: string;
}

/** Find the exported Brain in a module (default, or first one with decide()). */
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
 * Import a brain from a file with a cache-busting query so edits hot-reload —
 * and so two imports of the same file yield independent module instances (used
 * for mirror matches, so a stateful brain's two sides don't share state).
 */
export async function importBrainFile(absPath: string): Promise<Brain> {
  const url = pathToFileURL(absPath).href + `?v=${++importCounter}`;
  const mod = (await import(url)) as Record<string, unknown>;
  return pickBrain(mod);
}

/** Resolve a library opponent by name, or a brain file by path. */
export async function loadOpponent(ref: string, cwd: string): Promise<Brain> {
  if (builtins[ref]) return builtins[ref]!;
  const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
  return importBrainFile(abs);
}

/** Library opponents (with skill + blurb) plus the mirror option. */
export function listOpponents(): OpponentInfo[] {
  const lib = catalog.map((e) => ({ name: e.name, skill: e.skill, blurb: e.blurb }));
  return [...lib, { name: SELF_OPPONENT, skill: null, blurb: "A mirror match against your own current brain." }];
}
