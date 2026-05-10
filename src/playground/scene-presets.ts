// Shared scene-preset definitions. Both the playground UI (ai-interwheel.ts)
// and headless tooling (scripts/interwheel/probe-pure.mts) import from here,
// so a one-click preset and a node-side probe configure the simulator from the
// same source of truth.

import {
  setGenerationDifficultyOverride,
  setInitialWaterMarginPxOverride,
  setMineDifficultyOverride,
  setPastilleSpawnChanceOverride,
  setRampSpeedOverride,
  setWaterSpeedMultiplierOverride,
} from '../games/interwheel/sim';
import { DEFAULT_PLANNER_POLICY, type PlannerPolicy } from './interwheel-planner';

export const PX_PER_METER = 5;

// Focus is a derived "Climb ⇄ Pastille" blend that lerps both knobs in
// opposite directions: focus=0 emphasizes climb (climb=1.5, pastille=0),
// focus=1 emphasizes pastille capture (climb=0.5, pastille=1).
export const FOCUS_CLIMB_MAX = 1.5;
export const FOCUS_CLIMB_MIN = 0.5;
export const FOCUS_PASTILLE_MAX = 1.0;

export type ScenePreset = {
  waterMargin: { meters: number; natural: boolean };
  waterSpeed: { min: number; max: number; natural: boolean };
  difficulty: { min: number; max: number; natural: boolean };
  mineDensity: { min: number; max: number; natural: boolean };
  pastilleSpawn: { min: number; max: number; natural: boolean };
  rampSpeed: number;
  // Optional planner-policy / overlay knobs. When present, the playground
  // applyScenePreset() also writes these so a one-click preset configures the
  // AI's intent and the candidate-line look together with the world params.
  focus?: number;       // 0..1; drives climb/pastille via policyFromFocus
  widthMin?: number;    // overlay base line width
  alphaMin?: number;    // overlay alpha floor
  alphaGamma?: number;  // overlay alpha curve exponent
  // Optional planner-experiment knobs. Captured presets pin these so probe
  // and render get identical search results regardless of CPU load.
  lookaheadScreens?: number;
  searchLimits?: {
    maxEdgeRollouts?: number;
    budgetMs?: number;        // Number.POSITIVE_INFINITY = wall-clock disabled
    maxStableDepth?: number;
  };
};

export type ScenePresetName = 'natural' | 'video';

export const SCENE_PRESETS: Record<ScenePresetName, ScenePreset> = {
  natural: {
    waterMargin: { meters: 60, natural: true },
    waterSpeed: { min: 1.0, max: 1.0, natural: true },
    difficulty: { min: 0.30, max: 0.30, natural: true },
    mineDensity: { min: 0.30, max: 0.30, natural: true },
    pastilleSpawn: { min: 1.0, max: 1.0, natural: true },
    rampSpeed: 1.0,
  },
  video: {
    waterMargin: { meters: 20, natural: false },
    waterSpeed: { min: 3.8, max: 4.6, natural: false },
    difficulty: { min: 0.2, max: 0.4, natural: false },
    mineDensity: { min: 0.3, max: 0.6, natural: false },
    pastilleSpawn: { min: 0.5, max: 0.8, natural: false },
    rampSpeed: 1.0,
    focus: 0.6,        // climb=0.90, pastille=0.60
    widthMin: 0.45,
    alphaMin: 0.06,
    alphaGamma: 3.0,
    // Video-mode planner: pure perception (no lookahead above viewport),
    // pure step-budget A* (no wall-clock cap) so probe and render get the
    // same search results, deeper edge cap so 3-jump search isn't truncated.
    lookaheadScreens: 0,
    searchLimits: {
      maxEdgeRollouts: 500,
      budgetMs: Number.POSITIVE_INFINITY,
      maxStableDepth: 3,
    },
  },
};

export function policyFromFocus(
  focus: number,
  base: PlannerPolicy = DEFAULT_PLANNER_POLICY,
): PlannerPolicy {
  const f = Math.max(0, Math.min(1, focus));
  return {
    ...base,
    climb: FOCUS_CLIMB_MAX - (FOCUS_CLIMB_MAX - FOCUS_CLIMB_MIN) * f,
    pastille: FOCUS_PASTILLE_MAX * f,
  };
}

// Headless equivalent of clicking a scene-preset button — writes the world
// overrides into the sim module's globals. The next sim.reset() picks them up.
// Does NOT touch overlay or planner state (that's the caller's job).
export function applyScenePresetToSim(preset: ScenePreset): void {
  setInitialWaterMarginPxOverride(
    preset.waterMargin.natural ? null : preset.waterMargin.meters * PX_PER_METER,
  );
  setWaterSpeedMultiplierOverride(
    preset.waterSpeed.natural ? null : { min: preset.waterSpeed.min, max: preset.waterSpeed.max },
  );
  setGenerationDifficultyOverride(
    preset.difficulty.natural ? null : { min: preset.difficulty.min, max: preset.difficulty.max },
  );
  setMineDifficultyOverride(
    preset.mineDensity.natural ? null : { min: preset.mineDensity.min, max: preset.mineDensity.max },
  );
  setPastilleSpawnChanceOverride(
    preset.pastilleSpawn.natural ? null : { min: preset.pastilleSpawn.min, max: preset.pastilleSpawn.max },
  );
  const anyCurveActive = !preset.waterSpeed.natural
    || !preset.difficulty.natural
    || !preset.mineDensity.natural
    || !preset.pastilleSpawn.natural;
  setRampSpeedOverride(anyCurveActive ? preset.rampSpeed : null);
}
