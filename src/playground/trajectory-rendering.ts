export type TrajectoryGenerationWidthWeights = readonly number[];

export const DEFAULT_TRAJECTORY_GENERATION_WIDTH_WEIGHTS = [1, 0.9, 0.5, 0] as const;
const FIRST_HIDDEN_GENERATION = DEFAULT_TRAJECTORY_GENERATION_WIDTH_WEIGHTS.findIndex((weight) => weight <= 0) + 1;

export function normalizeTrajectoryGenerationWidthWeights(
  weights: TrajectoryGenerationWidthWeights,
): number[] {
  return DEFAULT_TRAJECTORY_GENERATION_WIDTH_WEIGHTS.map((fallback, i) => {
    const value = weights[i] ?? fallback;
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  });
}

export function trajectoryGenerationWidthWeight(
  generation: number,
  weights: TrajectoryGenerationWidthWeights = DEFAULT_TRAJECTORY_GENERATION_WIDTH_WEIGHTS,
): number {
  const index = Math.max(0, Math.floor(generation) - 1);
  const cappedIndex = Math.min(index, weights.length - 1);
  return weights[cappedIndex] ?? 1;
}

export function renderedGenerationLimitForSearchDepth(searchDepth: number): number {
  const searchedVisibleLimit = Math.max(1, Math.floor(searchDepth) - 1);
  const fixedVisibleLimit = FIRST_HIDDEN_GENERATION > 1 ? FIRST_HIDDEN_GENERATION - 1 : searchedVisibleLimit;
  return Math.min(searchedVisibleLimit, fixedVisibleLimit);
}
