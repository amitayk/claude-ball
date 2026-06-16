import type { Brain } from "@kr/brain-api";
import { chaser } from "./chaser.js";
import { formation } from "./formation.js";

/** Registry of built-in sample brains, looked up by name in the runner. */
export const brains: Record<string, Brain> = {
  chaser,
  formation,
};

export { chaser, formation };
