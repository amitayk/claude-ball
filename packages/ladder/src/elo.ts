/** Standard Elo. Ratings are points; 400 = a 10× odds gap. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/** New rating for A after scoring `scoreA` (1 win / 0.5 draw / 0 loss) vs B. */
export function updateRating(ratingA: number, ratingB: number, scoreA: number, k: number): number {
  return ratingA + k * (scoreA - expectedScore(ratingA, ratingB));
}

/** Map a 0–100 library skill to a starting Elo (anchor) for the ladder. */
export function skillToElo(skill: number): number {
  return Math.round(1000 + skill * 9); // 0 → 1000, 100 → 1900
}
