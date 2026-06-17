import type { Brain } from "@kr/brain-api";
import { chaser } from "./chaser.js";
import { formation } from "./formation.js";
import { flow } from "./flow.js";
import { blitz } from "./blitz.js";
import { possession } from "./possession.js";

export { chaser, formation, flow, blitz, possession };

export interface CatalogEntry {
  name: string;
  brain: Brain;
  /** Relative skill 0–100 from the round-robin tournament (see tournament.ts). */
  skill: number;
  /** One-line description of how the bot plays. */
  blurb: string;
}

/**
 * The library of built-in opponents. `skill` is computed by tournament.ts
 * (round-robin, points-based) and pasted back here; re-run it if a bot changes.
 */
export const catalog: CatalogEntry[] = [
  { name: "blitz", brain: blitz, skill: 92, blurb: "Keeper launches to a high striker; two pressers hunt." },
  { name: "chaser", brain: chaser, skill: 83, blurb: "Everyone chases the ball; whoever has it shoots." },
  { name: "formation", brain: formation, skill: 50, blurb: "Holds a 4-player shape; the nearest player presses." },
  { name: "flow", brain: flow, skill: 19, blurb: "Keeper, deep playmaker, two channel runners; passes forward." },
  { name: "possession", brain: possession, skill: 5, blurb: "Keeps the ball, works to the corners, rarely rushes." },
];

/** name → Brain lookup (used by the runner / coach server). */
export const brains: Record<string, Brain> = Object.fromEntries(
  catalog.map((e) => [e.name, e.brain]),
);
