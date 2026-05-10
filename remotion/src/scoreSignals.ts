// Score "warmth" + "kick" signal computation for HUD pulse animations,
// plus the water "danger" signal that drives band tinting.
//
// Score model — two-channel, picked after analyzing the seed4200 sidecar:
//   warmth — leaky integrator over Δscore. Smooth "is something happening"
//            level that decays back to 0 with time-constant τ_WARMTH_SEC.
//            Drives glow + color + tiny scale on the score readout.
//   kick   — sharp envelope on Δscore ≥ KICK_THRESHOLD (the bimodal upper
//            tail). Quadratic decay over KICK_DECAY_SEC. Drives an extra
//            glow + scale + brightness pop on real "events".
//
// Water model — single-channel, blob-relative:
//   danger — 1st-order low-pass over dangerRaw, where
//              dangerRaw = clamp(1 − max(0, dist_m) / DANGER_FAR_M, 0, 1)
//              dist_m   = (waterY − blob.y) / PX_PER_METER
//            (positive dist_m = blob above water; ≤0 = drowning).
//            Smoothed with τ_WATER_DANGER_SEC to absorb the fast oscillation
//            during big falls. Drives a red tint on the top + bottom bands.

import { useMemo } from 'react';
import { SidecarRow } from './sidecar';

export const TAU_WARMTH_SEC = 0.3;
export const WARMTH_NORM = 100;
export const KICK_THRESHOLD = 100;
export const KICK_DECAY_SEC = 0.25;

export const PX_PER_METER = 5;
// Water enters the "danger" range starting this far below the blob. The
// raw signal uses a quadratic ease-in so the response stays subtle across
// the wider range and only intensifies as water gets genuinely close —
// "red even at distance, not red all the time".
export const DANGER_FAR_M = 40;
// Asymmetric leaky integrator on the danger signal: fast attack so the
// visual reacts immediately when water closes in, slow decay so the red
// "lingers" after a near-miss (water moving away still leaves residual
// tint for a moment, like a fading alarm). Symmetric LP averaged the two
// and felt sluggish on attack and abrupt on relaxation.
export const TAU_WATER_ATTACK_SEC = 0.2;
export const TAU_WATER_DECAY_SEC = 0.8;

export type ScoreSignals = {
  warmth: number[];        // raw integrator value, frame-indexed
  kickElapsed: number[];   // seconds since last Δ ≥ KICK_THRESHOLD
};

function computeLeaky(deltas: number[], tauSec: number, fps: number): number[] {
  const alpha = 1 - Math.exp(-1 / (tauSec * fps));
  const out = new Array<number>(deltas.length);
  let x = 0;
  for (let i = 0; i < deltas.length; i++) {
    x = (1 - alpha) * x + alpha * deltas[i];
    out[i] = x;
  }
  return out;
}

export function buildScoreSignals(
  sidecar: SidecarRow[],
  fps: number,
): ScoreSignals {
  const n = sidecar.length;
  const deltas = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) deltas[i] = sidecar[i].score - sidecar[i - 1].score;

  const warmth = computeLeaky(deltas, TAU_WARMTH_SEC, fps);

  const kickElapsed = new Array<number>(n);
  let lastBigFrame = -10000;
  for (let i = 0; i < n; i++) {
    if (deltas[i] >= KICK_THRESHOLD) lastBigFrame = i;
    kickElapsed[i] = (i - lastBigFrame) / fps;
  }
  return { warmth, kickElapsed };
}

// Quadratic-decay impulse envelope: 1 at t=0, 0 at t=durationSec.
export function pulseDecay(elapsedSec: number, durationSec: number): number {
  if (elapsedSec >= durationSec || elapsedSec < 0) return 0;
  const t = elapsedSec / durationSec;
  return (1 - t) ** 2;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export type ScorePulseState = {
  warmth: number;   // normalized [0, 1]
  kickEnv: number;  // [0, 1]
};

// Memoized hook: precompute signals once per sidecar identity, return the
// per-frame pulse state. Returns zeros when no sidecar is loaded.
export function useScorePulseState(
  sidecar: SidecarRow[] | null,
  frame: number,
  fps: number,
): ScorePulseState {
  const signals = useMemo(
    () => (sidecar ? buildScoreSignals(sidecar, fps) : null),
    [sidecar, fps],
  );
  if (!signals || !sidecar || sidecar.length === 0) {
    return { warmth: 0, kickEnv: 0 };
  }
  const idx = Math.min(Math.max(0, frame), sidecar.length - 1);
  return {
    warmth: clamp01(signals.warmth[idx] / WARMTH_NORM),
    kickEnv: pulseDecay(signals.kickElapsed[idx], KICK_DECAY_SEC),
  };
}

// Water danger: precompute the LP-filtered danger curve once per sidecar.
// Same leaky-integrator math as score warmth, but the input is already a
// continuous [0,1] signal (dangerRaw), so the filter just smooths it.
export function buildWaterDanger(sidecar: SidecarRow[], fps: number): number[] {
  const n = sidecar.length;
  const alphaAttack = 1 - Math.exp(-1 / (TAU_WATER_ATTACK_SEC * fps));
  const alphaDecay = 1 - Math.exp(-1 / (TAU_WATER_DECAY_SEC * fps));
  const out = new Array<number>(n);
  let x = 0;
  for (let i = 0; i < n; i++) {
    const distM = (sidecar[i].waterY - sidecar[i].blob.y) / PX_PER_METER;
    const t = clamp01(1 - Math.max(0, distM) / DANGER_FAR_M);
    const raw = t * t; // quadratic ease-in: subtle at distance, sharp near 0
    const alpha = raw > x ? alphaAttack : alphaDecay;
    x = (1 - alpha) * x + alpha * raw;
    out[i] = x;
  }
  return out;
}

export function useWaterDanger(
  sidecar: SidecarRow[] | null,
  frame: number,
  fps: number,
): number {
  const arr = useMemo(
    () => (sidecar ? buildWaterDanger(sidecar, fps) : null),
    [sidecar, fps],
  );
  if (!arr || !sidecar || sidecar.length === 0) return 0;
  const idx = Math.min(Math.max(0, frame), sidecar.length - 1);
  return clamp01(arr[idx]);
}
