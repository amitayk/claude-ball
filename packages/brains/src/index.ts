import type { Brain } from "@claude-ball/brain-api";
import { afk } from "./afk.js";
import { chaser } from "./chaser.js";
import { formation } from "./formation.js";
import { flow } from "./flow.js";
import { blitz } from "./blitz.js";
import { possession } from "./possession.js";
import { maestro } from "./maestro.js";

export { afk, chaser, formation, flow, blitz, possession, maestro };

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
  { name: "maestro", brain: maestro, skill: 86, blurb: "Total football: sweeper-keeper, one back presses, one man-marks goal-side; counters to a high striker and finishes into the open corner." },
  { name: "blitz", brain: blitz, skill: 80, blurb: "Keeper launches to a high striker; two pressers hunt." },
  { name: "chaser", brain: chaser, skill: 73, blurb: "Everyone chases the ball; whoever has it shoots." },
  { name: "formation", brain: formation, skill: 40, blurb: "Holds a 4-player shape; the nearest player presses." },
  { name: "flow", brain: flow, skill: 17, blurb: "Keeper, deep playmaker, two channel runners; passes forward." },
  { name: "possession", brain: possession, skill: 3, blurb: "Keeps the ball, works to the corners, rarely rushes." },
  { name: "afk-bot", brain: afk, skill: 0, blurb: "Does nothing — stands still and only plays the legal back pass on its own kickoff. A practice dummy." },
];

/** name → Brain lookup (used by the runner / coach server). */
export const brains: Record<string, Brain> = Object.fromEntries(
  catalog.map((e) => [e.name, e.brain]),
);
