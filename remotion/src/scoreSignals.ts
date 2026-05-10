// Score "warmth" + "kick" signal computation for HUD pulse animations.
//
// Two-channel model picked after analyzing the seed4200 sidecar:
//   - Score increments are nearly continuous (72% of frames; p50 gap = 1
//     frame), so per-event pulses average to nothing visually.
//   - Δscore distribution is bimodal: 0–20 (climbing micro-ticks) and
//     ≥100 (pastilles / finale spikes), with a clean empty band in
//     between.
//
//   warmth — leaky integrator over Δscore. Smooth "is something happening"
//            level that decays back to 0 with time-constant τ_WARMTH_SEC.
//            Drives glow + color + tiny scale on the score readout.
//   kick   — sharp envelope on Δscore ≥ KICK_THRESHOLD (the bimodal upper
//            tail). Quadratic decay over KICK_DECAY_SEC. Drives an extra
//            glow + scale + brightness pop on real "events".
//
// Constants picked from the L5 lab variant (validated as "pretty much
// perfect" on the dashboard).

import { useMemo } from 'react';
import { SidecarRow } from './sidecar';

export const TAU_WARMTH_SEC = 0.3;
export const WARMTH_NORM = 100;
export const KICK_THRESHOLD = 100;
export const KICK_DECAY_SEC = 0.25;

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
